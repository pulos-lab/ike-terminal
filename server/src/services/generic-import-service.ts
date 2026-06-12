/**
 * Serwis importu generycznego — lustro bulkImport dla ścieżki profili.
 *
 * Przepływ:
 * - analyze : detekcja wbudowana (known → zwykły /api/import/bulk) | fingerprint
 *             → profil z biblioteki / sugestie podobnych formatów / zredagowana próbka,
 * - preview : parseWithProfile bez ŻADNYCH zapisów — obowiązkowy krok przed commitem,
 * - commit  : atomowy import (te same inserty dedup co bulkImport → idempotencja),
 *             zapis batcha z gzipem oryginalnego pliku (re-import po korekcie profilu),
 *             post-tx rezolucja tickerów (istniejący pipeline isin-resolver),
 * - reimport: delete wierszy batcha → re-parse surowego pliku aktualnym profilem
 *             → insert — całość atomowo w obrębie bazy portfela.
 *
 * Zakres v1: jeden plik CSV per request (silnik emituje i transakcje, i operacje
 * z jednego pliku). XLSX pozostaje przy parserach wbudowanych (XTB).
 */
import { randomUUID } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import type { ImportResult, SkippedRow } from 'shared';
import {
  validateImportProfile,
  type GenericAnalyzeResult,
  type GenericBatchInfo,
  type GenericCommitResult,
  type GenericPreviewResult,
  type ImportProfile,
} from 'shared';
import { decodeCSVBuffer } from '../parsers/encoding.js';
import { parseWithProfile, type GenericParseOutput } from '../parsers/generic/engine.js';
import { GenericParseError } from '../parsers/generic/value-parsers.js';
import {
  computeFingerprint,
  jaccardSimilarity,
  locateHeaderCandidate,
} from '../parsers/generic/fingerprint.js';
import { classifyFile } from './import-service.js';
import { redactSampleRows } from './sample-redactor.js';
import { resolveUnknownIsins } from './isin-resolver.js';
import { generateProfileFromContent } from './profile-generator.js';
import {
  bumpProfileUsage,
  findActiveProfileByFingerprint,
  getProfileBatchWithRaw,
  getProfileById,
  insertPendingProfile,
  listActiveProfiles,
  listProfileBatches,
  recordProfileBatch,
  type ImportProfileRow,
} from '../db/import-profiles-repo.js';
import {
  insertTransactionsWithDedup,
  deleteTransactionsByBatch,
  detectOrphanedSells,
} from '../db/transactions-repo.js';
import { insertOperationsWithDedup, deleteOperationsByBatch } from '../db/operations-repo.js';
import { findIsinByName, seedTickerMap, upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import { getDb } from '../db/connection.js';

const SUGGESTION_THRESHOLD = 0.75;
const MAX_SUGGESTIONS = 3;
const SAMPLE_ROWS = 20;
/** Limit elementów w odpowiedzi preview (duże pliki → przycięte + truncated). */
const PREVIEW_LIMIT = 1000;

function profileSummary(row: ImportProfileRow) {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    version: row.version,
    status: row.status,
    brokerLabel: row.brokerLabel,
    specVersion: row.specVersion,
    usageCount: row.usageCount,
    createdAt: row.createdAt,
  };
}

// ── Analyze ──────────────────────────────────────────────────────────────────

export async function analyzeGenericFile(file: {
  buffer: Buffer;
  originalname: string;
}): Promise<GenericAnalyzeResult> {
  // Parsery wbudowane zawsze wygrywają — znany broker idzie przez /api/import/bulk.
  const classified = await classifyFile(file);
  if (classified.broker) {
    return { known: true, broker: classified.broker, fileRole: classified.role };
  }

  if (classified.isBinary) {
    return {
      known: false,
      error:
        'Import uniwersalny obsługuje na razie pliki CSV. ' +
        'Wyeksportuj zestawienie w formacie CSV albo użyj brokera wspieranego bezpośrednio.',
    };
  }

  const content = decodeCSVBuffer(file.buffer);
  const candidate = locateHeaderCandidate(content);
  if (!candidate) {
    return {
      known: false,
      error:
        'Nie udało się znaleźć wiersza nagłówka w pliku — upewnij się, że to poprawny ' +
        'eksport CSV z kolumnami.',
    };
  }

  const fingerprint = computeFingerprint(candidate.headers, candidate.delimiter);
  const active = findActiveProfileByFingerprint(fingerprint);

  // Sugestie podobnych formatów — szablony startowe dla edytora mapowania.
  const suggestions = active
    ? []
    : listActiveProfiles()
        .map((p) => ({ p, similarity: jaccardSimilarity(candidate.headers, p.headerNames) }))
        .filter((s) => s.similarity >= SUGGESTION_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, MAX_SUGGESTIONS)
        .map((s) => ({
          summary: profileSummary(s.p),
          similarity: Math.round(s.similarity * 100) / 100,
        }));

  return {
    known: false,
    fingerprint,
    delimiter: candidate.delimiter,
    headerRowIndex: candidate.headerRowIndex,
    headers: candidate.headers,
    sampleRows: redactSampleRows(candidate.headers, candidate.sampleRows.slice(0, SAMPLE_ROWS)),
    profile: active ? { summary: profileSummary(active), profileJson: active.profile } : undefined,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}

// ── Generacja profilu (LLM, Faza 4) ──────────────────────────────────────────

export interface GenerateProfileServiceResult {
  /** Profil zapisany w bibliotece jako 'pending' (generatedBy='llm'). */
  summary: ReturnType<typeof profileSummary>;
  profileJson: ImportProfile;
  confidence: number;
  attempts: number;
}

/**
 * Generuje profil przez LLM i od razu zapisuje w bibliotece jako 'pending'
 * (generatedBy='llm' + model + confidence — pełna proweniencja do review
 * admina). Zwraca null gdy generator nie osiągnął wystarczającej pewności —
 * UI przechodzi wtedy na ręczny edytor.
 *
 * Rzuca LlmUnavailableError (route → 503) i GenericParseError (route → 422).
 */
export async function generateProfileForFile(file: {
  buffer: Buffer;
  originalname: string;
  userId?: string;
}): Promise<GenerateProfileServiceResult | null> {
  const content = decodeCSVBuffer(file.buffer);
  const generated = await generateProfileFromContent(content, file.originalname);
  if (!generated) return null;

  const row = insertPendingProfile({
    fingerprint: generated.fingerprint,
    profile: generated.profile,
    headerNames: generated.headers,
    delimiter: generated.delimiter,
    sampleRows: generated.redactedSample,
    generatedBy: 'llm',
    createdByUserId: file.userId,
    llmModel: generated.model,
    llmConfidence: generated.confidence,
  });

  return {
    summary: profileSummary(row),
    profileJson: row.profile,
    confidence: generated.confidence,
    attempts: generated.attempts,
  };
}

// ── Preview ──────────────────────────────────────────────────────────────────

export function previewGeneric(
  file: { buffer: Buffer },
  rawProfile: unknown,
): GenericPreviewResult {
  const validation = validateImportProfile(rawProfile);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const content = decodeCSVBuffer(file.buffer);
  let output: GenericParseOutput;
  try {
    // Batch tymczasowy — preview niczego nie zapisuje.
    output = parseWithProfile(content, validation.profile, 'preview');
  } catch (err) {
    if (err instanceof GenericParseError) return { ok: false, errors: [err.message] };
    throw err;
  }

  const truncated =
    output.transactions.data.length > PREVIEW_LIMIT ||
    output.operations.data.length > PREVIEW_LIMIT ||
    output.rowTraces.length > PREVIEW_LIMIT;

  return {
    ok: true,
    transactions: {
      total: output.transactions.data.length,
      sample: output.transactions.data.slice(0, PREVIEW_LIMIT),
      skipped: output.transactions.skipped.slice(0, PREVIEW_LIMIT),
    },
    operations: {
      total: output.operations.data.length,
      sample: output.operations.data.slice(0, PREVIEW_LIMIT),
      skipped: output.operations.skipped.slice(0, PREVIEW_LIMIT),
    },
    rowTraces: output.rowTraces.slice(0, PREVIEW_LIMIT),
    truncated: truncated || undefined,
    warnings: output.warnings.length > 0 ? output.warnings : undefined,
  };
}

// ── Commit ───────────────────────────────────────────────────────────────────

export interface CommitGenericInput {
  buffer: Buffer;
  originalname: string;
  portfolioId: string;
  userId?: string;
  /** Użyj profilu z biblioteki… */
  profileId?: string;
  /** …albo profilu inline (edycja w kreatorze) — zapisany jako nowa wersja 'pending'. */
  profileJson?: unknown;
}

export async function commitGeneric(input: CommitGenericInput): Promise<GenericCommitResult> {
  const importBatch = randomUUID();
  const content = decodeCSVBuffer(input.buffer);

  // 1. Ustal profil: z biblioteki albo inline (→ nowa wersja pending w bibliotece).
  let profileRow: ImportProfileRow;
  if (input.profileId) {
    const row = getProfileById(input.profileId);
    if (!row || row.status === 'rejected' || row.status === 'superseded') {
      return failResult(importBatch, [
        'Wskazany profil importu nie istnieje albo został wycofany — odśwież analizę pliku.',
      ]);
    }
    profileRow = row;
  } else if (input.profileJson !== undefined) {
    const validation = validateImportProfile(input.profileJson);
    if (!validation.ok) {
      return failResult(importBatch, validation.errors);
    }
    const candidate = locateHeaderCandidate(content);
    if (!candidate) {
      return failResult(importBatch, ['Nie udało się znaleźć wiersza nagłówka w pliku.']);
    }
    profileRow = insertPendingProfile({
      fingerprint: computeFingerprint(candidate.headers, candidate.delimiter),
      profile: validation.profile,
      headerNames: candidate.headers,
      delimiter: candidate.delimiter,
      sampleRows: redactSampleRows(candidate.headers, candidate.sampleRows.slice(0, SAMPLE_ROWS)),
      generatedBy: 'manual',
      createdByUserId: input.userId,
    });
  } else {
    return failResult(importBatch, ['Brak profilu importu (profileId albo profileJson).']);
  }

  return runImport({
    content,
    rawBuffer: input.buffer,
    fileName: input.originalname,
    portfolioId: input.portfolioId,
    profileRow,
    importBatch,
  });
}

/** Wspólny rdzeń commit/reimport: parse → atomowe inserty → batch → rezolucja tickerów. */
async function runImport(args: {
  content: string;
  rawBuffer: Buffer | null;
  fileName: string | null;
  portfolioId: string;
  profileRow: ImportProfileRow;
  importBatch: string;
  /** reimport: skasuj poprzednie wiersze batcha przed insertem. */
  deletePreviousBatch?: boolean;
}): Promise<GenericCommitResult> {
  const { content, portfolioId: pid, profileRow, importBatch } = args;

  // Seed statycznej mapy tickerów (jak bulkImport) — znane ISIN-y rozwiązują się
  // bez requestów sieciowych, a rezolucja nazwa→ISIN ma na czym pracować.
  seedTickerMap(pid);

  let output: GenericParseOutput;
  try {
    output = parseWithProfile(content, profileRow.profile, importBatch);
  } catch (err) {
    if (err instanceof GenericParseError) return failResult(importBatch, [err.message]);
    throw err;
  }

  // Rezolucja nazwa→ISIN przed insertem (wzorzec mBank): profil bez kolumny ISIN
  // emituje pseudo-ISIN = nazwa papieru; jeśli ticker_map zna już tę nazwę,
  // podmieniamy na prawdziwy ISIN, żeby FIFO/dedup łączyły się z historią.
  if (profileRow.profile.needsNameResolution) {
    for (const tx of output.transactions.data) {
      const existing = findIsinByName(tx.paperName, pid);
      if (existing) tx.isin = existing.isin;
    }
  }

  const db = getDb(pid);
  const result: GenericCommitResult = {
    ...failResult(importBatch, []),
    success: true,
    errors: [],
    detectedSource: 'generic',
    profileId: profileRow.id,
    profileVersion: profileRow.version,
    profileStatus: profileRow.status,
    brokerLabel: profileRow.brokerLabel,
  };

  const txDuplicates: SkippedRow[] = [];
  const opsDuplicates: SkippedRow[] = [];

  const runAll = db.transaction(() => {
    if (args.deletePreviousBatch) {
      deleteTransactionsByBatch(importBatch, pid);
      deleteOperationsByBatch(importBatch, pid);
    }
    if (output.transactions.data.length > 0) {
      const r = insertTransactionsWithDedup(output.transactions.data, pid);
      result.transactionsImported = r.inserted;
      txDuplicates.push(...r.duplicates);
    }
    if (output.operations.data.length > 0) {
      const r = insertOperationsWithDedup(output.operations.data, pid);
      result.operationsImported = r.inserted;
      opsDuplicates.push(...r.duplicates);
    }
  });
  runAll();

  // Batch + surowy plik (gzip) w globalnej bazie — poza transakcją portfela
  // (inna baza SQLite; przy reimporcie aktualizuje wersję profilu i zdejmuje flagę).
  recordProfileBatch({
    profileId: profileRow.id,
    profileVersion: profileRow.version,
    portfolioId: pid,
    importBatch,
    fileName: args.fileName ?? undefined,
    rawFileGz: args.rawBuffer ? gzipSync(args.rawBuffer) : undefined,
  });
  bumpProfileUsage(profileRow.id);

  // Post-tx: rezolucja tickerów (sieciowa — poza transakcją SQLite), jak w bulkImport.
  let resolvedCount = 0;
  let unresolvedVisible: Array<{ isin: string; paperName: string }> = [];
  if (output.transactions.data.length > 0) {
    const resolution = await resolveUnknownIsins(output.transactions.data, pid);
    resolvedCount = resolution.resolved.length;

    const openNet = (isin: string) =>
      output.transactions.data
        .filter((t) => t.isin === isin)
        .reduce((sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity), 0);

    for (const u of resolution.unresolved) {
      if (Math.abs(openNet(u.isin)) > 0.001) {
        // Stub jak w bulkImport — pozycja otwarta musi mieć wpis w ticker_map.
        upsertTickerMapEntry(
          {
            isin: u.isin,
            ticker: u.paperName,
            name: u.paperName,
            exchange: 'GPW',
            currency: 'PLN',
            priceSource: 'stooq',
          },
          pid,
        );
      }
    }
    unresolvedVisible = resolution.unresolved.filter((u) => Math.abs(openNet(u.isin)) > 0.001);
  }

  const allSkipped: SkippedRow[] = [
    ...output.transactions.skipped,
    ...output.operations.skipped,
    ...txDuplicates,
    ...opsDuplicates,
  ];
  const duplicatesSkipped = txDuplicates.length + opsDuplicates.length;
  const orphanedSells = detectOrphanedSells(pid);

  return {
    ...result,
    tickersResolved: resolvedCount,
    tickersUnresolved: unresolvedVisible.map((u) => u.paperName),
    skipped: allSkipped.length > 0 ? allSkipped : undefined,
    duplicatesSkipped: duplicatesSkipped > 0 ? duplicatesSkipped : undefined,
    orphanedSells: orphanedSells.length > 0 ? orphanedSells : undefined,
    warnings: output.warnings.length > 0 ? output.warnings : undefined,
  };
}

// ── Batches / reimport ───────────────────────────────────────────────────────

export function listGenericBatches(portfolioId: string): GenericBatchInfo[] {
  return listProfileBatches(portfolioId).map((b) => {
    const profile = getProfileById(b.profileId);
    return {
      importBatch: b.importBatch,
      fileName: b.fileName,
      profileId: b.profileId,
      profileVersion: b.profileVersion,
      brokerLabel: profile?.brokerLabel ?? null,
      needsReimport: b.needsReimport,
      importedAt: b.importedAt,
    };
  });
}

/**
 * Re-import batcha z przechowanego surowego pliku przy użyciu AKTUALNEGO
 * aktywnego profilu dla fingerprinta (approved > pending). Wiersze starego
 * batcha są kasowane i wstawiane na nowo — ten sam import_batch, więc wpis
 * w profile_import_batches jest nadpisywany (upsert).
 */
export async function reimportGenericBatch(
  portfolioId: string,
  importBatch: string,
): Promise<GenericCommitResult> {
  const batch = getProfileBatchWithRaw(portfolioId, importBatch);
  if (!batch) {
    return failResult(importBatch, ['Nie znaleziono importu o podanym identyfikatorze.']);
  }
  if (!batch.rawFileGz) {
    return failResult(importBatch, [
      'Oryginalny plik tego importu nie jest już przechowywany (polityka retencji) — ' +
        'wgraj plik ponownie przez import uniwersalny.',
    ]);
  }

  const original = getProfileById(batch.profileId);
  const active = original
    ? (findActiveProfileByFingerprint(original.fingerprint) ?? original)
    : null;
  if (!active) {
    return failResult(importBatch, ['Profil tego importu nie istnieje w bibliotece.']);
  }

  const rawBuffer = gunzipSync(batch.rawFileGz);
  return runImport({
    content: decodeCSVBuffer(rawBuffer),
    rawBuffer,
    fileName: batch.fileName,
    portfolioId,
    profileRow: active,
    importBatch,
    deletePreviousBatch: true,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function failResult(importBatch: string, errors: string[]): GenericCommitResult {
  const base: ImportResult = {
    success: false,
    transactionsImported: 0,
    operationsImported: 0,
    errors,
    importBatch,
  };
  return base;
}
