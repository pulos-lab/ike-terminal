import { getDb } from './connection.js';
import type { CashOperation, OperationType } from 'shared';

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
