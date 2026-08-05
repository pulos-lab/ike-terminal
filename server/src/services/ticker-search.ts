import { getCached, setCached } from './price-cache.js';
import { getAllTickers } from '../db/ticker-map-repo.js';
import type { TickerSearchResult } from 'shared';
import { stripTickerSuffix } from './stooq-utils.js';
import { getYahooAuth } from './yahoo-auth.js';
import { detectYahooBlock, getYahooGuard, withYahooLimit } from './yahoo-guard.js';
import { getBrCatalogService } from './biznesradar-catalog.js';

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
    const resp = await withYahooLimit(() =>
      fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          ...(auth?.cookies ? { Cookie: auth.cookies } : {}),
        },
      }),
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (detectYahooBlock(resp.status, body)) getYahooGuard().registerBlock();
      return [];
    }
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
 *
 * UWAGA: endpoint CSV `/q/l/` padł ~03.2026 (zwraca „lokalizacja nie
 * istnieje" globalnie) — w praktyce funkcja zwraca null. Zostaje wyłącznie
 * dla isin-resolvera (ma własne fallbacki); wyszukiwarka podpowiedzi używa
 * katalogu biznesradar (biznesradar-catalog.ts).
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
 * Search local ticker_map database (instrumenty AKTYWNEGO portfela —
 * bez portfolioId repo czyta portfel 'default', który na multi-tenant
 * prodzie jest pusty).
 */
function searchLocal(query: string, portfolioId?: string): TickerSearchResult[] {
  const lower = query.toLowerCase();
  const all = getAllTickers(portfolioId);
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
 * Search tickers across Yahoo, katalog biznesradar (GPW+NC) and local database.
 *
 * Cache per-query obejmuje WYŁĄCZNIE wynik Yahoo (jedyne źródło sieciowe
 * per zapytanie) — źródła lokalne (ticker_map aktywnego portfela, index BR
 * w pamięci) są tanie i liczone na żywo; wyniki zależne od portfela nie mogą
 * trafiać do globalnego cache'a.
 */
export async function searchTickers(
  query: string,
  portfolioId?: string,
): Promise<TickerSearchResult[]> {
  if (!query || query.length < 1) return [];

  const yahooCacheKey = `ticker_search_yahoo_${query.toLowerCase()}`;
  const cachedYahoo = getCached<TickerSearchResult[]>(yahooCacheKey);
  const yahooPromise = cachedYahoo
    ? Promise.resolve(cachedYahoo)
    : searchYahoo(query).then((r) => {
        // Krótszy TTL dla pustych wyników — chwilowy 500 z Yahoo nie blokuje podpowiedzi na 5 min
        setCached(yahooCacheKey, r, r.length === 0 ? 30 : 300);
        return r;
      });

  const [yahooResults, brResults, localResults] = await Promise.all([
    yahooPromise,
    getBrCatalogService().search(query),
    Promise.resolve(searchLocal(query, portfolioId)),
  ]);

  // Merge and deduplicate by symbol — local first so its richer metadata
  // (e.g. real currency from ticker_map) survives the dedupe, BR before Yahoo
  // so `.WA` entries keep PLN + rozróżnienie GPW/NC; ordering will be redone
  // by relevance score below.
  const seen = new Set<string>();
  const results: TickerSearchResult[] = [];

  for (const r of [...localResults, ...brResults, ...yahooResults]) {
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

  return results.slice(0, 15);
}

/**
 * Lookup display name (longname/shortname) for a single ticker symbol via Yahoo
 * search. Returns null if not found OR if Yahoo doesn't return an exact symbol
 * match — strict matching protects CFD/certificate entries (e.g. `OIL`) from
 * being overwritten by an arbitrary first-quote like "Marathon Oil Corporation".
 *
 * Uses the same crumb+cookies auth as `searchYahoo` — without it Yahoo returns
 * HTTP 500 for /v1/finance/search calls in production (PR #46).
 */
export async function fetchYahooTickerName(symbol: string): Promise<string | null> {
  try {
    const auth = await getYahooAuth();
    const params = new URLSearchParams({
      q: symbol,
      quotesCount: '10',
      newsCount: '0',
      listsCount: '0',
    });
    if (auth?.crumb) params.set('crumb', auth.crumb);
    const url = `https://query2.finance.yahoo.com/v1/finance/search?${params}`;
    const resp = await withYahooLimit(() =>
      fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          ...(auth?.cookies ? { Cookie: auth.cookies } : {}),
        },
      }),
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (detectYahooBlock(resp.status, body)) getYahooGuard().registerBlock();
      return null;
    }
    const json = await resp.json();
    const quotes: any[] = json?.quotes || [];
    const upper = symbol.toUpperCase();
    // Strict: require Yahoo to return a quote with the EXACT same symbol. Without
    // this, querying for "OIL" (a CFD ticker) returns "Marathon Oil Corporation"
    // as quotes[0] and clobbers the legit CFD name. No fallback to quotes[0].
    const match = quotes.find((q) => (q.symbol || '').toUpperCase() === upper);
    if (!match) return null;
    return match.longname || match.shortname || null;
  } catch {
    return null;
  }
}
