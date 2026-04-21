import { getDb } from './connection.js';
import type { Transaction, SkippedRow, OrphanedSell } from 'shared';

export function insertTransactions(transactions: Transaction[], portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT INTO transactions (date, paper_name, isin, quantity, side, price, value, commission, total, currency, payment_currency, fx_rate, category, source, import_batch, swap, rollover, cfd_position_id, cfd_gross_profit, synthetic_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((txs: Transaction[]) => {
    let count = 0;
    for (const tx of txs) {
      stmt.run(tx.date, tx.paperName, tx.isin, tx.quantity, tx.side, tx.price, tx.value, tx.commission, tx.total, tx.currency, tx.paymentCurrency ?? tx.currency, tx.fxRate ?? null, tx.category || 'stock', tx.source, tx.importBatch, tx.swap ?? null, tx.rollover ?? null, tx.cfdPositionId ?? null, tx.cfdGrossProfit ?? null, tx.syntheticOrigin ?? null);
      count++;
    }
    return count;
  });

  return insertMany(transactions);
}

export interface InsertWithDedupResult {
  inserted: number;
  duplicates: SkippedRow[];
}

/** Insert transactions with duplicate detection (count-based). */
export function insertTransactionsWithDedup(
  transactions: Transaction[],
  portfolioId: string = 'default',
): InsertWithDedupResult {
  const db = getDb(portfolioId);

  const countStmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM transactions
    WHERE date = ? AND isin = ? AND side = ? AND quantity = ? AND price = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO transactions (date, paper_name, isin, quantity, side, price, value, commission, total, currency, payment_currency, fx_rate, category, source, import_batch, swap, rollover, cfd_position_id, cfd_gross_profit, synthetic_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Group by dedup key
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const key = `${tx.date}|${tx.isin}|${tx.side}|${tx.quantity}|${tx.price}`;
    const group = groups.get(key);
    if (group) group.push(tx);
    else groups.set(key, [tx]);
  }

  const duplicates: SkippedRow[] = [];
  let inserted = 0;

  db.transaction(() => {
    for (const [, txGroup] of groups) {
      const sample = txGroup[0];
      const { cnt: existingCount } = countStmt.get(
        sample.date, sample.isin, sample.side, sample.quantity, sample.price,
      ) as { cnt: number };

      const toInsert = Math.max(0, txGroup.length - existingCount);

      for (let i = 0; i < toInsert; i++) {
        const tx = txGroup[i];
        insertStmt.run(tx.date, tx.paperName, tx.isin, tx.quantity, tx.side, tx.price, tx.value, tx.commission, tx.total, tx.currency, tx.paymentCurrency ?? tx.currency, tx.fxRate ?? null, tx.category || 'stock', tx.source, tx.importBatch, tx.swap ?? null, tx.rollover ?? null, tx.cfdPositionId ?? null, tx.cfdGrossProfit ?? null, tx.syntheticOrigin ?? null);
        inserted++;
      }

      for (let i = toInsert; i < txGroup.length; i++) {
        duplicates.push({ row: 0, reason: 'duplicate', paperName: txGroup[i].paperName });
      }
    }
  })();

  return { inserted, duplicates };
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

/** Purge ALL data from a portfolio database (transactions, operations, ticker map, snapshots, etc.) */
export function purgeAllData(portfolioId: string = 'default'): void {
  const db = getDb(portfolioId);
  db.transaction(() => {
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM cash_operations').run();
    db.prepare('DELETE FROM ticker_map').run();
    db.prepare('DELETE FROM portfolio_snapshots').run();
    db.prepare('DELETE FROM manual_positions').run();
    db.prepare('DELETE FROM price_cache').run();
  })();
}

export function getTransactionById(id: number, portfolioId: string = 'default'): Transaction | null {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : null;
}

export function insertTransaction(tx: Transaction, portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  const result = db.prepare(`
    INSERT INTO transactions (date, paper_name, isin, quantity, side, price, value, commission, total, currency, payment_currency, fx_rate, category, source, import_batch, swap, rollover, cfd_position_id, cfd_gross_profit, synthetic_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tx.date, tx.paperName, tx.isin, tx.quantity, tx.side, tx.price, tx.value, tx.commission, tx.total, tx.currency, tx.paymentCurrency ?? tx.currency, tx.fxRate ?? null, tx.category || 'stock', tx.source, tx.importBatch || null, tx.swap ?? null, tx.rollover ?? null, tx.cfdPositionId ?? null, tx.cfdGrossProfit ?? null, tx.syntheticOrigin ?? null);
  return Number(result.lastInsertRowid);
}

export function updateTransaction(id: number, updates: Partial<Transaction>, portfolioId: string = 'default'): boolean {
  const db = getDb(portfolioId);
  const existing = getTransactionById(id, portfolioId);
  if (!existing) return false;

  const merged = { ...existing, ...updates };
  const result = db.prepare(`
    UPDATE transactions SET date = ?, paper_name = ?, isin = ?, quantity = ?, side = ?, price = ?, value = ?, commission = ?, total = ?, currency = ?, payment_currency = ?, fx_rate = ?, category = ?, source = ?
    WHERE id = ?
  `).run(merged.date, merged.paperName, merged.isin, merged.quantity, merged.side, merged.price, merged.value, merged.commission, merged.total, merged.currency, merged.paymentCurrency ?? merged.currency, merged.fxRate ?? null, merged.category || 'stock', merged.source, id);
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

/** Detect ISINs where total sold > total bought (excluding CFD positions). */
export function detectOrphanedSells(portfolioId: string = 'default'): OrphanedSell[] {
  const db = getDb(portfolioId);
  const rows = db.prepare(`
    SELECT t.paper_name, t.isin, t.currency,
      SUM(CASE WHEN t.side = 'K' THEN t.quantity ELSE 0 END) as bought,
      SUM(CASE WHEN t.side = 'S' THEN t.quantity ELSE 0 END) as sold,
      MIN(CASE WHEN t.side = 'S' THEN t.date END) as first_sell,
      tm.ticker
    FROM transactions t
    LEFT JOIN ticker_map tm ON t.isin = tm.isin
    WHERE t.category != 'cfd'
    GROUP BY t.isin
    HAVING sold > bought + 0.001
  `).all() as any[];
  return rows.map(r => ({
    paperName: r.paper_name,
    isin: r.isin,
    ticker: r.ticker || r.isin,
    missingQuantity: Math.round((r.sold - r.bought) * 10000) / 10000,
    firstSellDate: r.first_sell,
    currency: r.currency,
  }));
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
    paymentCurrency: row.payment_currency ?? row.currency,
    fxRate: row.fx_rate ?? undefined,
    category: row.category || 'stock',
    source: row.source,
    importBatch: row.import_batch,
    swap: row.swap || undefined,
    rollover: row.rollover || undefined,
    cfdPositionId: row.cfd_position_id || undefined,
    cfdGrossProfit: row.cfd_gross_profit ?? undefined,
    syntheticOrigin: row.synthetic_origin ?? undefined,
  };
}
