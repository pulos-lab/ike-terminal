import { getDb } from './connection.js';
import { TICKER_MAP, NAME_ALIASES } from 'shared';
import type { TickerMapEntry } from 'shared';

export function seedTickerMap(portfolioId: string = 'default'): void {
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ticker_map (isin, ticker, name, exchange, currency, price_source, sector)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const seedAll = db.transaction(() => {
    for (const entry of TICKER_MAP) {
      stmt.run(entry.isin, entry.ticker, entry.name, entry.exchange, entry.currency, entry.priceSource, entry.sector || null);
    }
  });

  seedAll();
}

export function getTickerByIsin(isin: string, portfolioId: string = 'default'): TickerMapEntry | null {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT * FROM ticker_map WHERE isin = ?').get(isin) as any;
  if (!row) return null;
  return {
    isin: row.isin,
    ticker: row.ticker,
    name: row.name,
    exchange: row.exchange,
    currency: row.currency,
    priceSource: row.price_source,
    sector: row.sector || undefined,
  };
}

export function getAllTickers(portfolioId: string = 'default'): TickerMapEntry[] {
  const db = getDb(portfolioId);
  const rows = db.prepare('SELECT * FROM ticker_map ORDER BY name').all() as any[];
  return rows.map(row => ({
    isin: row.isin,
    ticker: row.ticker,
    name: row.name,
    exchange: row.exchange,
    currency: row.currency,
    priceSource: row.price_source,
    sector: row.sector || undefined,
  }));
}

export function getTickerMap(portfolioId: string = 'default'): Map<string, TickerMapEntry> {
  const entries = getAllTickers(portfolioId);
  return new Map(entries.map(e => [e.isin, e]));
}

export function getTickerBySymbol(ticker: string, portfolioId: string = 'default'): TickerMapEntry | null {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT * FROM ticker_map WHERE ticker = ?').get(ticker) as any;
  if (!row) return null;
  return {
    isin: row.isin,
    ticker: row.ticker,
    name: row.name,
    exchange: row.exchange,
    currency: row.currency,
    priceSource: row.price_source,
    sector: row.sector || undefined,
  };
}

/**
 * Reverse lookup: find ISIN by ticker name (e.g., "PKOBP" for mBank imports).
 * Searches name column with LIKE for partial matches.
 */
export function findIsinByName(tickerName: string, portfolioId: string = 'default'): TickerMapEntry | null {
  const db = getDb(portfolioId);
  const upper = tickerName.toUpperCase().replace(/-NC(?:-FIX)?$/i, '').replace(/-C$/i, '').trim();
  // Check name aliases first (company renames: LIVECHAT → Text, ONCOARENDI → Molecure)
  const aliasIsin = NAME_ALIASES[upper];
  if (aliasIsin) {
    const entry = getTickerByIsin(aliasIsin, portfolioId);
    if (entry) return entry;
  }
  // Exact name match first
  let row = db.prepare('SELECT * FROM ticker_map WHERE UPPER(name) = ?').get(upper) as any;
  if (row) return mapTickerRow(row);
  // Try matching ticker column (e.g., "CDR.WA" starts with "CDR.")
  row = db.prepare("SELECT * FROM ticker_map WHERE UPPER(ticker) LIKE ? || '.%'").get(upper) as any;
  if (row) return mapTickerRow(row);
  // Try name LIKE match
  row = db.prepare("SELECT * FROM ticker_map WHERE UPPER(name) LIKE '%' || ? || '%'").get(upper) as any;
  if (row) return mapTickerRow(row);
  return null;
}

function mapTickerRow(row: any): TickerMapEntry {
  return {
    isin: row.isin,
    ticker: row.ticker,
    name: row.name,
    exchange: row.exchange,
    currency: row.currency,
    priceSource: row.price_source,
    sector: row.sector || undefined,
  };
}

export function upsertTickerMapEntry(entry: TickerMapEntry, portfolioId: string = 'default'): void {
  const db = getDb(portfolioId);
  db.prepare(`
    INSERT OR REPLACE INTO ticker_map (isin, ticker, name, exchange, currency, price_source, sector)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entry.isin, entry.ticker, entry.name, entry.exchange, entry.currency, entry.priceSource, entry.sector || null);
}
