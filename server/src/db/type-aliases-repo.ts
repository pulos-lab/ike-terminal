import type {
  UnknownTypeReport,
  UnknownTypeReportKind,
  UnknownTypeReportStatus,
  UnknownTypeReportSuggestion,
} from 'shared';
import { getImportsDb } from './imports-db.js';

// Zgłoszenia nieznanych typów operacji (globalna import_profiles.db) — agregat
// per (broker, raw_type, kind). Wzorzec import-profiles-repo: sync better-sqlite3,
// mapowanie snake_case → camelCase. Próbki są ZREDAGOWANE przed wejściem tutaj
// (sample-redactor w route) — repo niczego nie redaguje.

/** Cap sugestii per agregat — zgłoszenia setek userów nie rozdmuchują wiersza. */
const MAX_SUGGESTIONS = 20;

interface ReportDbRow {
  id: number;
  broker: string;
  raw_type: string;
  kind: string;
  headers_json: string | null;
  sample_cells_json: string | null;
  suggestions_json: string;
  reporter_ids_json: string;
  occurrence_count: number;
  status: string;
  first_reported_at: string;
  last_reported_at: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

function toReport(r: ReportDbRow): UnknownTypeReport {
  return {
    id: r.id,
    broker: r.broker,
    rawType: r.raw_type,
    kind: r.kind as UnknownTypeReportKind,
    headers: r.headers_json ? JSON.parse(r.headers_json) : undefined,
    sampleCells: r.sample_cells_json ? JSON.parse(r.sample_cells_json) : undefined,
    suggestions: JSON.parse(r.suggestions_json),
    reporterCount: (JSON.parse(r.reporter_ids_json) as string[]).length,
    occurrenceCount: r.occurrence_count,
    status: r.status as UnknownTypeReportStatus,
    firstReportedAt: r.first_reported_at,
    lastReportedAt: r.last_reported_at,
    reviewNote: r.review_note ?? undefined,
  };
}

export interface UpsertReportInput {
  broker: string;
  rawType: string;
  kind: UnknownTypeReportKind;
  /** ZREDAGOWANE nagłówki/próbka (sample-redactor) — zapisywane tylko przy pierwszym zgłoszeniu. */
  headers?: string[];
  sampleCells?: string[];
  suggestion?: Omit<UnknownTypeReportSuggestion, 'at'>;
  reporterId: string;
}

export interface UpsertReportResult {
  /** true = powstał nowy agregat (jedyny moment wysyłki maila do admina — anty-spam). */
  isNew: boolean;
  report: UnknownTypeReport;
}

/** Agregujący upsert: nowy (broker, raw_type, kind) tworzy wiersz; kolejne
 * zgłoszenia inkrementują licznik, dopisują reportera (dedup) i sugestię (cap). */
export function upsertUnknownTypeReport(input: UpsertReportInput): UpsertReportResult {
  const db = getImportsDb();
  const broker = input.broker.trim().toLowerCase();
  const rawType = input.rawType.trim().toLowerCase();

  const run = db.transaction((): UpsertReportResult => {
    const existing = db
      .prepare('SELECT * FROM unknown_type_reports WHERE broker = ? AND raw_type = ? AND kind = ?')
      .get(broker, rawType, input.kind) as ReportDbRow | undefined;

    const suggestion: UnknownTypeReportSuggestion | null = input.suggestion
      ? { ...input.suggestion, at: new Date().toISOString() }
      : null;

    if (!existing) {
      const info = db
        .prepare(
          `INSERT INTO unknown_type_reports
             (broker, raw_type, kind, headers_json, sample_cells_json, suggestions_json, reporter_ids_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          broker,
          rawType,
          input.kind,
          input.headers ? JSON.stringify(input.headers) : null,
          input.sampleCells ? JSON.stringify(input.sampleCells) : null,
          JSON.stringify(suggestion ? [suggestion] : []),
          JSON.stringify([input.reporterId]),
        );
      const row = db
        .prepare('SELECT * FROM unknown_type_reports WHERE id = ?')
        .get(info.lastInsertRowid) as ReportDbRow;
      return { isNew: true, report: toReport(row) };
    }

    const reporters = JSON.parse(existing.reporter_ids_json) as string[];
    if (!reporters.includes(input.reporterId)) reporters.push(input.reporterId);
    const suggestions = JSON.parse(existing.suggestions_json) as UnknownTypeReportSuggestion[];
    if (suggestion && suggestions.length < MAX_SUGGESTIONS) suggestions.push(suggestion);

    db.prepare(
      `UPDATE unknown_type_reports
       SET occurrence_count = occurrence_count + 1,
           reporter_ids_json = ?,
           suggestions_json = ?,
           last_reported_at = datetime('now')
       WHERE id = ?`,
    ).run(JSON.stringify(reporters), JSON.stringify(suggestions), existing.id);
    const row = db
      .prepare('SELECT * FROM unknown_type_reports WHERE id = ?')
      .get(existing.id) as ReportDbRow;
    return { isNew: false, report: toReport(row) };
  });
  return run();
}

export function listUnknownTypeReports(filter?: {
  status?: UnknownTypeReportStatus;
  kind?: UnknownTypeReportKind;
}): UnknownTypeReport[] {
  const db = getImportsDb();
  const where: string[] = [];
  const params: string[] = [];
  if (filter?.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  const sql = `SELECT * FROM unknown_type_reports
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY last_reported_at DESC, id DESC`;
  return (db.prepare(sql).all(...params) as ReportDbRow[]).map(toReport);
}

export function getUnknownTypeReport(id: number): UnknownTypeReport | null {
  const row = getImportsDb().prepare('SELECT * FROM unknown_type_reports WHERE id = ?').get(id) as
    | ReportDbRow
    | undefined;
  return row ? toReport(row) : null;
}

export function setUnknownTypeReportStatus(
  id: number,
  status: Exclude<UnknownTypeReportStatus, 'open'>,
  reviewerUserId: string,
  note?: string,
): boolean {
  const info = getImportsDb()
    .prepare(
      `UPDATE unknown_type_reports
       SET status = ?, reviewed_by_user_id = ?, reviewed_at = datetime('now'),
           review_note = COALESCE(?, review_note)
       WHERE id = ?`,
    )
    .run(status, reviewerUserId, note ?? null, id);
  return info.changes > 0;
}
