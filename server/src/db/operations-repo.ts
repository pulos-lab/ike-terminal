import { getDb } from './connection.js';
import type { CashOperation, OperationType, SkippedRow } from 'shared';
import type { InsertWithDedupResult } from './transactions-repo.js';

export function insertOperations(operations: CashOperation[], portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT INTO cash_operations (date, operation_type, description, details, amount, currency, ticker, fx_rate, fx_pair, source, import_batch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((ops: CashOperation[]) => {
    let count = 0;
    for (const op of ops) {
      stmt.run(op.date, op.operationType, op.description, op.details || null, op.amount, op.currency, op.ticker || null, op.fxRate || null, op.fxPair || null, op.source, op.importBatch);
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
    INSERT INTO cash_operations (date, operation_type, description, details, amount, currency, ticker, fx_rate, fx_pair, source, import_batch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        sample.date, sample.operationType, sample.amount, sample.currency, ticker, ticker,
      ) as { cnt: number };

      const toInsert = Math.max(0, opGroup.length - existingCount);

      for (let i = 0; i < toInsert; i++) {
        const op = opGroup[i];
        insertStmt.run(op.date, op.operationType, op.description, op.details || null, op.amount, op.currency, op.ticker || null, op.fxRate || null, op.fxPair || null, op.source, op.importBatch);
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

export function getOperationsByType(type: OperationType, portfolioId: string = 'default'): CashOperation[] {
  const db = getDb(portfolioId);
  const rows = db.prepare('SELECT * FROM cash_operations WHERE operation_type = ? ORDER BY date DESC').all(type) as any[];
  return rows.map(mapRow);
}

export function getOperationsByTypes(types: OperationType[], portfolioId: string = 'default'): CashOperation[] {
  const db = getDb(portfolioId);
  const placeholders = types.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM cash_operations WHERE operation_type IN (${placeholders}) ORDER BY date DESC`).all(...types) as any[];
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

export function getOperationById(id: number, portfolioId: string = 'default'): CashOperation | null {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT * FROM cash_operations WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : null;
}

export function insertOperation(op: CashOperation, portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  const result = db.prepare(`
    INSERT INTO cash_operations (date, operation_type, description, details, amount, currency, ticker, fx_rate, fx_pair, source, import_batch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(op.date, op.operationType, op.description, op.details || null, op.amount, op.currency, op.ticker || null, op.fxRate || null, op.fxPair || null, op.source, op.importBatch || null);
  return Number(result.lastInsertRowid);
}

export function updateOperation(id: number, op: Partial<CashOperation>, portfolioId: string = 'default'): boolean {
  const db = getDb(portfolioId);
  const existing = getOperationById(id, portfolioId);
  if (!existing) return false;

  const merged = { ...existing, ...op };
  const result = db.prepare(`
    UPDATE cash_operations SET date = ?, operation_type = ?, description = ?, details = ?, amount = ?, currency = ?, ticker = ?, fx_rate = ?, fx_pair = ?, source = ?
    WHERE id = ?
  `).run(merged.date, merged.operationType, merged.description, merged.details || null, merged.amount, merged.currency, merged.ticker || null, merged.fxRate || null, merged.fxPair || null, merged.source, id);
  return result.changes > 0;
}

export function deleteOperation(id: number, portfolioId: string = 'default'): boolean {
  const db = getDb(portfolioId);
  const result = db.prepare('DELETE FROM cash_operations WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Check if a dividend already exists for a given date and ticker (any source).
 * Used by dividend-scanner to avoid duplicating broker-imported dividends.
 */
export function dividendExistsForDateAndTicker(
  portfolioId: string,
  date: string,
  ticker: string
): boolean {
  const db = getDb(portfolioId);
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM cash_operations
     WHERE date = ? AND operation_type = 'dividend' AND ticker = ?`
  ).get(date, ticker) as { cnt: number };
  return row.cnt > 0;
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
  };
}
