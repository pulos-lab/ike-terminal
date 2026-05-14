import { getCached, setCached } from './price-cache.js';
import { getAllTickers } from '../db/ticker-map-repo.js';
import type { TickerSearchResult } from 'shared';
import { stripTickerSuffix } from './stooq-utils.js';
import { getYahooAuth } from './yahoo-auth.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/**
 * Search Yahoo Finance for ticker symbols.
 * Uses crumb+cookies auth — bez tego Yahoo zwraca HTTP 500 dla większości zapytań.
 */
export async function searchYahoo(query: string): Promise<TickerSearchResult[]> {
  try {
    const auth = await getYahooAuth();
    const params = new URLSearchParams({
      q: query,
      quotesCount: '10',
      newsCount: '0',
      listsCount: '0',
    });
    if (auth?.crumb) params.set('crumb', auth.crumb);
    const url = `https://query2.finance.yahoo.com/v1/finance/search?${params}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        ...(auth?.cookies ? { Cookie: auth.cookies } : {}),
      },
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    const quotes: any[] = json?.quotes || [];
    return quotes
      .filter((q: any) => {
        const t = String(q.quoteType || q.typeDisp || '').toUpperCase();
        return t === 'EQUITY' || t === 'ETF';
      })
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
export async function validateStooq(
  query: string,
  expectedName?: string,
): Promise<TickerSearchResult | null> {
  // Only try for short, simple tickers (likely Polish)
  const raw = stripTickerSuffix(query).toLowerCase();
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
    if (!ticker || ticker === 'N/D' || values.some((v) => v === 'N/D' || v === 'B/D')) return null;

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
    .filter(
      (t) =>
        t.ticker.toLowerCase().includes(lower) ||
        t.name.toLowerCase().includes(lower) ||
        t.isin.toLowerCase().includes(lower),
    )
    .map((t) => ({
      symbol: t.ticker,
      name: t.name,
      exchange: t.exchange,
      currency: t.currency,
    }));
}

/**
 * Score a result against the query. Higher = more relevant. Used to sort merged
 * results so that exact/prefix symbol matches come before fuzzy name matches.
 *
 * Scoring (each tier 100 wider than the next, so ties break within tier):
 *   1000+ exact symbol match (case-insensitive)
 *    900+ symbol starts with query
 *    800+ symbol (stripped of `.WA`/`.NC`/etc.) starts with query
 *    700+ name starts with query
 *    500+ symbol contains query
 *    400+ name contains query
 *      0  fallback (shouldn't happen if filter passed)
 * Within a tier, shorter symbol wins (FIG beats FIGS for "fig").
 */
function relevanceScore(r: TickerSearchResult, q: string): number {
  const lq = q.toLowerCase();
  const symLower = r.symbol.toLowerCase();
  const symBase = symLower.split('.')[0];
  const nameLower = (r.name || '').toLowerCase();
  // Sub-score: shorter symbol = better (max 99 bonus)
  const lengthBonus = Math.max(0, 99 - r.symbol.length);
  if (symLower === lq) return 1000 + lengthBonus;
  if (symLower.startsWith(lq)) return 900 + lengthBonus;
  if (symBase.startsWith(lq)) return 800 + lengthBonus;
  if (nameLower.startsWith(lq)) return 700 + lengthBonus;
  if (symLower.includes(lq)) return 500 + lengthBonus;
  if (nameLower.includes(lq)) return 400 + lengthBonus;
  return 0;
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

  // Merge and deduplicate by symbol — local first so its richer metadata
  // (e.g. real currency from ticker_map) survives the dedupe; ordering will
  // be redone by relevance score below.
  const seen = new Set<string>();
  const results: TickerSearchResult[] = [];

  for (const r of localResults) {
    const key = r.symbol.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(r);
    }
  }
  if (stooqResult) {
    const key = stooqResult.symbol.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(stooqResult);
    }
  }
  for (const r of yahooResults) {
    const key = r.symbol.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(r);
    }
  }

  // Sort by relevance — exact symbol match wins, then prefix, then contains.
  // Without this, the merge order put any local "name contains query" match
  // ahead of an exact Yahoo symbol match (e.g. SOMEFIG.WA before FIG for "fig").
  results.sort((a, b) => relevanceScore(b, query) - relevanceScore(a, query));

  const limited = results.slice(0, 15);
  // Krótszy TTL dla pustych wyników — chwilowy 500 z Yahoo nie blokuje podpowiedzi na 5 min
  setCached(cacheKey, limited, limited.length === 0 ? 30 : 300);
  return limited;
}

/**
 * Lookup display name (longname/shortname) for a single ticker symbol via Yahoo
 * search. Returns null if not found. Used to seed real names into auto-created
 * ticker_map entries instead of falling back to the bare symbol.
 */
export async function fetchYahooTickerName(symbol: string): Promise<string | null> {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=10&newsCount=0&listsCount=0`;
    const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return null;
    const json = await resp.json();
    const quotes: any[] = json?.quotes || [];
    const upper = symbol.toUpperCase();
    const match = quotes.find((q) => (q.symbol || '').toUpperCase() === upper) || quotes[0];
    if (!match) return null;
    return match.longname || match.shortname || null;
  } catch {
    return null;
  }
}
