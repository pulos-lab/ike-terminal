import { getDb } from './connection.js';
import type { Transaction } from 'shared';

export function insertTransactions(transactions: Transaction[], portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT INTO transactions (date, paper_name, isin, quantity, side, price, value, commission, total, currency, source, import_batch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((txs: Transaction[]) => {
    let count = 0;
    for (const tx of txs) {
      stmt.run(tx.date, tx.paperName, tx.isin, tx.quantity, tx.side, tx.price, tx.value, tx.commission, tx.total, tx.currency, tx.source, tx.importBatch);
      count++;
    }
    return count;
  });

  return insertMany(transactions);
}

export function getAllTransactions(portfolioId: string = 'default'): Transaction[] {
  const db = getDb(portfolioId);
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date DESC').all() as any[];
  return rows.map(mapRow);
}

export function getTransactionsByIsin(isin: string, portfolioId: string = 'default'): Transaction[] {
  const db = getDb(portfolioId);
  const rows = db.prepare('SELECT * FROM transactions WHERE isin = ? ORDER BY date ASC').all(isin) as any[];
  return rows.map(mapRow);
}

export function getTransactionsCount(portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as any;
  return row.count;
}

export function clearTransactions(portfolioId: string = 'default'): void {
  const db = getDb(portfolioId);
  db.prepare('DELETE FROM transactions').run();
}

export function getTransactionById(id: number, portfolioId: string = 'default'): Transaction | null {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : null;
}

export function insertTransaction(tx: Transaction, portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  const result = db.prepare(`
    INSERT INTO transactions (date, paper_name, isin, quantity, side, price, value, commission, total, currency, source, import_batch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tx.date, tx.paperName, tx.isin, tx.quantity, tx.side, tx.price, tx.value, tx.commission, tx.total, tx.currency, tx.source, tx.importBatch || null);
  return Number(result.lastInsertRowid);
}

export function updateTransaction(id: number, updates: Partial<Transaction>, portfolioId: string = 'default'): boolean {
  const db = getDb(portfolioId);
  const existing = getTransactionById(id, portfolioId);
  if (!existing) return false;

  const merged = { ...existing, ...updates };
  const result = db.prepare(`
    UPDATE transactions SET date = ?, paper_name = ?, isin = ?, quantity = ?, side = ?, price = ?, value = ?, commission = ?, total = ?, currency = ?, source = ?
    WHERE id = ?
  `).run(merged.date, merged.paperName, merged.isin, merged.quantity, merged.side, merged.price, merged.value, merged.commission, merged.total, merged.currency, merged.source, id);
  return result.changes > 0;
}

export function deleteTransaction(id: number, portfolioId: string = 'default'): boolean {
  const db = getDb(portfolioId);
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getLastImportDate(portfolioId: string = 'default'): string | null {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT MAX(created_at) as last_import FROM transactions WHERE import_batch IS NOT NULL').get() as any;
  return row?.last_import || null;
}

function mapRow(row: any): Transaction {
  return {
    id: row.id,
    date: row.date,
    paperName: row.paper_name,
    isin: row.isin,
    quantity: row.quantity,
    side: row.side,
    price: row.price,
    value: row.value,
    commission: row.commission,
    total: row.total,
    currency: row.currency,
    source: row.source,
    importBatch: row.import_batch,
  };
}
