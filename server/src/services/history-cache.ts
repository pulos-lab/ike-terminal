/**
 * Persistent SQLite cache for historical price data.
 * Uses the price_cache table (ticker, date, close) already in the schema.
 * This survives server restarts and avoids hitting Stooq/Yahoo rate limits.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

let db: Database.Database | null = null;

function getHistoryDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(config.dataDir, 'price_history.db');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS price_history (
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        close REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        PRIMARY KEY (ticker, date)
      );
      CREATE INDEX IF NOT EXISTS idx_ph_ticker ON price_history(ticker);
    `);
  }
  return db;
}

/**
 * Store historical prices for a ticker in the persistent cache.
 */
export function storeHistoricalPrices(
  ticker: string,
  data: Array<{ date: string; close: number }>,
  source: string
): void {
  if (data.length === 0) return;
  const db = getHistoryDb();
  const insert = db.prepare(
    'INSERT OR REPLACE INTO price_history (ticker, date, close, source) VALUES (?, ?, ?, ?)'
  );
  const batch = db.transaction((items: Array<{ date: string; close: number }>) => {
    for (const item of items) {
      insert.run(ticker, item.date, item.close, source);
    }
  });
  batch(data);
}

/**
 * Load cached historical prices for a ticker from a given start date.
 */
export function loadHistoricalPrices(
  ticker: string,
  startDate?: string
): Array<{ date: string; close: number }> {
  const db = getHistoryDb();
  if (startDate) {
    return db
      .prepare('SELECT date, close FROM price_history WHERE ticker = ? AND date >= ? ORDER BY date')
      .all(ticker, startDate) as Array<{ date: string; close: number }>;
  }
  return db
    .prepare('SELECT date, close FROM price_history WHERE ticker = ? ORDER BY date')
    .all(ticker) as Array<{ date: string; close: number }>;
}

/**
 * Get the most recent date we have cached for a ticker.
 * Returns null if no data cached.
 */
export function getLastCachedDate(ticker: string): string | null {
  const db = getHistoryDb();
  const row = db
    .prepare('SELECT MAX(date) as maxDate FROM price_history WHERE ticker = ?')
    .get(ticker) as { maxDate: string | null } | undefined;
  return row?.maxDate || null;
}

/**
 * Check if we have sufficient cached data for a ticker in a date range.
 * "Sufficient" means at least some data points exist.
 */
export function hasCachedData(ticker: string, startDate: string): boolean {
  const db = getHistoryDb();
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM price_history WHERE ticker = ? AND date >= ?')
    .get(ticker, startDate) as { cnt: number };
  return row.cnt > 10;
}
