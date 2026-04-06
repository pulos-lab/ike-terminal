import { getDb } from './connection.js';
import type { StockSplit } from 'shared';

interface SplitRow {
  id: number;
  isin: string;
  ticker: string;
  split_date: string;
  ratio: number;
  source: string;
  detected_at: string;
}

function rowToSplit(row: SplitRow): StockSplit {
  return {
    id: row.id,
    isin: row.isin,
    ticker: row.ticker,
    splitDate: row.split_date,
    ratio: row.ratio,
    source: row.source as 'auto' | 'manual',
    detectedAt: row.detected_at,
  };
}

export function getSplits(portfolioId: string, isin?: string): StockSplit[] {
  const db = getDb(portfolioId);
  if (isin) {
    const rows = db.prepare('SELECT * FROM stock_splits WHERE isin = ? ORDER BY split_date').all(isin) as SplitRow[];
    return rows.map(rowToSplit);
  }
  const rows = db.prepare('SELECT * FROM stock_splits ORDER BY ticker, split_date').all() as SplitRow[];
  return rows.map(rowToSplit);
}

export function upsertSplit(portfolioId: string, split: StockSplit): void {
  const db = getDb(portfolioId);
  db.prepare(`
    INSERT INTO stock_splits (isin, ticker, split_date, ratio, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(isin) DO UPDATE SET
      split_date = excluded.split_date,
      ratio = excluded.ratio,
      ticker = excluded.ticker,
      source = excluded.source
  `).run(split.isin, split.ticker, split.splitDate, split.ratio, split.source);
}

export function upsertSplits(portfolioId: string, splits: StockSplit[]): void {
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT INTO stock_splits (isin, ticker, split_date, ratio, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(isin) DO UPDATE SET
      split_date = excluded.split_date,
      ratio = excluded.ratio,
      ticker = excluded.ticker,
      source = excluded.source
  `);
  const insertMany = db.transaction((items: StockSplit[]) => {
    for (const s of items) {
      stmt.run(s.isin, s.ticker, s.splitDate, s.ratio, s.source);
    }
  });
  insertMany(splits);
}

export function deleteSplit(portfolioId: string, id: number): boolean {
  const db = getDb(portfolioId);
  const result = db.prepare('DELETE FROM stock_splits WHERE id = ?').run(id);
  return result.changes > 0;
}
