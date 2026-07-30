/**
 * Resolver ratio dystrybucji spin-offu z oficjalnych filingów SEC (EDGAR).
 *
 * Strona-źródło discovery (stockanalysis) nie podaje ratio, a założenie 1:1
 * bywa błędne (IBM→KD 1:5, T→WBD ~0.24). Autorytatywnym źródłem są filingi:
 *  - 8-K RODZICA ogłaszający "distribution ratio",
 *  - 10-12B DZIECKA (registration statement / information statement) —
 * oba zawierają wprost zdania typu "one share of X common stock for every
 * four shares of Y common stock". Używamy oficjalnego, darmowego full-text
 * search EDGAR (efts.sec.gov) z wymaganym przez SEC nagłówkiem User-Agent
 * zawierającym kontakt (env SEC_CONTACT) i grzecznościową przerwą między
 * żądaniami.
 *
 * Zasada bez zgadywania: ratio wraca TYLKO gdy dopasowane zdania (z kontekstem
 * nazwy/tickera którejś ze spółek) dają dokładnie jedną wartość; konflikt lub
 * brak dopasowania → null (zdarzenie czeka, retry przy kolejnym refreshu).
 */

export interface SecRatioResolution {
  ratio: number;
  sourceUrl: string;
}

export interface SpinoffEventForResolution {
  parentTicker: string;
  parentName: string | null;
  childTicker: string;
  childName: string | null;
  exDate: string; // YYYY-MM-DD
}

const EDGAR_FTS_URL = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
/** Formularze z ratio: 8-K rodzica + 10-12B (i poprawki) dziecka. */
const EDGAR_FORMS = '8-K,10-12B,10-12B/A';
const FETCH_TIMEOUT_MS = 20_000;
/** Grzecznościowa przerwa między żądaniami do SEC (polityka fair access). */
const POLITENESS_DELAY_MS = 1_100;
/** Maks. liczba dokumentów czytanych per zdarzenie. */
const MAX_DOCS = 3;
/** Sanity: ratio poza tym zakresem = błąd parsowania, nie realna dystrybucja. */
const MIN_RATIO = 0.01;
const MAX_RATIO = 20;
/** Kontakt w User-Agent, gdy `SEC_CONTACT` nie jest ustawiony (patrz secUserAgent). */
const DEFAULT_SEC_CONTACT = 'IKE-Terminal-PortfolioManager admin@tixterminal.app';

/**
 * SEC wymaga identyfikacji z kontaktem: "Nazwa kontakt@domena", i EGZEKWUJE to
 * na `www.sec.gov/Archives` — zmierzone na tym samym dokumencie:
 * `…admin@localhost` → HTTP 403, `admin@tixterminal.app` → HTTP 200.
 * `efts.sec.gov` (samo wyszukiwanie) przepuszcza jedno i drugie, więc wcześniejszy
 * default z `localhost` dawał trafienia i dopiero pobranie filingu leciało w 403.
 * Adres bez `@` lub z domeną localhost jest odrzucany — lepiej wysłać działający
 * default niż nagłówek, który SEC odbije.
 */
function secUserAgent(): string {
  const configured = process.env.SEC_CONTACT?.trim();
  if (configured && configured.includes('@') && !/@\S*localhost/i.test(configured)) {
    return configured;
  }
  if (configured) {
    console.warn(
      `[sec-ratio] SEC_CONTACT="${configured}" nie wygląda na adres z domeną — SEC odbije takie ` +
        'żądanie (403). Używam domyślnego kontaktu.',
    );
  }
  return DEFAULT_SEC_CONTACT;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Czyste funkcje ekstrakcji (testowane na fragmentach realnych filingów) ──

const WORD_NUMBERS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  twelve: '12',
};

/** "one share ... for every four shares" → "1 share ... for every 4 shares". */
function normalizeWordNumbers(text: string): string {
  return text.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/gi,
    (w) => WORD_NUMBERS[w.toLowerCase()] ?? w,
  );
}

/** Zdejmuje tagi HTML i encje, zbija białe znaki — filingi to zwykle HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wzorce ratio z języka realnych filingów. UWAGA: nazwy spółek zawierają kropki
 * ("Mobility Global Inc.") — segmenty wzorca celowo dopuszczają kropki, ale są
 * ograniczone długością (0-80 znaków), żeby nie sklejać odległych fragmentów.
 *  - "1 share of X ... for every 4 shares of Y"        → 0.25
 *  - "distribution ratio of 1:4" / "ratio of 1-to-4"    → 0.25
 *  - "1 share ... for each share"                       → 1
 */
const RATIO_PATTERNS: RegExp[] = [
  /(\d+(?:\.\d+)?) shares? .{0,80}?for (?:every|each) (\d+(?:\.\d+)?)? ?shares?/g,
  /ratio of (\d+(?:\.\d+)?)\s*(?::|-?to-?|-?for-?)\s*(\d+(?:\.\d+)?)/g,
];

function ratioFromMatch(m: RegExpExecArray): number | null {
  const num = parseFloat(m[1]);
  const den = m[2] ? parseFloat(m[2]) : 1;
  if (!(num > 0) || !(den > 0)) return null;
  return num / den;
}

/**
 * Wyciąga ratio z pojedynczego zdania/fragmentu (po normalizacji liczb
 * słownych). Brak wzorca → null. Używane też przez extractRatioFromFiling
 * (tam na oknach wokół dopasowań globalnych).
 */
export function parseRatioFromSentence(sentence: string): number | null {
  const t = normalizeWordNumbers(sentence.toLowerCase()).replace(/\s+/g, ' ');
  for (const pattern of RATIO_PATTERNS) {
    const re = new RegExp(pattern.source); // bez flagi g — pierwsze dopasowanie
    const m = re.exec(t) as RegExpExecArray | null;
    if (m) {
      const ratio = ratioFromMatch(m);
      if (ratio !== null) return ratio;
    }
  }
  return null;
}

const NAME_STOPWORDS = new Set([
  'inc',
  'corp',
  'corporation',
  'company',
  'companies',
  'holdings',
  'holding',
  'group',
  'international',
  'global',
  'limited',
  'ltd',
  'plc',
  'the',
]);

/** Znaczące tokeny z nazwy spółki (np. "Mobility Global Inc" → ["mobility"]). */
function nameTokens(name: string | null): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .split(/[^a-z0-9&]+/)
    .filter((w) => w.length >= 4 && !NAME_STOPWORDS.has(w));
}

/** Okno kontekstu wokół dopasowania ratio (znaki w obie strony). */
const CONTEXT_WINDOW = 150;

/**
 * Skanuje treść filingu (HTML lub tekst) i zwraca ratio, jeśli JEDNOZNACZNE.
 * Zamiast naiwnego podziału na zdania (kropki w "Inc." rozrywałyby frazę)
 * dopasowania wzorców zbierane są globalnie, a kontekst — ticker lub znaczący
 * token nazwy rodzica/dziecka — sprawdzany w oknie ±150 znaków wokół
 * dopasowania (ochrona przed złapaniem ratio innej spółki/planu z tego samego
 * dokumentu). Różne wartości w kandydatach → null (nie zgadujemy).
 */
export function extractRatioFromFiling(
  content: string,
  event: Pick<
    SpinoffEventForResolution,
    'parentTicker' | 'parentName' | 'childTicker' | 'childName'
  >,
): number | null {
  // norm zachowuje wielkość liter (kontekst tickerów jest case-sensitive);
  // lower służy wyłącznie dopasowaniom wzorców — te same offsety znaków.
  const norm = normalizeWordNumbers(htmlToText(content));
  const lower = norm.toLowerCase();

  const tickers = [event.parentTicker, event.childTicker].filter((t) => t && t.length >= 2);
  const tokens = [...nameTokens(event.parentName), ...nameTokens(event.childName)];

  const hasContext = (windowText: string): boolean => {
    for (const t of tickers) {
      if (new RegExp(`\\b${t}\\b`).test(windowText)) return true; // case-sensitive ticker
    }
    const windowLower = windowText.toLowerCase();
    return tokens.some((tok) => windowLower.includes(tok));
  };

  const candidates: number[] = [];
  for (const pattern of RATIO_PATTERNS) {
    const re = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const ratio = ratioFromMatch(m);
      if (ratio === null || ratio < MIN_RATIO || ratio > MAX_RATIO) continue;
      const start = Math.max(0, m.index - CONTEXT_WINDOW);
      const end = Math.min(norm.length, m.index + m[0].length + CONTEXT_WINDOW);
      if (!hasContext(norm.slice(start, end))) continue;
      candidates.push(ratio);
    }
  }

  if (candidates.length === 0) return null;
  const first = candidates[0];
  const allEqual = candidates.every((r) => Math.abs(r / first - 1) < 1e-6);
  return allEqual ? first : null; // konflikt = niejednoznaczne, nie zgadujemy
}

// ── Przepływ sieciowy: EDGAR full-text search → dokument → ekstrakcja ───────

interface EdgarFtsHit {
  _id: string; // "0001104659-26-066592:tm2528763d9_ex99-1.htm"
  // UWAGA: EDGAR zwraca `ciks` (l. mnoga, TABLICA zero-paddowanych CIK-ów) —
  // fixture zapisany w testach pochodzi z realnej odpowiedzi. `cik` (l. poj.)
  // nigdy nie istniał; kod czytający to pole nie budował URL-a dla ŻADNEGO
  // trafienia, więc rezolwer nie przeczytał ani jednego filingu.
  _source?: { ciks?: string[]; cik?: string | string[] };
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/** Buduje URL dokumentu z hitu FTS: accession (bez myślników) + nazwa pliku. */
export function edgarDocUrlFromHit(hit: EdgarFtsHit): string | null {
  const [accession, filename] = hit._id.split(':');
  if (!accession || !filename) return null;
  const rawCik = hit._source?.ciks ?? hit._source?.cik;
  const cik = Array.isArray(rawCik) ? rawCik[0] : rawCik;
  if (!cik) return null;
  const cikNum = String(parseInt(cik, 10));
  const accessionFlat = accession.replace(/-/g, '');
  return `${EDGAR_ARCHIVES_BASE}/${cikNum}/${accessionFlat}/${filename}`;
}

/**
 * Rozwiązuje ratio spin-offu z SEC EDGAR. Zapytanie FTS: fraza "distribution
 * ratio" + najbardziej charakterystyczny identyfikator zdarzenia (nazwa dziecka,
 * fallback nazwa rodzica), formularze 8-K/10-12B, okno dat wokół ex-date
 * (ogłoszenia wyprzedzają dystrybucję o tygodnie). Czyta maks. MAX_DOCS
 * najlepszych trafień; pierwszy jednoznaczny wynik wygrywa.
 */
export async function resolveSpinoffRatioFromSec(
  event: SpinoffEventForResolution,
  fetchFn: typeof fetch = fetch,
): Promise<SecRatioResolution | null> {
  const anchor = event.childName ?? event.parentName ?? event.childTicker;
  const query = `"distribution ratio" "${anchor}"`;
  const params = new URLSearchParams({
    q: query,
    forms: EDGAR_FORMS,
    startdt: isoAddDays(event.exDate, -90),
    enddt: isoAddDays(event.exDate, 21),
  });

  let hits: EdgarFtsHit[];
  try {
    const resp = await fetchFn(`${EDGAR_FTS_URL}?${params.toString()}`, {
      headers: { 'User-Agent': secUserAgent() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`EDGAR FTS HTTP ${resp.status}`);
    const json = (await resp.json()) as { hits?: { hits?: EdgarFtsHit[] } };
    hits = json.hits?.hits ?? [];
  } catch (err) {
    console.warn(`[sec-ratio] FTS padł dla ${event.parentTicker}→${event.childTicker}:`, err);
    return null;
  }

  // Cichy `continue` przy każdym z tych kroków ukrywał awarię transportu jako
  // „SEC nie zna ratio" — stąd logi przy porażkach, których nie widać w wyniku.
  for (const hit of hits.slice(0, MAX_DOCS)) {
    const docUrl = edgarDocUrlFromHit(hit);
    if (!docUrl) {
      console.warn(`[sec-ratio] Nie umiem zbudować URL-a z trafienia FTS: ${hit._id}`);
      continue;
    }
    await sleep(POLITENESS_DELAY_MS);
    try {
      const resp = await fetchFn(docUrl, {
        headers: { 'User-Agent': secUserAgent() },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        console.warn(`[sec-ratio] HTTP ${resp.status} przy pobieraniu ${docUrl}`);
        continue;
      }
      const content = await resp.text();
      const ratio = extractRatioFromFiling(content, event);
      if (ratio !== null) {
        return { ratio, sourceUrl: docUrl };
      }
    } catch (err) {
      console.warn(`[sec-ratio] Dokument ${docUrl} nieczytelny:`, err);
    }
  }

  return null;
}
