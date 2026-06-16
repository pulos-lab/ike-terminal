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
 * Plik = zbiór TABEL: CSV ma jedną, XLSX ma jedną per arkusz z danymi. Każda
 * tabela przechodzi przez TEN SAM silnik (osobny fingerprint → osobny profil),
 * a wyniki wszystkich tabel scalają się w jeden atomowy import; każda tabela ma
 * własny `import_batch` (re-import i flaga needs_reimport działają per arkusz).
 */
import { randomUUID } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import type { CashOperation, ImportResult, SkippedRow, Transaction } from 'shared';
import {
  validateImportProfile,
  type GenericAnalyzeResult,
  type GenericBatchInfo,
  type GenericCommitResult,
  type GenericPreviewResult,
  type GenericSheetAnalysis,
  type GenericSheetProfileInput,
  type ImportProfile,
} from 'shared';
import { decodeCSVBuffer } from '../parsers/encoding.js';
import { loadXlsxSheets, looksLikeXlsx } from '../parsers/xlsx-to-csv.js';
import { parseWithProfile, type GenericParseOutput } from '../parsers/generic/engine.js';
import { GenericParseError } from '../parsers/generic/value-parsers.js';
import {
  computeFingerprint,
  jaccardSimilarity,
  locateHeaderCandidate,
  type HeaderCandidate,
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

// ── Enumeracja dokumentów (CSV = 1 tabela, XLSX = 1 per arkusz z danymi) ──────

/** Jedna tabela do przetworzenia silnikiem. Tożsamość = (fileName, sheet). */
interface ImportDocument {
  /** Nazwa arkusza XLSX; brak → CSV. */
  sheet?: string;
  /** Nazwa pliku źródłowego (multi-plik). */
  fileName: string;
  /** Treść CSV podawana silnikowi (XLSX: arkusz zserializowany średnikiem). */
  content: string;
  candidate: HeaderCandidate;
  fingerprint: string;
}

interface EnumeratedFile {
  format: 'csv' | 'xlsx';
  documents: ImportDocument[];
  /** Arkusze pominięte (brak kandydata nagłówka / puste / jednokolumnowe). */
  skippedSheets: string[];
}

function buildDocument(content: string, fileName: string, sheet?: string): ImportDocument | null {
  const candidate = locateHeaderCandidate(content);
  if (!candidate || candidate.sampleRows.length === 0) return null;
  return {
    sheet,
    fileName,
    content,
    candidate,
    fingerprint: computeFingerprint(candidate.headers, candidate.delimiter, sheet),
  };
}

/** Czy bufor/nazwa wskazują na XLSX (sygnatura ZIP lub rozszerzenie). */
function isXlsxFile(buffer: Buffer, originalname: string): boolean {
  return looksLikeXlsx(buffer) || originalname.toLowerCase().endsWith('.xlsx');
}

/** Rozłóż plik na tabele: CSV → jedna; XLSX → jedna per arkusz z danymi. */
async function enumerateImportDocuments(
  buffer: Buffer,
  originalname: string,
): Promise<EnumeratedFile> {
  if (!isXlsxFile(buffer, originalname)) {
    const doc = buildDocument(decodeCSVBuffer(buffer), originalname);
    return { format: 'csv', documents: doc ? [doc] : [], skippedSheets: [] };
  }
  const sheets = await loadXlsxSheets(buffer);
  const documents: ImportDocument[] = [];
  const skippedSheets: string[] = [];
  for (const s of sheets) {
    const doc = buildDocument(s.csv, originalname, s.name);
    if (doc) documents.push(doc);
    else skippedSheets.push(s.name);
  }
  return { format: 'xlsx', documents, skippedSheets };
}

/** Rozłóż WIELE plików na płaską listę tabel (każda otagowana plikiem źródłowym). */
async function enumerateImportFiles(
  files: Array<{ buffer: Buffer; originalname: string }>,
): Promise<{ documents: ImportDocument[]; skipped: Array<{ file: string; sheet?: string }> }> {
  const documents: ImportDocument[] = [];
  const skipped: Array<{ file: string; sheet?: string }> = [];
  for (const f of files) {
    const enumerated = await enumerateImportDocuments(f.buffer, f.originalname);
    documents.push(...enumerated.documents);
    for (const s of enumerated.skippedSheets) skipped.push({ file: f.originalname, sheet: s });
    if (enumerated.documents.length === 0 && enumerated.skippedSheets.length === 0) {
      skipped.push({ file: f.originalname }); // CSV bez rozpoznanego wiersza nagłówka
    }
  }
  return { documents, skipped };
}

/**
 * Dopasuj wejście profilu do dokumentu po (file, sheet). `file === undefined` =
 * legacy 1-plik (dopasowanie po samym arkuszu); multi-plik zawsze podaje `file`.
 */
function matchDocumentInput(
  inputs: GenericSheetProfileInput[],
  doc: ImportDocument,
): GenericSheetProfileInput | undefined {
  return inputs.find(
    (i) => (i.file === undefined || i.file === doc.fileName) && i.sheet === doc.sheet,
  );
}

/** Wstrzyknij nazwę arkusza do profilu (marker XLSX); CSV bez zmian. */
function profileWithSheet(profile: ImportProfile, sheet?: string): ImportProfile {
  if (sheet === undefined) return profile;
  return { ...profile, file: { ...profile.file, sheet } };
}

// ── Analyze ──────────────────────────────────────────────────────────────────

/** Analiza jednej tabeli: profil z biblioteki / sugestie / zredagowana próbka. */
function analyzeDocument(doc: ImportDocument): GenericSheetAnalysis {
  const active = findActiveProfileByFingerprint(doc.fingerprint);
  const suggestions = active
    ? []
    : listActiveProfiles()
        .map((p) => ({ p, similarity: jaccardSimilarity(doc.candidate.headers, p.headerNames) }))
        .filter((s) => s.similarity >= SUGGESTION_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, MAX_SUGGESTIONS)
        .map((s) => ({
          summary: profileSummary(s.p),
          similarity: Math.round(s.similarity * 100) / 100,
          // Pełny JSON profilu — pozwala kreatorowi zaadoptować podobny profil
          // (klon z nadpisanym delimiterem/arkuszem) bez ponownej generacji LLM.
          profileJson: s.p.profile,
        }));
  return {
    sheet: doc.sheet,
    file: doc.fileName,
    fingerprint: doc.fingerprint,
    delimiter: doc.candidate.delimiter,
    headerRowIndex: doc.candidate.headerRowIndex,
    headers: doc.candidate.headers,
    sampleRows: redactSampleRows(
      doc.candidate.headers,
      doc.candidate.sampleRows.slice(0, SAMPLE_ROWS),
    ),
    profile: active ? { summary: profileSummary(active), profileJson: active.profile } : undefined,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}

export async function analyzeGenericFile(file: {
  buffer: Buffer;
  originalname: string;
}): Promise<GenericAnalyzeResult> {
  // Parsery wbudowane zawsze wygrywają — znany broker idzie przez /api/import/bulk.
  const classified = await classifyFile(file);
  if (classified.broker) {
    return { known: true, broker: classified.broker, fileRole: classified.role };
  }

  const { format, documents, skippedSheets } = await enumerateImportDocuments(
    file.buffer,
    file.originalname,
  );

  if (documents.length === 0) {
    return {
      known: false,
      error:
        format === 'xlsx'
          ? 'W pliku XLSX nie znaleziono żadnego arkusza z tabelą danych (z wierszem nagłówka).'
          : 'Nie udało się znaleźć wiersza nagłówka w pliku — upewnij się, że to poprawny ' +
            'eksport CSV z kolumnami.',
    };
  }

  // CSV: pola płaskie (wsteczna zgodność). XLSX: lista arkuszy.
  if (format === 'csv') {
    const a = analyzeDocument(documents[0]);
    return {
      known: false,
      format: 'csv',
      fingerprint: a.fingerprint,
      delimiter: a.delimiter,
      headerRowIndex: a.headerRowIndex,
      headers: a.headers,
      sampleRows: a.sampleRows,
      profile: a.profile,
      suggestions: a.suggestions,
    };
  }

  return {
    known: false,
    format: 'xlsx',
    sheets: documents.map(analyzeDocument),
    skippedSheets: skippedSheets.length > 0 ? skippedSheets : undefined,
  };
}

/**
 * Analiza WIELU plików (import multi-plik). Pojedynczy znany broker → zachowanie
 * jak dawniej (`analyzeGenericFile` → known:true → wizard odsyła do kafla brokera).
 * Inaczej: rozkłada wszystkie pliki na dokumenty (tabele) i zwraca zunifikowaną
 * listę `documents` (każdy z `file`), listę `knownFiles` (obsługiwanych wbudowanym
 * parserem — do zaimportowania przez kafel) oraz `skippedDocuments`.
 */
export async function analyzeGenericFiles(
  files: Array<{ buffer: Buffer; originalname: string }>,
): Promise<GenericAnalyzeResult> {
  if (files.length === 1) {
    const single = await analyzeGenericFile(files[0]);
    if (single.known) return single;
  }

  const knownFiles: NonNullable<GenericAnalyzeResult['knownFiles']> = [];
  const unknown: Array<{ buffer: Buffer; originalname: string }> = [];
  for (const f of files) {
    const classified = await classifyFile(f);
    if (classified.broker) knownFiles.push({ file: f.originalname, broker: classified.broker });
    else unknown.push(f);
  }

  const { documents, skipped } = await enumerateImportFiles(unknown);
  const docAnalyses = documents.map(analyzeDocument);

  if (docAnalyses.length === 0 && knownFiles.length === 0) {
    return {
      known: false,
      error: 'W przesłanych plikach nie znaleziono tabeli danych (wiersza nagłówka).',
    };
  }

  return {
    known: false,
    // Zawsze tablica (także []), nigdy undefined: pusta lista znaczy „wszystkie
    // pliki obsługuje import wbudowany" — kreator pokazuje wtedy blok knownFiles
    // zamiast wpadać w legacy-fallback z pustym mapowaniem (undefined → flat).
    documents: docAnalyses,
    knownFiles: knownFiles.length > 0 ? knownFiles : undefined,
    skippedDocuments: skipped.length > 0 ? skipped : undefined,
  };
}

// ── Generacja profilu (LLM, Faza 4) ──────────────────────────────────────────

export interface GenerateProfileServiceResult {
  /** Profil zapisany w bibliotece jako 'pending' (generatedBy='llm'). */
  summary: ReturnType<typeof profileSummary>;
  profileJson: ImportProfile;
  confidence: number;
  attempts: number;
  sheet?: string;
}

/** Treść tabeli (CSV lub konkretny arkusz XLSX) do generacji/preview/commit. */
async function documentContentForSheet(
  buffer: Buffer,
  originalname: string,
  sheet?: string,
): Promise<{ content: string; doc: ImportDocument } | null> {
  const { documents } = await enumerateImportDocuments(buffer, originalname);
  const doc = sheet === undefined ? documents[0] : documents.find((d) => d.sheet === sheet);
  return doc ? { content: doc.content, doc } : null;
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
  /** Arkusz XLSX do generacji; brak → CSV (cały plik). */
  sheet?: string;
}): Promise<GenerateProfileServiceResult | null> {
  const picked = await documentContentForSheet(file.buffer, file.originalname, file.sheet);
  if (!picked) {
    throw new GenericParseError(
      file.sheet
        ? `Nie znaleziono arkusza „${file.sheet}" z danymi w pliku.`
        : 'Nie udało się znaleźć wiersza nagłówka w pliku.',
    );
  }
  const generated = await generateProfileFromContent(picked.content, file.originalname);
  if (!generated) return null;

  // XLSX: fingerprint i profil muszą nieść nazwę arkusza (computeFingerprint
  // wlicza arkusz; engine to ignoruje, ale marker służy bibliotece/re-importowi).
  const fingerprint = file.sheet
    ? computeFingerprint(generated.headers, generated.delimiter, file.sheet)
    : generated.fingerprint;

  const row = insertPendingProfile({
    fingerprint,
    profile: profileWithSheet(generated.profile, file.sheet),
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
    sheet: file.sheet,
  };
}

// ── Preview ──────────────────────────────────────────────────────────────────

/** Rozwiąż profil arkusza z żądania: profileId (biblioteka) albo profileJson. */
function resolveSheetProfile(
  input: GenericSheetProfileInput,
): { ok: true; profile: ImportProfile } | { ok: false; errors: string[] } {
  if (input.profileId) {
    const row = getProfileById(input.profileId);
    if (!row || row.status === 'rejected' || row.status === 'superseded') {
      return { ok: false, errors: ['Wskazany profil importu nie istnieje albo został wycofany.'] };
    }
    return { ok: true, profile: row.profile };
  }
  const validation = validateImportProfile(input.profileJson);
  return validation.ok ? { ok: true, profile: validation.profile } : validation;
}

/** Preview jednej tabeli CSV (oraz dry-run admina na zredagowanej próbce). */
export function previewGeneric(
  file: { buffer: Buffer },
  rawProfile: unknown,
): GenericPreviewResult {
  const validation = validateImportProfile(rawProfile);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return buildPreview([
    { sheet: undefined, content: decodeCSVBuffer(file.buffer), profile: validation.profile },
  ]);
}

/**
 * Preview XLSX: każdy arkusz wykonany swoim profilem, wyniki SCALONE w jeden
 * podgląd (+ wkład per arkusz w sheetSummaries). Profile per arkusz z żądania.
 */
export async function previewGenericMulti(
  file: { buffer: Buffer; originalname: string },
  sheetProfiles: GenericSheetProfileInput[],
): Promise<GenericPreviewResult> {
  return previewGenericDocuments(
    [{ buffer: file.buffer, originalname: file.originalname }],
    sheetProfiles,
  );
}

/**
 * Preview multi-plik/multi-arkusz: każda tabela (z dowolnego pliku) wykonana swoim
 * profilem, wyniki SCALONE w jeden podgląd. Etykieta tabeli = arkusz (XLSX) albo
 * nazwa pliku (multi-plik CSV).
 */
export async function previewGenericDocuments(
  files: Array<{ buffer: Buffer; originalname: string }>,
  inputs: GenericSheetProfileInput[],
): Promise<GenericPreviewResult> {
  const { documents } = await enumerateImportFiles(files);
  const multi = files.length > 1;
  const tables: Array<{ sheet?: string; content: string; profile: ImportProfile }> = [];
  for (const doc of documents) {
    const input = matchDocumentInput(inputs, doc);
    if (!input) continue; // dokument bez wybranego profilu → pominięty w podglądzie
    const resolved = resolveSheetProfile(input);
    if (!resolved.ok) return { ok: false, errors: resolved.errors };
    tables.push({
      sheet: doc.sheet ?? (multi ? doc.fileName : undefined),
      content: doc.content,
      profile: resolved.profile,
    });
  }
  if (tables.length === 0) {
    return { ok: false, errors: ['Brak dokumentów z przypisanym profilem do podglądu.'] };
  }
  return buildPreview(tables);
}

/** Wykonaj listę tabel (profil per tabela) i scal w jeden GenericPreviewResult. */
function buildPreview(
  tables: Array<{ sheet?: string; content: string; profile: ImportProfile }>,
): GenericPreviewResult {
  const transactions: Transaction[] = [];
  const operations: CashOperation[] = [];
  const txSkipped: SkippedRow[] = [];
  const opsSkipped: SkippedRow[] = [];
  const rowTraces: GenericParseOutput['rowTraces'] = [];
  const warnings: string[] = [];
  const sheetSummaries: NonNullable<GenericPreviewResult['sheetSummaries']> = [];

  for (const t of tables) {
    let output: GenericParseOutput;
    try {
      output = parseWithProfile(t.content, t.profile, 'preview');
    } catch (err) {
      if (err instanceof GenericParseError) {
        const where = t.sheet ? `Arkusz „${t.sheet}": ` : '';
        return { ok: false, errors: [where + err.message] };
      }
      throw err;
    }
    transactions.push(...output.transactions.data);
    operations.push(...output.operations.data);
    txSkipped.push(...output.transactions.skipped);
    opsSkipped.push(...output.operations.skipped);
    rowTraces.push(...output.rowTraces);
    warnings.push(...output.warnings.map((w) => (t.sheet ? `[${t.sheet}] ${w}` : w)));
    sheetSummaries.push({
      sheet: t.sheet,
      transactions: output.transactions.data.length,
      operations: output.operations.data.length,
      skipped: output.transactions.skipped.length + output.operations.skipped.length,
    });
  }

  const truncated =
    transactions.length > PREVIEW_LIMIT ||
    operations.length > PREVIEW_LIMIT ||
    rowTraces.length > PREVIEW_LIMIT;

  return {
    ok: true,
    transactions: {
      total: transactions.length,
      sample: transactions.slice(0, PREVIEW_LIMIT),
      skipped: txSkipped.slice(0, PREVIEW_LIMIT),
    },
    operations: {
      total: operations.length,
      sample: operations.slice(0, PREVIEW_LIMIT),
      skipped: opsSkipped.slice(0, PREVIEW_LIMIT),
    },
    rowTraces: rowTraces.slice(0, PREVIEW_LIMIT),
    truncated: truncated || undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    sheetSummaries: tables.length > 1 ? sheetSummaries : undefined,
  };
}

// ── Commit ───────────────────────────────────────────────────────────────────

export interface CommitGenericInput {
  buffer: Buffer;
  originalname: string;
  portfolioId: string;
  userId?: string;
  /** CSV: profil z biblioteki… */
  profileId?: string;
  /** …albo inline (edycja w kreatorze) — zapisany jako nowa wersja 'pending'. */
  profileJson?: unknown;
  /** XLSX: profil per arkusz (ma pierwszeństwo nad profileId/profileJson). */
  sheets?: GenericSheetProfileInput[];
}

/** Ustal profileRow dla dokumentu: z biblioteki albo zapisz inline jako 'pending'. */
function resolveOrInsertProfileRow(
  si: GenericSheetProfileInput,
  doc: ImportDocument,
  userId?: string,
): { row: ImportProfileRow } | { errors: string[] } {
  if (si.profileId) {
    const row = getProfileById(si.profileId);
    if (!row || row.status === 'rejected' || row.status === 'superseded') {
      return {
        errors: [
          'Wskazany profil importu nie istnieje albo został wycofany — odśwież analizę pliku.',
        ],
      };
    }
    return { row };
  }
  if (si.profileJson === undefined) {
    return { errors: ['Brak profilu importu (profileId albo profileJson).'] };
  }
  const validation = validateImportProfile(si.profileJson);
  if (!validation.ok) return { errors: validation.errors };
  const row = insertPendingProfile({
    fingerprint: doc.fingerprint, // dla XLSX zawiera już nazwę arkusza
    profile: profileWithSheet(validation.profile, doc.sheet),
    headerNames: doc.candidate.headers,
    delimiter: doc.candidate.delimiter,
    sampleRows: redactSampleRows(
      doc.candidate.headers,
      doc.candidate.sampleRows.slice(0, SAMPLE_ROWS),
    ),
    generatedBy: 'manual',
    createdByUserId: userId,
  });
  return { row };
}

export async function commitGeneric(input: CommitGenericInput): Promise<GenericCommitResult> {
  // Cienki wrapper na multi-plik: 1 plik + wejścia z sheets/profileId/profileJson.
  const inputs: GenericSheetProfileInput[] = input.sheets ?? [
    { sheet: undefined, profileId: input.profileId, profileJson: input.profileJson },
  ];
  return commitGenericDocuments({
    files: [{ buffer: input.buffer, originalname: input.originalname }],
    inputs,
    portfolioId: input.portfolioId,
    userId: input.userId,
  });
}

export interface CommitGenericDocumentsInput {
  files: Array<{ buffer: Buffer; originalname: string }>;
  /** Profil per dokument (file, sheet) — z biblioteki (profileId) lub inline (profileJson). */
  inputs: GenericSheetProfileInput[];
  portfolioId: string;
  userId?: string;
}

/**
 * Atomowy import WIELU plików: każdy plik → tabele (CSV: 1, XLSX: N arkuszy);
 * każda tabela dostaje profil dopasowany po (file, sheet); wszystkie tabele
 * scalają się w JEDEN atomowy import. Rola wynika z profilu (classify), więc nie
 * ma slotów transakcje/operacje. Każda tabela = osobny batch z surowym plikiem
 * SWOJEGO źródła (re-import per tabela).
 */
export async function commitGenericDocuments(
  input: CommitGenericDocumentsInput,
): Promise<GenericCommitResult> {
  const { documents } = await enumerateImportFiles(input.files);
  if (documents.length === 0) {
    return failResult(randomUUID(), ['Nie udało się odczytać tabeli danych z plików.']);
  }
  const bufByName = new Map(input.files.map((f) => [f.originalname, f.buffer]));

  const tables: RunTable[] = [];
  // Ten sam fingerprint w wielu plikach (np. Bossa per-waluta) z profilem inline:
  // profil wstawiamy RAZ, kolejne tabele reużywają tej wersji (jeden profil, N batchy).
  const insertedByFingerprint = new Map<string, ImportProfileRow>();
  for (const doc of documents) {
    const si = matchDocumentInput(input.inputs, doc);
    // Dokument bez wybranego profilu → pominięty (użytkownik nie zmapował tej tabeli).
    if (!si || (!si.profileId && si.profileJson === undefined)) continue;
    let row = si.profileId ? undefined : insertedByFingerprint.get(doc.fingerprint);
    if (!row) {
      const resolved = resolveOrInsertProfileRow(si, doc, input.userId);
      if ('errors' in resolved) return failResult(randomUUID(), resolved.errors);
      row = resolved.row;
      if (!si.profileId) insertedByFingerprint.set(doc.fingerprint, row);
    }
    tables.push({
      content: doc.content,
      profileRow: row,
      importBatch: randomUUID(),
      fileName: doc.fileName,
      rawBuffer: bufByName.get(doc.fileName) ?? null,
    });
  }
  if (tables.length === 0) {
    return failResult(randomUUID(), ['Żaden dokument nie ma przypisanego profilu importu.']);
  }

  return runImportDocuments({ tables, portfolioId: input.portfolioId });
}

interface RunTable {
  content: string;
  profileRow: ImportProfileRow;
  /** Własny import_batch (re-import i flaga needs_reimport działają per tabela). */
  importBatch: string;
  /** Nazwa pliku źródłowego tej tabeli (do batcha + cache gzipu). */
  fileName: string | null;
  /** Surowy plik źródłowy tej tabeli (gzip do re-importu); null = brak retencji. */
  rawBuffer: Buffer | null;
}

/**
 * Rdzeń commit/reimport dla LISTY tabel (CSV: 1; XLSX: N arkuszy). Parse →
 * jeden atomowy insert WSZYSTKICH tabel → batch per tabela (wspólny surowy plik)
 * → jedna rezolucja tickerów na scalonych transakcjach → scalony wynik.
 */
async function runImportDocuments(args: {
  tables: RunTable[];
  portfolioId: string;
  /** reimport: skasuj poprzednie wiersze każdego batcha przed insertem. */
  deletePreviousBatch?: boolean;
}): Promise<GenericCommitResult> {
  const { tables, portfolioId: pid } = args;
  const primaryBatch = tables[0].importBatch;

  // Seed statycznej mapy tickerów (jak bulkImport) — znane ISIN-y bez sieci.
  seedTickerMap(pid);

  // 1. Parse wszystkich tabel (czyste, bez DB) + rezolucja nazwa→ISIN per tabela.
  const parsed: Array<{ table: RunTable; output: GenericParseOutput }> = [];
  for (const table of tables) {
    let output: GenericParseOutput;
    try {
      output = parseWithProfile(table.content, table.profileRow.profile, table.importBatch);
    } catch (err) {
      if (err instanceof GenericParseError) return failResult(primaryBatch, [err.message]);
      throw err;
    }
    if (table.profileRow.profile.needsNameResolution) {
      for (const tx of output.transactions.data) {
        const existing = findIsinByName(tx.paperName, pid);
        if (existing) tx.isin = existing.isin;
      }
    }
    parsed.push({ table, output });
  }

  // 2. Atomowy insert WSZYSTKICH tabel — jeden import = jedna transakcja portfela.
  const db = getDb(pid);
  let txImported = 0;
  let opsImported = 0;
  const txDuplicates: SkippedRow[] = [];
  const opsDuplicates: SkippedRow[] = [];
  const runAll = db.transaction(() => {
    if (args.deletePreviousBatch) {
      for (const { table } of parsed) {
        deleteTransactionsByBatch(table.importBatch, pid);
        deleteOperationsByBatch(table.importBatch, pid);
      }
    }
    for (const { output } of parsed) {
      if (output.transactions.data.length > 0) {
        const r = insertTransactionsWithDedup(output.transactions.data, pid);
        txImported += r.inserted;
        txDuplicates.push(...r.duplicates);
      }
      if (output.operations.data.length > 0) {
        const r = insertOperationsWithDedup(output.operations.data, pid);
        opsImported += r.inserted;
        opsDuplicates.push(...r.duplicates);
      }
    }
  });
  runAll();

  // 3. Batch per tabela — surowy plik per ŹRÓDŁOWY plik (gzip raz na plik, nie na
  // każdy arkusz XLSX). Każdy batch trzyma raw SWOJEGO pliku → re-import per tabela.
  const gzCache = new Map<string, Buffer>();
  const rawGzFor = (table: RunTable): Buffer | undefined => {
    if (!table.rawBuffer) return undefined;
    const key = table.fileName ?? '';
    let gz = gzCache.get(key);
    if (!gz) {
      gz = gzipSync(table.rawBuffer);
      gzCache.set(key, gz);
    }
    return gz;
  };
  for (const { table } of parsed) {
    recordProfileBatch({
      profileId: table.profileRow.id,
      profileVersion: table.profileRow.version,
      portfolioId: pid,
      importBatch: table.importBatch,
      fileName: table.fileName ?? undefined,
      rawFileGz: rawGzFor(table),
    });
    bumpProfileUsage(table.profileRow.id);
  }

  // 4. Post-tx rezolucja tickerów na SCALONYCH transakcjach (sieć — poza tx).
  const allTx = parsed.flatMap((p) => p.output.transactions.data);
  let resolvedCount = 0;
  let unresolvedVisible: Array<{ isin: string; paperName: string }> = [];
  if (allTx.length > 0) {
    const resolution = await resolveUnknownIsins(allTx, pid);
    resolvedCount = resolution.resolved.length;
    const openNet = (isin: string) =>
      allTx
        .filter((t) => t.isin === isin)
        .reduce((sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity), 0);
    for (const u of resolution.unresolved) {
      if (Math.abs(openNet(u.isin)) > 0.001) {
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
    ...parsed.flatMap((p) => p.output.transactions.skipped),
    ...parsed.flatMap((p) => p.output.operations.skipped),
    ...txDuplicates,
    ...opsDuplicates,
  ];
  const allWarnings = parsed.flatMap((p) => p.output.warnings);
  const duplicatesSkipped = txDuplicates.length + opsDuplicates.length;
  const orphanedSells = detectOrphanedSells(pid);
  const primary = parsed[0].table.profileRow;

  return {
    success: true,
    transactionsImported: txImported,
    operationsImported: opsImported,
    errors: [],
    importBatch: primaryBatch,
    detectedSource: 'generic',
    profileId: primary.id,
    profileVersion: primary.version,
    profileStatus: primary.status,
    brokerLabel: primary.brokerLabel,
    tickersResolved: resolvedCount,
    tickersUnresolved: unresolvedVisible.map((u) => u.paperName),
    skipped: allSkipped.length > 0 ? allSkipped : undefined,
    duplicatesSkipped: duplicatesSkipped > 0 ? duplicatesSkipped : undefined,
    orphanedSells: orphanedSells.length > 0 ? orphanedSells : undefined,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
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
      sheet: profile?.profile.file.sheet ?? null,
      needsReimport: b.needsReimport,
      importedAt: b.importedAt,
    };
  });
}

/**
 * Re-import batcha z przechowanego surowego pliku przy użyciu AKTUALNEGO
 * aktywnego profilu dla fingerprinta (approved > pending). XLSX: z pliku
 * wybieramy DOKŁADNIE tę tabelę, której fingerprint pasuje do tego batcha
 * (fingerprint XLSX zawiera nazwę arkusza) — pozostałe arkusze/batche nietknięte.
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
  const { documents } = await enumerateImportDocuments(rawBuffer, batch.fileName ?? '');
  // Tabela tego batcha = ta o fingerprincie profilu; fallback: jedyna tabela.
  const doc =
    documents.find((d) => d.fingerprint === active.fingerprint) ??
    (documents.length === 1 ? documents[0] : undefined);
  if (!doc) {
    return failResult(importBatch, [
      'Nie odnaleziono w pliku tabeli pasującej do tego importu (zmienił się układ pliku?).',
    ]);
  }

  return runImportDocuments({
    tables: [
      {
        content: doc.content,
        profileRow: active,
        importBatch,
        fileName: batch.fileName,
        rawBuffer,
      },
    ],
    portfolioId,
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
