import { getDb } from './connection.js';

export interface ImportBatchInfo {
  importBatch: string;
  transactionsCount: number;
  operationsCount: number;
  quarantineCount: number;
  firstDate: string | null;
  sources: string[];
  warnings: string[];
  skippedCount: number;
}

export function getAllImportBatches(
  portfolioId: string = 'default',
  limit: number = 50,
): ImportBatchInfo[] {
  const db = getDb(portfolioId);

  // UNION all distinct import_batch values from transactions and operations
  const rows = db
    .prepare(
      `SELECT
        b.import_batch,
        COALESCE(t.cnt, 0) AS transactions_count,
        COALESCE(o.cnt, 0) AS operations_count,
        COALESCE(q.cnt, 0) AS quarantine_count,
        b.first_date,
        b.sources,
        m.result_json
      FROM (
        SELECT import_batch, MIN(date) AS first_date, GROUP_CONCAT(DISTINCT source) AS sources
        FROM (
          SELECT import_batch, date, source FROM transactions WHERE import_batch IS NOT NULL
          UNION ALL
          SELECT import_batch, date, source FROM cash_operations WHERE import_batch IS NOT NULL
        )
        GROUP BY import_batch
      ) b
      LEFT JOIN (SELECT import_batch, COUNT(*) AS cnt FROM transactions GROUP BY import_batch) t
        ON t.import_batch = b.import_batch
      LEFT JOIN (SELECT import_batch, COUNT(*) AS cnt FROM cash_operations GROUP BY import_batch) o
        ON o.import_batch = b.import_batch
      LEFT JOIN (SELECT import_batch, COUNT(*) AS cnt FROM import_quarantine GROUP BY import_batch) q
        ON q.import_batch = b.import_batch
      LEFT JOIN import_batch_meta m ON m.import_batch = b.import_batch
      ORDER BY b.first_date DESC
      LIMIT ?`,
    )
    .all(limit) as any[];

  return rows.map((r) => {
    const result = r.result_json ? (JSON.parse(r.result_json) as Record<string, unknown>) : {};
    const skipped = result.skipped as Array<unknown> | undefined;
    const warnings = result.warnings as string[] | undefined;
    const crossFileWarnings = result.crossFileWarnings as string[] | undefined;
    return {
      importBatch: r.import_batch,
      transactionsCount: r.transactions_count,
      operationsCount: r.operations_count,
      quarantineCount: r.quarantine_count,
      firstDate: r.first_date,
      sources: r.sources ? r.sources.split(',') : [],
      warnings: [...(warnings ?? []), ...(crossFileWarnings ?? [])],
      skippedCount: skipped?.length ?? 0,
    };
  });
}
