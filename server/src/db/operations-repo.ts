import { getDb } from './connection.js';
import type { CashOperation, OperationType, SkippedRow } from 'shared';
import type { InsertWithDedupResult } from './transactions-repo.js';

export function insertOperations(
  operations: CashOperation[],
  portfolioId: string = 'default',
): number {
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT INTO cash_operations (date, operation_type, description, details, amount, currency, ticker, fx_rate, fx_pair, source, import_batch, subkind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((ops: CashOperation[]) => {
    let count = 0;
    for (const op of ops) {
      stmt.run(
        op.date,
        op.operationType,
        op.description,
        op.details || null,
        op.amount,
        op.currency,
        op.ticker || null,
        op.fxRate || null,
        op.fxPair || null,
        op.source,
        op.importBatch,
        op.subkind || null,
      );
      count++;
    }
    return count;
  });

  return insertMany(operations);
}

/** Insert operations with duplicate detection (count-based). */
export function insertOperationsWithDedup(
  operations: CashOperation[],
  portfolioId: string = 'default',
): InsertWithDedupResult {
  const db = getDb(portfolioId);

  const countStmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM cash_operations
    WHERE date = ? AND operation_type = ? AND amount = ? AND currency = ?
      AND (ticker IS ? OR (ticker IS NULL AND ? IS NULL))
  `);
  const insertStmt = db.prepare(`
    INSERT INTO cash_operations (date, operation_type, description, details, amount, currency, ticker, fx_rate, fx_pair, source, import_batch, subkind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Group by dedup key
  const groups = new Map<string, CashOperation[]>();
  for (const op of operations) {
    const key = `${op.date}|${op.operationType}|${op.amount}|${op.currency}|${op.ticker || ''}`;
    const group = groups.get(key);
    if (group) group.push(op);
    else groups.set(key, [op]);
  }

  const duplicates: SkippedRow[] = [];
  let inserted = 0;

  db.transaction(() => {
    for (const [, opGroup] of groups) {
      const sample = opGroup[0];
      const ticker = sample.ticker || null;
      const { cnt: existingCount } = countStmt.get(
        sample.date,
        sample.operationType,
        sample.amount,
        sample.currency,
        ticker,
        ticker,
      ) as { cnt: number };

      const toInsert = Math.max(0, opGroup.length - existingCount);

      for (let i = 0; i < toInsert; i++) {
        const op = opGroup[i];
        insertStmt.run(
          op.date,
          op.operationType,
          op.description,
          op.details || null,
          op.amount,
          op.currency,
          op.ticker || null,
          op.fxRate || null,
          op.fxPair || null,
          op.source,
          op.importBatch,
          op.subkind || null,
        );
        inserted++;
      }

      for (let i = toInsert; i < opGroup.length; i++) {
        duplicates.push({ row: 0, reason: 'duplicate', paperName: opGroup[i].description });
      }
    }
  })();

  return { inserted, duplicates };
}

export function getAllOperations(portfolioId: string = 'default'): CashOperation[] {
  const db = getDb(portfolioId);
  const rows = db.prepare('SELECT * FROM cash_operations ORDER BY date DESC').all() as any[];
  return rows.map(mapRow);
}

export function getOperationsByType(
  type: OperationType,
  portfolioId: string = 'default',
): CashOperation[] {
  const db = getDb(portfolioId);
  const rows = db
    .prepare('SELECT * FROM cash_operations WHERE operation_type = ? ORDER BY date DESC')
    .all(type) as any[];
  return rows.map(mapRow);
}

export function getOperationsByTypes(
  types: OperationType[],
  portfolioId: string = 'default',
): CashOperation[] {
  const db = getDb(portfolioId);
  const placeholders = types.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM cash_operations WHERE operation_type IN (${placeholders}) ORDER BY date DESC`,
    )
    .all(...types) as any[];
  return rows.map(mapRow);
}

export function getOperationsCount(portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT COUNT(*) as count FROM cash_operations').get() as any;
  return row.count;
}

export function clearOperations(portfolioId: string = 'default'): void {
  const db = getDb(portfolioId);
  db.prepare('DELETE FROM cash_operations').run();
}

/** Usuwa wyłącznie wiersze z importów (import_batch ustawiony) — ręczne wpisy zostają. */
export function clearImportedOperations(portfolioId: string = 'default'): void {
  const db = getDb(portfolioId);
  db.prepare('DELETE FROM cash_operations WHERE import_batch IS NOT NULL').run();
}

export function getOperationById(
  id: number,
  portfolioId: string = 'default',
): CashOperation | null {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT * FROM cash_operations WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : null;
}

export function insertOperation(op: CashOperation, portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  const result = db
    .prepare(
      `
    INSERT INTO cash_operations (date, operation_type, description, details, amount, currency, ticker, fx_rate, fx_pair, source, import_batch, subkind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      op.date,
      op.operationType,
      op.description,
      op.details || null,
      op.amount,
      op.currency,
      op.ticker || null,
      op.fxRate || null,
      op.fxPair || null,
      op.source,
      op.importBatch || null,
      op.subkind || null,
    );
  return Number(result.lastInsertRowid);
}

export function updateOperation(
  id: number,
  op: Partial<CashOperation>,
  portfolioId: string = 'default',
): boolean {
  const db = getDb(portfolioId);
  const existing = getOperationById(id, portfolioId);
  if (!existing) return false;

  const merged = { ...existing, ...op };
  const result = db
    .prepare(
      `
    UPDATE cash_operations SET date = ?, operation_type = ?, description = ?, details = ?, amount = ?, currency = ?, ticker = ?, fx_rate = ?, fx_pair = ?, source = ?, subkind = ?
    WHERE id = ?
  `,
    )
    .run(
      merged.date,
      merged.operationType,
      merged.description,
      merged.details || null,
      merged.amount,
      merged.currency,
      merged.ticker || null,
      merged.fxRate || null,
      merged.fxPair || null,
      merged.source,
      merged.subkind || null,
      id,
    );
  return result.changes > 0;
}

export function deleteOperation(id: number, portfolioId: string = 'default'): boolean {
  const db = getDb(portfolioId);
  const result = db.prepare('DELETE FROM cash_operations WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Check if a dividend already exists for a given date and ticker (any source).
 * Handles mismatches between broker imports and auto-scanner:
 * - Date: ±30 day window (ex-dividend date vs payment date can differ by weeks)
 * - Ticker: matches with and without exchange suffix (Bossa: "PLAYWAY", Yahoo: "PLAYWAY.WA")
 */
export function dividendExistsForDateAndTicker(
  portfolioId: string,
  date: string,
  ticker: string,
): boolean {
  const db = getDb(portfolioId);
  const datePrefix = date.split('T')[0];
  const baseTicker = ticker.replace(/\.\w+$/, ''); // "PLAYWAY.WA" → "PLAYWAY"

  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM cash_operations
     WHERE operation_type = 'dividend'
       AND (ticker = ? OR ticker = ?)
       AND abs(julianday(substr(date, 1, 10)) - julianday(?)) <= 30`,
    )
    .get(ticker, baseTicker, datePrefix) as { cnt: number };
  return row.cnt > 0;
}

/**
 * Get the date of the most recent dividend in the portfolio (any source).
 * Used by dividend-scanner to determine scan start date.
 */
export function getLatestDividendDate(portfolioId: string): string | null {
  const db = getDb(portfolioId);
  const row = db
    .prepare(
      `SELECT MAX(substr(date, 1, 10)) as latest FROM cash_operations
     WHERE operation_type = 'dividend'`,
    )
    .get() as { latest: string | null };
  return row.latest || null;
}

// ── Portfolio metadata (key-value store per portfolio) ──────────────────────

export function getMetadata(portfolioId: string, key: string): string | null {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT value FROM portfolio_metadata WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMetadata(portfolioId: string, key: string, value: string): void {
  const db = getDb(portfolioId);
  db.prepare('INSERT OR REPLACE INTO portfolio_metadata (key, value) VALUES (?, ?)').run(
    key,
    value,
  );
}

function mapRow(row: any): CashOperation {
  return {
    id: row.id,
    date: row.date,
    operationType: row.operation_type as OperationType,
    description: row.description,
    details: row.details,
    amount: row.amount,
    currency: row.currency,
    ticker: row.ticker,
    fxRate: row.fx_rate,
    fxPair: row.fx_pair,
    source: row.source,
    importBatch: row.import_batch,
    subkind: row.subkind ?? undefined,
  };
}
