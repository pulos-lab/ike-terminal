import Papa from 'papaparse';
import { z } from 'zod';
import { ImportProfileSchema, validateImportProfile, type ImportProfile } from 'shared';
import { parseWithProfile, type GenericParseOutput } from '../parsers/generic/engine.js';
import { GenericParseError } from '../parsers/generic/value-parsers.js';
import { computeFingerprint, locateHeaderCandidate } from '../parsers/generic/fingerprint.js';
import { redactFileName, redactSampleRows } from './sample-redactor.js';
import { chatComplete, LlmRequestError } from './llm-client.js';
import {
  buildRetryFeedback,
  buildSystemPrompt,
  buildUserPrompt,
} from './profile-generator-prompt.js';
import { createConcurrencyLimiter } from './concurrency.js';

/**
 * Generator profili importu przez LLM — serce Fazy 4.
 *
 * Pętla (max 3 próby = 1 + 2 retry z feedbackiem błędów):
 *   1. prompt (nagłówki + ZREDAGOWANA próbka + digesty) → LLM → JSON,
 *   2. JSON.parse → walidacja zod (ImportProfileSchema),
 *   3. SELF-CHECK: parseWithProfile na pierwszych ~300 liniach REALNEGO pliku
 *      (lokalnie — pełny plik nigdy nie opuszcza serwera); confidence =
 *      wiersze wyemitowane / (wyemitowane + pominięte z powodów "problemowych").
 *      Pominięcia łagodne (podsumowania, rozliczenia techniczne, kwoty zerowe)
 *      nie obniżają oceny.
 * Confidence < MIN_CONFIDENCE po wszystkich próbach → null (UI przechodzi na
 * ręczny edytor — wiarygodnie wyglądające złe mapowanie jest gorsze niż brak).
 *
 * Współbieżność: limiter=1 (jedno żądanie LLM naraz) + dedup in-flight per
 * fingerprint (dwóch użytkowników z tym samym nowym formatem = jedna generacja).
 */

const MAX_ATTEMPTS = 3;
const MIN_CONFIDENCE = 0.8;
/** Self-check na prefiksie pliku — wystarcza do oceny mapowania, ogranicza koszt. */
const SELF_CHECK_LINES = 300;
const SAMPLE_ROWS = 20;

/**
 * Kody walut uznawane za wiarygodne w self-checku. Lista celowo szeroka —
 * fałszywy alarm na egzotycznej walucie obniży confidence i wymusi retry,
 * ale nie przepuści profilu wpisującego w walutę fragmenty tickerów.
 */
const KNOWN_CURRENCIES = new Set([
  'PLN',
  'USD',
  'EUR',
  'GBP',
  'GBX',
  'CHF',
  'CZK',
  'HUF',
  'SEK',
  'NOK',
  'DKK',
  'CAD',
  'AUD',
  'NZD',
  'JPY',
  'HKD',
  'SGD',
  'CNY',
  'CNH',
  'TRY',
  'ILS',
  'MXN',
  'BRL',
  'ZAR',
  'RON',
  'BGN',
  'UAH',
  'ISK',
  'KRW',
  'TWD',
  'INR',
  'THB',
  'MYR',
  'IDR',
  'PHP',
  'AED',
  'SAR',
]);

/** Powody pominięcia wskazujące na ZŁE mapowanie (obniżają confidence). */
const PROBLEMATIC_SKIP_REASONS = new Set([
  'missing_date',
  'invalid_date',
  'missing_isin',
  'missing_name',
  'invalid_side',
  'invalid_quantity',
  'invalid_price',
  'value_mismatch',
  'unknown_operation_type',
]);

export interface GeneratedProfile {
  profile: ImportProfile;
  confidence: number;
  model: string;
  attempts: number;
  fingerprint: string;
  headers: string[];
  delimiter: string;
  /** Zredagowana próbka użyta w prompcie — do zapisania z profilem (review admina). */
  redactedSample: string[][];
}

const llmMutex = createConcurrencyLimiter(1);
const inFlight = new Map<string, Promise<GeneratedProfile | null>>();

/** Diagnostyka per próba (LLM_DEBUG=1) — powody odrzucenia trafiają na stderr. */
function debugLog(message: string): void {
  if (process.env.LLM_DEBUG) console.error(`  [llm-debug] ${message}`);
}

/**
 * Generuje profil dla treści pliku CSV. Zwraca null, gdy po wszystkich próbach
 * nie powstał profil o wystarczającej pewności. Rzuca LlmUnavailableError,
 * gdy LLM jest wyłączony/niedostępny (route → 503, UI → ścieżka ręczna).
 */
export async function generateProfileFromContent(
  content: string,
  fileName?: string,
): Promise<GeneratedProfile | null> {
  const candidate = locateHeaderCandidate(content);
  if (!candidate) {
    throw new GenericParseError(
      'Nie udało się znaleźć wiersza nagłówka w pliku — to nie wygląda na tabelaryczny CSV.',
    );
  }
  const fingerprint = computeFingerprint(candidate.headers, candidate.delimiter);

  // Dedup in-flight: ta sama generacja nie biegnie dwa razy równolegle.
  const existing = inFlight.get(fingerprint);
  if (existing) return existing;

  const job = llmMutex(() => runGeneration(content, fingerprint, candidate, fileName)).finally(
    () => {
      inFlight.delete(fingerprint);
    },
  );
  inFlight.set(fingerprint, job);
  return job;
}

async function runGeneration(
  content: string,
  fingerprint: string,
  candidate: NonNullable<ReturnType<typeof locateHeaderCandidate>>,
  fileName?: string,
): Promise<GeneratedProfile | null> {
  const redactedSample = redactSampleRows(
    candidate.headers,
    candidate.sampleRows.slice(0, SAMPLE_ROWS),
  );

  const systemPrompt = buildSystemPrompt();
  const baseUserPrompt = buildUserPrompt({
    headers: candidate.headers,
    delimiter: candidate.delimiter,
    headerRowIndex: candidate.headerRowIndex,
    sampleRows: redactedSample,
    digestRows: collectDigestRows(content, candidate),
    fileName: fileName ? redactFileName(fileName) : undefined,
  });

  let jsonSchema: Record<string, unknown> | undefined;
  try {
    jsonSchema = z.toJSONSchema(ImportProfileSchema, { io: 'input' }) as Record<string, unknown>;
  } catch {
    // Schemat nieserializowalny → polegamy na json_object + walidacji zod.
    jsonSchema = undefined;
  }

  // Self-check na prefiksie realnego pliku (lokalnie).
  const selfCheckContent = content.split('\n').slice(0, SELF_CHECK_LINES).join('\n');

  const primary = await runAttempts(undefined);
  if (primary) return primary;

  // Drabinka modeli: po odmowie podstawowego modelu jedna runda mocniejszym
  // (env LLM_MODEL_FALLBACK) — użycie sporadyczne, koszt pomijalny.
  const fallbackModel = process.env.LLM_MODEL_FALLBACK?.trim();
  if (fallbackModel) {
    debugLog(`model podstawowy odmówił — fallback na ${fallbackModel}`);
    return runAttempts(fallbackModel);
  }
  return null;

  async function runAttempts(model: string | undefined): Promise<GeneratedProfile | null> {
    let feedback = '';
    let lastModel = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let raw: string;
      try {
        const result = await chatComplete({
          system: systemPrompt,
          user: baseUserPrompt + feedback,
          jsonSchema,
          model,
        });
        raw = result.content;
        lastModel = result.model;
      } catch (err) {
        // Błąd żądania (np. 429/5xx) — jedna próba więcej ma sens; inne błędy w górę.
        if (err instanceof LlmRequestError && attempt < MAX_ATTEMPTS) {
          debugLog(`próba ${attempt}: LlmRequestError (HTTP ${err.status}) — ${err.message}`);
          feedback = '';
          continue;
        }
        throw err;
      }

      // 1. JSON parse (modele potrafią opakować w ```json mimo instrukcji).
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFence(raw));
      } catch (err) {
        debugLog(`próba ${attempt}: niepoprawny JSON — ${(err as Error).message}`);
        feedback = buildRetryFeedback([
          `Response was not valid JSON: ${(err as Error).message}. Return ONLY the JSON object.`,
        ]);
        continue;
      }

      // 2. Walidacja schematem (komunikaty wracają do modelu jako feedback).
      const validation = validateImportProfile(sanitizeGeneratedProfile(parsed));
      if (!validation.ok) {
        debugLog(
          `próba ${attempt}: schemat odrzucił — ${validation.errors.slice(0, 4).join(' | ')}`,
        );
        feedback = buildRetryFeedback(withEnglishHints(validation.errors));
        continue;
      }

      // 3. Self-check na realnym pliku.
      const check = selfCheck(selfCheckContent, validation.profile);
      if (!check.ok) {
        debugLog(`próba ${attempt}: self-check nie wykonał profilu — ${check.errors.join(' | ')}`);
        feedback = buildRetryFeedback(withEnglishHints(check.errors));
        continue;
      }
      if (check.confidence < MIN_CONFIDENCE) {
        debugLog(
          `próba ${attempt}: niski confidence ${check.confidence} ` +
            `(emitted ${check.emitted}, problematic ${check.problematic}; ${check.topReasons.join(', ')})`,
        );
        const examples = collectUnmatchedExamples(
          selfCheckContent,
          validation.profile,
          check.problematicRowNumbers,
          candidate.headers,
        );
        feedback = buildRetryFeedback([
          ...(examples.length > 0
            ? [
                `These data rows were NOT handled cleanly (redacted examples) — extend the classify rules ` +
                  `and mappings to cover each of them (or add an explicit skip rule when a row is genuinely ` +
                  `not a portfolio event):\n${examples.map((e) => `  ${e}`).join('\n')}`,
              ]
            : []),
          `Profile parsed only ${(check.confidence * 100).toFixed(0)}% of data rows cleanly ` +
            `(emitted ${check.emitted}, problematic skips ${check.problematic}). ` +
            `Top skip reasons: ${check.topReasons.join(', ') || 'n/a'}. ` +
            `Re-examine column mappings (date format, quantity/price/value columns, side values, classify rules).`,
        ]);
        continue;
      }

      return {
        profile: validation.profile,
        confidence: check.confidence,
        model: lastModel,
        attempts: attempt,
        fingerprint,
        headers: candidate.headers,
        delimiter: candidate.delimiter,
        redactedSample,
      };
    }

    return null;
  }
}

interface SelfCheckResult {
  ok: boolean;
  errors: string[];
  confidence: number;
  emitted: number;
  problematic: number;
  topReasons: string[];
  /** Numery wierszy (1-based, konwencja silnika) problematycznych pominięć — do przykładów w feedbacku. */
  problematicRowNumbers: number[];
}

/**
 * Zredagowane przykłady wierszy, których profil nie objął — do feedbacku
 * retry. Parsowanie identyczne jak w silniku (delimiter Z PROFILU, te same
 * indeksy wierszy), redakcja jak próbka. Konkretne przykłady pozwalają
 * modelowi załatać dziury w regułach zamiast zgadywać ze statystyki.
 */
function collectUnmatchedExamples(
  content: string,
  profile: ImportProfile,
  rowNumbers: number[],
  headers: string[],
  limit = 12,
): string[] {
  if (rowNumbers.length === 0) return [];
  const parsed = Papa.parse<string[]>(content, {
    delimiter: profile.file.delimiter,
    header: false,
    skipEmptyLines: true,
  });
  const rows = parsed.data;
  const picked = rowNumbers
    .slice(0, limit)
    .map((n) => rows[n - 1]) // rowNum jest 1-based względem sparsowanych wierszy
    .filter((r): r is string[] => Array.isArray(r))
    .map((r) => r.map((c) => String(c ?? '')));
  return redactSampleRows(headers, picked).map((r) => r.join(profile.file.delimiter).slice(0, 240));
}

/** Deterministyczna ocena profilu: wykonaj go na prefiksie pliku i policz jakość. */
export function selfCheck(content: string, profile: ImportProfile): SelfCheckResult {
  let output: GenericParseOutput;
  try {
    output = parseWithProfile(content, profile, 'self-check');
  } catch (err) {
    if (err instanceof GenericParseError) {
      return {
        ok: false,
        errors: [`Profile failed to execute: ${err.message}`],
        confidence: 0,
        emitted: 0,
        problematic: 0,
        topReasons: [],
        problematicRowNumbers: [],
      };
    }
    throw err;
  }

  const emitted = output.transactions.data.length + output.operations.data.length;
  const allSkipped = [...output.transactions.skipped, ...output.operations.skipped];
  const problematicSkips = allSkipped.filter((s) => PROBLEMATIC_SKIP_REASONS.has(s.reason));
  const problematicRowNumbers = [...new Set(problematicSkips.map((s) => s.row))];

  // Sanity-check walut WYEMITOWANYCH rekordów: profil potrafi przejść walidację
  // i cross-check kwot, a mimo to wpisywać w walutę śmieci z regexa (realny
  // przypadek z dry-runu: "IMI"/"SAC" z końcówek tickerów). Nieznany kod
  // waluty = pominięcie problemowe — obniża confidence jak złe mapowanie.
  const suspiciousCurrency = [
    ...output.transactions.data.map((t) => t.currency),
    ...output.operations.data.map((o) => o.currency),
  ].filter((c) => c && !KNOWN_CURRENCIES.has(c.toUpperCase())).length;

  const problematic = problematicSkips.length + suspiciousCurrency;
  const reasons = topSkipReasons(problematicSkips);
  if (suspiciousCurrency > 0) {
    reasons.unshift(`suspicious_currency×${suspiciousCurrency} (unknown ISO currency codes)`);
  }

  if (emitted === 0) {
    return {
      ok: false,
      errors: [
        'Profile emitted ZERO transactions and ZERO cash operations from the sample file. ' +
          'The classify rules or column mappings do not match the data.',
      ],
      confidence: 0,
      emitted,
      problematic,
      topReasons: reasons,
      problematicRowNumbers,
    };
  }

  const confidence = emitted / (emitted + problematic);
  return {
    ok: true,
    errors: [],
    confidence: Math.round(confidence * 1000) / 1000,
    emitted,
    problematic,
    topReasons: reasons,
    problematicRowNumbers,
  };
}

function topSkipReasons(skipped: Array<{ reason: string }>): string[] {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, n]) => `${reason}×${n}`);
}

/** Limit wierszy do digestów wartości — pokrywa pełne historie, ogranicza CPU. */
const DIGEST_ROWS_CAP = 8000;

/**
 * Wiersze do digestów wartości per kolumna: CAŁY plik (capped), po tej samej
 * redakcji co próbka. Rzadkie typy wierszy (np. zapis na akcje w IPO) zwykle
 * nie trafiają do 20-wierszowej próbki — digest z pełnego pliku daje modelowi
 * kompletną listę wartości kolumn-dyskryminatorów, więc reguły classify
 * powstają także dla typów spoza próbki. Do API nie wychodzi nic ponad
 * zredagowane, krótkie listy unikalnych wartości.
 */
function collectDigestRows(
  content: string,
  candidate: NonNullable<ReturnType<typeof locateHeaderCandidate>>,
): string[][] {
  const parsed = Papa.parse<string[]>(content.trim(), {
    delimiter: candidate.delimiter,
    header: false,
    skipEmptyLines: true,
    preview: candidate.headerRowIndex + 1 + DIGEST_ROWS_CAP,
  });
  const rows = parsed.data
    .slice(candidate.headerRowIndex + 1)
    .map((r) => r.map((c) => String(c ?? '')));
  return redactSampleRows(candidate.headers, rows);
}

/** Czy węzeł to „goły" matcher (ma `op`), a nie warunek (tablica matcherów). */
function looksLikeBareMatcher(node: unknown): boolean {
  return !!node && typeof node === 'object' && !Array.isArray(node) && 'op' in (node as object);
}

/**
 * Sanityzacja typowych, mechanicznych potknięć modeli PRZED walidacją zod.
 * Reguły: (1) format daty przycinany do części datowej ("DD.MM.YYYY HH:mm:ss"
 * → "DD.MM.YYYY") — silnik i tak toleruje sufiks czasu w komórce, a modele
 * uparcie odwzorowują czas widoczny w danych; (2) sygnatura scanu nagłówka
 * przycinana do limitu 6 pozycji — modele przepisują cały nagłówek, a do
 * identyfikacji wiersza wystarczy prefiks; (3) `skipRows` to tablica WARUNKÓW
 * (każdy = tablica matcherów: Matcher[][]), ale modele uparcie emitują jeden
 * poziom mniej — tablicę gołych matcherów `[{col,op}]` zamiast `[[{col,op}]]`;
 * owijamy każdy goły matcher w jednoelementowy warunek. Nic poza tym nie
 * poprawiamy: merytoryczne błędy mają wracać do modelu jako feedback.
 */
export function sanitizeGeneratedProfile(parsed: unknown): unknown {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.formats)) {
      obj.formats = obj.formats.map((f) =>
        typeof f === 'string' ? f.trim().split(/[\sT]+/)[0] : f,
      );
    }
    if (Array.isArray(obj.signature) && obj.signature.length > 6) {
      obj.signature = obj.signature.slice(0, 6);
    }
    // skipRows: goły matcher → owinięty w warunek (Matcher → [Matcher]).
    if (Array.isArray(obj.skipRows)) {
      obj.skipRows = obj.skipRows.map((cond) => (looksLikeBareMatcher(cond) ? [cond] : cond));
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(parsed);
  return parsed;
}

/**
 * Komunikaty walidacji schematu są po polsku (trafiają też do UI edytora
 * mapowania) — model dostaje feedback po angielsku, więc najczęstsze
 * odrzucenia tłumaczymy tu na konkretne instrukcje naprawy.
 */
const FEEDBACK_TRANSLATIONS: Array<{ match: RegExp; hint: (m: RegExpExecArray) => string }> = [
  {
    match: /nie ma źródła ISIN/,
    hint: () =>
      'The trade mapping has no ISIN source — either map the ISIN column, or (when the file has no ISIN column) set top-level "needsNameResolution": true.',
  },
  {
    match: /emituje '(\w+)', ale w profilu brakuje sekcji mapowania '(\w+)'/,
    hint: (m) =>
      `A classify rule emits "${m[1]}" but the profile has no "${m[2]}" mapping section — add that mapping section, or change the rule to emit a class you do map (or "skip").`,
  },
  {
    match: /brakuje kolumny "(.+?)"/,
    hint: (m) =>
      `The header contains NO column named ${JSON.stringify(m[1])} — you invented that name. ` +
      'Re-read the header list: the value most likely lives in an UNNAMED column; reference it by bare numeric index (e.g. {"kind":"column","col":8}).',
  },
];

/** Dołóż angielskie wskazówki naprawy do polskich komunikatów walidacji/self-checku. */
function withEnglishHints(errors: string[]): string[] {
  const hints = new Set<string>();
  for (const error of errors) {
    for (const { match, hint } of FEEDBACK_TRANSLATIONS) {
      const m = match.exec(error);
      if (m) hints.add(hint(m));
    }
  }
  return [...errors, ...hints];
}

/** Zdejmij ewentualny płotek ```json … ``` z odpowiedzi modelu. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence ? fence[1] : trimmed;
}
