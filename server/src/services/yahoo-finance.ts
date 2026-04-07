import { getCached, setCached } from './price-cache.js';
import { storeHistoricalPrices, loadHistoricalPrices, getLastCachedDate } from './history-cache.js';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_V10_BASE = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const HEADERS = {
  'User-Agent': USER_AGENT,
};

// ============ Yahoo Auth (crumb + cookies for v10) ============

let cachedCrumb: string | null = null;
let cachedCookies: string | null = null;
let crumbExpiresAt = 0;

const CRUMB_TTL = 6 * 3600 * 1000; // 6 hours

async function refreshYahooCrumb(): Promise<void> {
  try {
    // Step 1: Get cookies from fc.yahoo.com
    const resp1 = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',
    });
    const setCookieHeaders = resp1.headers.getSetCookie?.() || [];
    cachedCookies = setCookieHeaders.map(c => c.split(';')[0]).join('; ');

    if (!cachedCookies) {
      console.warn('[yahoo-auth] No cookies received from fc.yahoo.com');
      return;
    }

    // Step 2: Get crumb with cookies
    const resp2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': USER_AGENT, 'Cookie': cachedCookies },
    });
    if (!resp2.ok) {
      console.warn(`[yahoo-auth] Crumb fetch failed: HTTP ${resp2.status}`);
      return;
    }
    cachedCrumb = await resp2.text();
    crumbExpiresAt = Date.now() + CRUMB_TTL;
    console.log('[yahoo-auth] Crumb refreshed successfully');
  } catch (error) {
    console.error('[yahoo-auth] Failed to refresh crumb:', error);
  }
}

async function getYahooAuth(): Promise<{ crumb: string; cookies: string } | null> {
  if (!cachedCrumb || !cachedCookies || Date.now() > crumbExpiresAt) {
    await refreshYahooCrumb();
  }
  if (!cachedCrumb || !cachedCookies) return null;
  return { crumb: cachedCrumb, cookies: cachedCookies };
}

// ============ v10 quoteSummary ============

async function yahooQuoteSummary(ticker: string, modules: string[]): Promise<any> {
  const auth = await getYahooAuth();
  if (!auth) return null;

  const params = new URLSearchParams({
    modules: modules.join(','),
    crumb: auth.crumb,
  });
  const url = `${YAHOO_V10_BASE}/${encodeURIComponent(ticker)}?${params}`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Cookie': auth.cookies },
  });

  if (resp.status === 401 || resp.status === 403) {
    // Crumb expired — refresh and retry once
    cachedCrumb = null;
    const auth2 = await getYahooAuth();
    if (!auth2) return null;

    const params2 = new URLSearchParams({
      modules: modules.join(','),
      crumb: auth2.crumb,
    });
    const url2 = `${YAHOO_V10_BASE}/${encodeURIComponent(ticker)}?${params2}`;
    const resp2 = await fetch(url2, {
      headers: { 'User-Agent': USER_AGENT, 'Cookie': auth2.cookies },
    });
    if (!resp2.ok) return null;
    const json2 = await resp2.json();
    return json2?.quoteSummary?.result?.[0] ?? null;
  }

  if (!resp.ok) return null;
  const json = await resp.json();
  return json?.quoteSummary?.result?.[0] ?? null;
}

// ============ Dividend Calendar (v10) ============

export interface DividendCalendar {
  exDividendDate: string | null;
  paymentDate: string | null;
  dividendRate: number | null;
  dividendYield: number | null;
}

/**
 * Fetch upcoming dividend info from Yahoo v10 quoteSummary.
 * Returns ex-dividend date, payment date, annual dividend rate and yield.
 */
export async function fetchDividendCalendar(ticker: string): Promise<DividendCalendar | null> {
  const cacheKey = `yahoo_divcal_${ticker}`;
  const cached = getCached<DividendCalendar>(cacheKey);
  if (cached) return cached;

  try {
    const result = await yahooQuoteSummary(ticker, ['calendarEvents', 'summaryDetail']);
    if (!result) return null;

    const ce = result.calendarEvents;
    const sd = result.summaryDetail;

    const toDate = (obj: any): string | null => {
      if (!obj?.raw) return null;
      return new Date(obj.raw * 1000).toISOString().split('T')[0];
    };

    const cal: DividendCalendar = {
      exDividendDate: toDate(ce?.exDividendDate) || toDate(sd?.exDividendDate),
      paymentDate: toDate(ce?.dividendDate),
      dividendRate: sd?.dividendRate?.raw ?? null,
      dividendYield: sd?.dividendYield?.raw ?? null,
    };

    // Cache for 12h
    setCached(cacheKey, cal, 12 * 3600);
    return cal;
  } catch (error) {
    console.error(`Yahoo dividend calendar fetch failed for ${ticker}:`, error);
    return null;
  }
}

// ============ v8 Chart API ============

async function yahooChart(ticker: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?${qs}`;
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
  const json = await resp.json();
  return json?.chart?.result?.[0] ?? null;
}

/**
 * Fetch current price from Yahoo Finance (v8 chart API)
 */
export async function fetchYahooPrice(ticker: string): Promise<{ price: number; currency: string; previousClose: number | null } | null> {
  const cacheKey = `yahoo_live_${ticker}`;
  const cached = getCached<{ price: number; currency: string; previousClose: number | null }>(cacheKey);
  if (cached) return cached;

  try {
    const result = await yahooChart(ticker, { interval: '1d', range: '1d' });
    if (!result?.meta?.regularMarketPrice) return null;

    const data = {
      price: result.meta.regularMarketPrice,
      currency: result.meta.currency || 'USD',
      previousClose: result.meta.chartPreviousClose ?? result.meta.previousClose ?? null,
    };
    setCached(cacheKey, data);
    return data;
  } catch (error) {
    console.error(`Yahoo price fetch failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch historical daily data from Yahoo Finance (v8 chart API)
 */
export async function fetchYahooHistory(
  ticker: string,
  startDate: string,
  endDate?: string
): Promise<Array<{ date: string; close: number }>> {
  const end = endDate || new Date().toISOString().split('T')[0];
  const cacheKey = `yahoo_history_${ticker}_${startDate}_${end}`;
  const cached = getCached<Array<{ date: string; close: number }>>(cacheKey);
  if (cached) return cached;

  // Check persistent SQLite cache first
  const cachedData = loadHistoricalPrices(ticker, startDate);
  const lastCached = getLastCachedDate(ticker);
  const today = new Date().toISOString().split('T')[0];

  // If we have cached data and it's recent (within 2 days), use it
  if (cachedData.length > 10 && lastCached && lastCached >= today.slice(0, 8)) {
    setCached(cacheKey, cachedData, 12 * 3600);
    return cachedData;
  }

  // Fetch only missing data (from last cached date or startDate)
  const fetchFrom = lastCached && lastCached > startDate
    ? lastCached
    : startDate;

  try {
    const period1 = String(Math.floor(new Date(fetchFrom).getTime() / 1000));
    const period2 = String(Math.floor(new Date(end).getTime() / 1000));

    const result = await yahooChart(ticker, { interval: '1d', period1, period2 });
    if (!result) {
      if (cachedData.length > 0) return cachedData;
      return [];
    }

    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];

    const freshData = timestamps
      .map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().split('T')[0],
        close: closes[i],
      }))
      .filter((r): r is { date: string; close: number } => r.close != null)
      .sort((a, b) => a.date.localeCompare(b.date));

    // Store fresh data in persistent cache
    if (freshData.length > 0) {
      storeHistoricalPrices(ticker, freshData, 'yahoo');
    }

    // Merge: load full range from persistent cache (now includes fresh data)
    const mergedData = loadHistoricalPrices(ticker, startDate);
    mergedData.sort((a, b) => a.date.localeCompare(b.date));
    setCached(cacheKey, mergedData, 12 * 3600);
    return mergedData;
  } catch (error) {
    console.error(`Yahoo history fetch failed for ${ticker}:`, error);
    // Fall back to persistent cache
    if (cachedData.length > 0) return cachedData;
    return [];
  }
}

/**
 * Fetch dividend events from Yahoo Finance (v8 chart API)
 * Returns per-share dividend amounts with ex-dividend dates
 */
export async function fetchYahooDividendEvents(
  ticker: string,
  startDate: string,
  endDate?: string
): Promise<Array<{ date: string; amount: number }>> {
  const end = endDate || new Date().toISOString().split('T')[0];
  const cacheKey = `yahoo_divevents_${ticker}_${startDate}_${end}`;
  const cached = getCached<Array<{ date: string; amount: number }>>(cacheKey);
  if (cached) return cached;

  try {
    const period1 = String(Math.floor(new Date(startDate).getTime() / 1000));
    const period2 = String(Math.floor(new Date(end).getTime() / 1000));

    const result = await yahooChart(ticker, {
      interval: '1d',
      period1,
      period2,
      events: 'div',
    });

    if (!result?.events?.dividends) {
      setCached(cacheKey, [], 12 * 3600);
      return [];
    }

    const dividends: Record<string, { date: number; amount: number }> = result.events.dividends;
    const events = Object.values(dividends)
      .map(d => ({
        date: new Date(d.date * 1000).toISOString().split('T')[0],
        amount: d.amount,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    setCached(cacheKey, events, 12 * 3600);
    return events;
  } catch (error) {
    console.error(`Yahoo dividend events fetch failed for ${ticker}:`, error);
    return [];
  }
}

/**
 * Fetch a single historical price directly from Yahoo, bypassing all caches.
 * Used for split detection — after a split, Yahoo retroactively adjusts historical
 * prices, but our persistent cache still holds old (pre-split) values.
 */
export async function fetchYahooHistoryDirect(
  ticker: string,
  date: string,
): Promise<number | null> {
  try {
    const period1 = String(Math.floor(new Date(date).getTime() / 1000));
    // Fetch a 5-day window to increase chance of hitting the exact date
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + 5);
    const period2 = String(Math.floor(endDate.getTime() / 1000));

    const result = await yahooChart(ticker, { interval: '1d', period1, period2 });
    if (!result) return null;

    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];

    for (let i = 0; i < timestamps.length; i++) {
      const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
      if (d === date && closes[i] != null) return closes[i]!;
    }

    // If exact date not found, return first available close
    for (const c of closes) {
      if (c != null) return c;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch FX rate from Yahoo Finance (v8 chart API)
 */
export async function fetchFxRate(pair: string): Promise<number | null> {
  const cacheKey = `fx_${pair}`;
  const cached = getCached<number>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const ticker = `${pair}=X`;
    const result = await yahooChart(ticker, { interval: '1d', range: '1d' });
    if (!result?.meta?.regularMarketPrice) return null;

    const rate = result.meta.regularMarketPrice;
    setCached(cacheKey, rate);
    return rate;
  } catch (error) {
    console.error(`FX rate fetch failed for ${pair}:`, error);
    return null;
  }
}
