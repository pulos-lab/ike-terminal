import { getDb } from './connection.js';

export function upsertImportBatchMeta(
  portfolioId: string,
  importBatch: string,
  result: Record<string, unknown>,
): void {
  const pdb = getDb(portfolioId);
  pdb
    .prepare(
      `INSERT INTO import_batch_meta (import_batch, result_json)
     VALUES (?, ?)
     ON CONFLICT(import_batch) DO UPDATE SET
       result_json = excluded.result_json`,
    )
    .run(importBatch, JSON.stringify(result));
}

export function getImportBatchMeta(
  portfolioId: string,
  importBatch: string,
): Record<string, unknown> | null {
  const pdb = getDb(portfolioId);
  const row = pdb
    .prepare('SELECT result_json FROM import_batch_meta WHERE import_batch = ?')
    .get(importBatch) as { result_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.result_json) as Record<string, unknown>;
}

export function deleteImportBatchMeta(portfolioId: string, importBatch: string): void {
  const pdb = getDb(portfolioId);
  pdb.prepare('DELETE FROM import_batch_meta WHERE import_batch = ?').run(importBatch);
}
