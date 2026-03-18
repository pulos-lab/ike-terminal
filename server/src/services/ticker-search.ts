import { getCached, setCached } from './price-cache.js';
import { getAllTickers } from '../db/ticker-map-repo.js';
import type { TickerSearchResult } from 'shared';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/**
 * Search Yahoo Finance for ticker symbols
 */
export async function searchYahoo(query: string): Promise<TickerSearchResult[]> {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`;
    const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return [];
    const json = await resp.json();
    const quotes: any[] = json?.quotes || [];
    return quotes
      .filter((q: any) => q.typeDisp === 'Equity' || q.quoteType === 'EQUITY' || q.typeDisp === 'ETF' || q.quoteType === 'ETF')
      .map((q: any) => ({
        symbol: q.symbol,
        name: q.longname || q.shortname || q.symbol,
        exchange: q.exchDisp || q.exchange || 'UNKNOWN',
        currency: undefined, // Yahoo search doesn't return currency
      }));
  } catch (error) {
    console.error('Yahoo search failed:', error);
    return [];
  }
}

/**
 * Validate a ticker on Stooq (Polish GPW + NewConnect)
 * Returns a result if the ticker exists on Stooq
 */
export async function validateStooq(query: string, expectedName?: string): Promise<TickerSearchResult | null> {
  // Only try for short, simple tickers (likely Polish)
  const raw = query.replace('.WA', '').toLowerCase();
  if (raw.length > 20 || raw.includes('.') || raw.includes(' ')) return null;

  try {
    // Include 'n' (name) field to validate against expected paper name
    const url = `https://stooq.pl/q/l/?s=${raw}&f=sd2t2ohlcvn&h&e=csv`;
    const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const text = await resp.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;

    const values = lines[1].split(',');
    // Stooq returns "N/D" or "B/D" for non-existent/suspended tickers
    const ticker = values[0];
    if (!ticker || ticker === 'N/D' || values.some(v => v === 'N/D' || v === 'B/D')) return null;

    // The name field is the last value (index 8 with format sd2t2ohlcvn)
    const stooqName = (values[8] || '').trim().toUpperCase();

    // If an expected name is provided, verify the Stooq company name
    // matches to avoid false positives (e.g. "MOL" = MOL Magyar, not Molecure)
    if (expectedName && stooqName) {
      const expected = expectedName.toUpperCase();
      // Require that one name starts with the other AND they share
      // at least 4 characters (or entire shorter name if < 4 chars)
      const minLen = Math.min(stooqName.length, expected.length);
      const overlapLen = Math.min(minLen, 4);
      const nameMatches =
        stooqName === expected ||
        (stooqName.startsWith(expected.substring(0, overlapLen)) && minLen >= 4) ||
        (expected.startsWith(stooqName.substring(0, overlapLen)) && minLen >= 4);
      if (!nameMatches) return null;
    }

    return {
      symbol: `${raw.toUpperCase()}.WA`,
      name: stooqName || raw.toUpperCase(),
      exchange: 'GPW/NC',
      currency: 'PLN',
    };
  } catch {
    return null;
  }
}

/**
 * Search Stooq by company name. Returns ticker symbol.
 * Uses /cmp/?q= endpoint which matches by company name, not ticker symbol.
 * Useful when mBank paper names (e.g. POLHOLROZ) don't match Stooq symbols (e.g. prh).
 */
export async function searchStooqByName(companyName: string): Promise<TickerSearchResult | null> {
  const query = companyName.toLowerCase().replace(/\s+/g, '');
  if (query.length < 2) return null;

  try {
    const url = `https://stooq.pl/cmp/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const text = await resp.text();

    // Parse: window.cmp_r('PRH~Polski Holding Rozwoju SA~XNCO~2.88~-0.69%~2|...')
    const match = text.match(/cmp_r\('(.+?)'\)/);
    if (!match) return null;

    const entries = match[1].split('|');
    for (const entry of entries) {
      const parts = entry.split('~');
      // Strip HTML tags from all parts (Stooq wraps matched text in <b> tags)
      const ticker = (parts[0] || '').replace(/<\/?b>/gi, '');
      const name = (parts[1] || '').replace(/<\/?b>/gi, '');
      const exchange = parts[2] || '';
      if (!ticker || ticker.includes('_') || ticker.includes('.')) continue;
      if (exchange !== 'XWAR' && exchange !== 'XNCO') continue;

      return {
        symbol: `${ticker.toUpperCase()}.WA`,
        name: name || ticker,
        exchange: exchange === 'XNCO' ? 'NC' : 'GPW',
        currency: 'PLN',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Search local ticker_map database
 */
function searchLocal(query: string): TickerSearchResult[] {
  const lower = query.toLowerCase();
  const all = getAllTickers();
  return all
    .filter(t =>
      t.ticker.toLowerCase().includes(lower) ||
      t.name.toLowerCase().includes(lower) ||
      t.isin.toLowerCase().includes(lower)
    )
    .map(t => ({
      symbol: t.ticker,
      name: t.name,
      exchange: t.exchange,
      currency: t.currency,
    }));
}

/**
 * Search tickers across Yahoo, Stooq, and local database
 */
export async function searchTickers(query: string): Promise<TickerSearchResult[]> {
  if (!query || query.length < 1) return [];

  const cacheKey = `ticker_search_${query.toLowerCase()}`;
  const cached = getCached<TickerSearchResult[]>(cacheKey);
  if (cached) return cached;

  // Run all three searches in parallel
  const [yahooResults, stooqResult, localResults] = await Promise.all([
    searchYahoo(query),
    validateStooq(query),
    Promise.resolve(searchLocal(query)),
  ]);

  // Merge and deduplicate by symbol
  const seen = new Set<string>();
  const results: TickerSearchResult[] = [];

  // Local results first (most relevant for existing portfolio)
  for (const r of localResults) {
    const key = r.symbol.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(r);
    }
  }

  // Stooq result (Polish stocks)
  if (stooqResult) {
    const key = stooqResult.symbol.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(stooqResult);
    }
  }

  // Yahoo results
  for (const r of yahooResults) {
    const key = r.symbol.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(r);
    }
  }

  const limited = results.slice(0, 15);
  setCached(cacheKey, limited, 300); // cache 5 min
  return limited;
}
