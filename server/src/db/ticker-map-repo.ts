import { getDb } from './connection.js';
import { bumpPortfolioDataVersion } from './data-version.js';
import { TICKER_MAP, NAME_ALIASES } from 'shared';
import type { TickerMapEntry } from 'shared';

// Zapisy w ticker_map bumpują wersję danych portfela (data-version.ts) —
// zmiana resolvera (ticker/giełda/waluta/sektor) wpływa na wynik
// computePortfolioHistory, więc memo musi zostać unieważnione.

export function seedTickerMap(portfolioId: string = 'default'): void {
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ticker_map (isin, ticker, name, exchange, currency, price_source, sector, supersector, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedAll = db.transaction(() => {
    for (const entry of TICKER_MAP) {
      stmt.run(
        entry.isin,
        entry.ticker,
        entry.name,
        entry.exchange,
        entry.currency,
        entry.priceSource,
        entry.sector || null,
        entry.supersector || null,
        entry.country || null,
      );
    }
  });

  seedAll();
}

export function getTickerByIsin(
  isin: string,
  portfolioId: string = 'default',
): TickerMapEntry | null {
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
    supersector: row.supersector || undefined,
    country: row.country || undefined,
  };
}

export function getAllTickers(portfolioId: string = 'default'): TickerMapEntry[] {
  const db = getDb(portfolioId);
  const rows = db.prepare('SELECT * FROM ticker_map ORDER BY name').all() as any[];
  return rows.map((row) => ({
    isin: row.isin,
    ticker: row.ticker,
    name: row.name,
    exchange: row.exchange,
    currency: row.currency,
    priceSource: row.price_source,
    sector: row.sector || undefined,
    supersector: row.supersector || undefined,
    country: row.country || undefined,
  }));
}

export function getTickerMap(portfolioId: string = 'default'): Map<string, TickerMapEntry> {
  const entries = getAllTickers(portfolioId);
  return new Map(entries.map((e) => [e.isin, e]));
}

export function getTickerBySymbol(
  ticker: string,
  portfolioId: string = 'default',
): TickerMapEntry | null {
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
    supersector: row.supersector || undefined,
    country: row.country || undefined,
  };
}

/**
 * Reverse lookup: find ISIN by ticker name (e.g., "PKOBP" for mBank imports).
 * Searches name column with LIKE for partial matches.
 */
export function findIsinByName(
  tickerName: string,
  portfolioId: string = 'default',
): TickerMapEntry | null {
  const db = getDb(portfolioId);
  const upper = tickerName
    .toUpperCase()
    .replace(/-NC(?:-FIX)?$/i, '')
    .replace(/-C$/i, '')
    .trim();
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
  row = db
    .prepare("SELECT * FROM ticker_map WHERE UPPER(name) LIKE '%' || ? || '%'")
    .get(upper) as any;
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
    supersector: row.supersector || undefined,
    country: row.country || undefined,
  };
}

/**
 * One-time migration: switch GPW tickers from Stooq to Yahoo price source.
 * NewConnect (exchange='NC') stays on Stooq.
 * This reduces Stooq daily API usage by ~90%.
 */
export function migrateGpwToYahoo(portfolioId: string): number {
  const db = getDb(portfolioId);
  const result = db
    .prepare(
      `
    UPDATE ticker_map SET price_source = 'yahoo'
    WHERE exchange = 'GPW' AND price_source = 'stooq'
  `,
    )
    .run();
  return result.changes;
}

/** Insert or update a ticker_map entry.
 *
 * Anchor behavior (default `force = false`): if an entry already exists for
 * this ISIN, it is NOT overwritten. This protects against auto-resolve paths
 * silently flipping a ticker to a different Yahoo/Stooq symbol between runs
 * (which can cause historical price discontinuities and fake step-ups on the
 * portfolio chart).
 *
 * Pass `force: true` from explicitly user-initiated flows (UI ticker edit,
 * admin endpoint) that should intentionally overwrite the anchored entry.
 */
export function upsertTickerMapEntry(
  entry: TickerMapEntry,
  portfolioId: string = 'default',
  force: boolean = false,
): void {
  const db = getDb(portfolioId);
  if (!force) {
    const existing = getTickerByIsin(entry.isin, portfolioId);
    if (existing) return; // anchor — already resolved, do not overwrite
  }
  db.prepare(
    `
    INSERT OR REPLACE INTO ticker_map (isin, ticker, name, exchange, currency, price_source, sector, supersector, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    entry.isin,
    entry.ticker,
    entry.name,
    entry.exchange,
    entry.currency,
    entry.priceSource,
    entry.sector || null,
    entry.supersector || null,
    entry.country || null,
  );
  bumpPortfolioDataVersion(portfolioId);
}

/** Usuń wpis z ticker_map dla danego ISIN-u. Używane do czyszczenia legacy-stubów
 *  które blokują resolverowi znalezienie prawdziwego Yahoo tickera. */
export function deleteTickerMapEntry(isin: string, portfolioId: string = 'default'): boolean {
  const db = getDb(portfolioId);
  const res = db.prepare('DELETE FROM ticker_map WHERE isin = ?').run(isin);
  if (res.changes > 0) bumpPortfolioDataVersion(portfolioId);
  return res.changes > 0;
}

/** Update obu pól `sector` (podsektor) i `supersector` dla danego ISIN-u.
 *  Preferowana metoda po wprowadzeniu hybrydy nadsektor+podsektor ze stockwatch/GICS. */
export function updateTickerSectors(
  isin: string,
  supersector: string | null,
  subsector: string | null,
  portfolioId: string = 'default',
): boolean {
  const db = getDb(portfolioId);
  const res = db
    .prepare('UPDATE ticker_map SET sector = ?, supersector = ? WHERE isin = ?')
    .run(subsector, supersector, isin);
  if (res.changes > 0) bumpPortfolioDataVersion(portfolioId);
  return res.changes > 0;
}

/** Update kraju siedziby (Yahoo assetProfile.country / "Poland" dla GPW/NC/Catalyst).
 *  Osobno od updateTickerSectors, żeby backfill kraju nie nadpisywał ręcznie
 *  przypisanych sektorów. */
export function updateTickerCountry(
  isin: string,
  country: string,
  portfolioId: string = 'default',
): boolean {
  const db = getDb(portfolioId);
  const res = db.prepare('UPDATE ticker_map SET country = ? WHERE isin = ?').run(country, isin);
  if (res.changes > 0) bumpPortfolioDataVersion(portfolioId);
  return res.changes > 0;
}
