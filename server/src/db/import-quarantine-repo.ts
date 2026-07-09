import { getDb } from './connection.js';
import type { QuarantineRecord } from 'shared';

export function insertQuarantineRecords(
  records: QuarantineRecord[],
  importBatch: string,
  fileName: string | undefined,
  portfolioId: string = 'default',
): void {
  if (records.length === 0) return;
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT INTO import_quarantine (import_batch, row_number, severity, reason, message, raw_json, parsed_json, suggestions_json, file_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: typeof records) => {
    for (const r of items) {
      stmt.run(
        importBatch,
        r.rowNumber,
        r.severity,
        r.reason,
        r.message,
        JSON.stringify(r.raw),
        r.parsed ? JSON.stringify(r.parsed) : null,
        r.suggestions ? JSON.stringify(r.suggestions) : null,
        fileName ?? null,
      );
    }
  });
  insertMany(records);
}

export function getQuarantineByBatch(
  importBatch: string,
  portfolioId: string = 'default',
): QuarantineRecord[] {
  const db = getDb(portfolioId);
  const rows = db
    .prepare('SELECT * FROM import_quarantine WHERE import_batch = ? ORDER BY row_number')
    .all(importBatch) as any[];
  return rows.map((r) => ({
    rowNumber: r.row_number,
    severity: r.severity,
    reason: r.reason,
    message: r.message,
    raw: JSON.parse(r.raw_json),
    ...(r.parsed_json ? { parsed: JSON.parse(r.parsed_json) } : {}),
    ...(r.suggestions_json ? { suggestions: JSON.parse(r.suggestions_json) } : {}),
  }));
}

export function deleteQuarantineByBatch(
  importBatch: string,
  portfolioId: string = 'default',
): number {
  const db = getDb(portfolioId);
  const r = db.prepare('DELETE FROM import_quarantine WHERE import_batch = ?').run(importBatch);
  return r.changes;
}

export function getAllQuarantine(
  portfolioId: string = 'default',
  limit: number = 100,
): (QuarantineRecord & { importBatch: string; fileName?: string })[] {
  const db = getDb(portfolioId);
  const rows = db
    .prepare('SELECT * FROM import_quarantine ORDER BY created_at DESC, row_number LIMIT ?')
    .all(limit) as any[];
  return rows.map((r) => ({
    importBatch: r.import_batch,
    rowNumber: r.row_number,
    severity: r.severity,
    reason: r.reason,
    message: r.message,
    raw: JSON.parse(r.raw_json),
    ...(r.parsed_json ? { parsed: JSON.parse(r.parsed_json) } : {}),
    ...(r.suggestions_json ? { suggestions: JSON.parse(r.suggestions_json) } : {}),
    fileName: r.file_name ?? undefined,
  }));
}
