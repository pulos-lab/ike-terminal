import { getDb } from './connection.js';
import type { StockSplit } from 'shared';

// UWAGA: to repo CELOWO nie woła bumpPortfolioDataVersion. Endpoint /history
// persystuje zmergowane splity przy każdym requeście — bump na poziomie repo
// unieważniałby memo historii permanentnie (każdy request = nowa wersja danych).
// Wersję podbijają routes: routes/portfolio.ts robi to tylko gdy detekcja
// znalazła faktycznie NOWE splity oraz przy ręcznych mutacjach splitów.
// Nie "naprawiaj" tego dodając bump tutaj.

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
    const rows = db
      .prepare('SELECT * FROM stock_splits WHERE isin = ? ORDER BY split_date')
      .all(isin) as SplitRow[];
    return rows.map(rowToSplit);
  }
  const rows = db
    .prepare('SELECT * FROM stock_splits ORDER BY ticker, split_date')
    .all() as SplitRow[];
  return rows.map(rowToSplit);
}

export function upsertSplits(portfolioId: string, splits: StockSplit[]): void {
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT INTO stock_splits (isin, ticker, split_date, ratio, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(isin, split_date) DO UPDATE SET
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

/**
 * Przepina zapisany split na inną datę (i ratio). Używane przez samonaprawę wpisów
 * zapisanych z datą zastępczą — wołający odpowiada za brak kolizji z
 * `UNIQUE(isin, split_date)` oraz za bump wersji danych (patrz uwaga na górze pliku).
 */
export function updateSplitDate(
  portfolioId: string,
  id: number,
  splitDate: string,
  ratio: number,
): boolean {
  const db = getDb(portfolioId);
  const result = db
    .prepare('UPDATE stock_splits SET split_date = ?, ratio = ? WHERE id = ?')
    .run(splitDate, ratio, id);
  return result.changes > 0;
}

export function deleteSplit(portfolioId: string, id: number): boolean {
  const db = getDb(portfolioId);
  const result = db.prepare('DELETE FROM stock_splits WHERE id = ?').run(id);
  return result.changes > 0;
}
