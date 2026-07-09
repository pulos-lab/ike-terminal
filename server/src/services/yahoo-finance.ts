import { getCached, setCached } from './price-cache.js';
import {
  storeHistoricalPrices,
  loadHistoricalPrices,
  getLastCachedDate,
  getFirstCachedDate,
} from './history-cache.js';
import { getYahooAuth, invalidateYahooAuth } from './yahoo-auth.js';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_V10_BASE = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const HEADERS = {
  'User-Agent': USER_AGENT,
};
const FETCH_TIMEOUT = 10_000; // 10 seconds

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
    headers: { 'User-Agent': USER_AGENT, Cookie: auth.cookies },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (resp.status === 401 || resp.status === 403) {
    // Crumb expired — refresh and retry once
    invalidateYahooAuth();
    const auth2 = await getYahooAuth();
    if (!auth2) return null;

    const params2 = new URLSearchParams({
      modules: modules.join(','),
      crumb: auth2.crumb,
    });
    const url2 = `${YAHOO_V10_BASE}/${encodeURIComponent(ticker)}?${params2}`;
    const resp2 = await fetch(url2, {
      headers: { 'User-Agent': USER_AGENT, Cookie: auth2.cookies },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
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

// ============ Asset Profile (v10) ============

export interface AssetProfile {
  sector: string | null;
  industry: string | null;
}

/**
 * Fetch sector/industry classification from Yahoo v10 quoteSummary.
 * Działa dla akcji (assetProfile.sector) i ETF-ów (fundProfile.categoryName
 * jako pseudo-sektor). Dla futures/FX/crypto Yahoo nie zwraca sensownego
 * profilu — wtedy null i caller zna statyczną mapę (CFD_TICKER_MAP dla CFD).
 *
 * Cache: 7 dni — sektor/industry nie zmieniają się często.
 */
export async function fetchAssetProfile(ticker: string): Promise<AssetProfile | null> {
  const cacheKey = `yahoo_profile_${ticker}`;
  const cached = getCached<AssetProfile>(cacheKey);
  if (cached) return cached;

  try {
    const result = await yahooQuoteSummary(ticker, ['assetProfile', 'fundProfile']);
    if (!result) return null;

    // Stocks: assetProfile.sector / industry
    const ap = result.assetProfile;
    // ETFs / mutual funds: fundProfile.categoryName
    const fp = result.fundProfile;

    const profile: AssetProfile = {
      sector: ap?.sector || fp?.categoryName || null,
      industry: ap?.industry || null,
    };

    // Cache for 7 days
    setCached(cacheKey, profile, 7 * 24 * 3600);
    return profile;
  } catch (error) {
    console.error(`Yahoo asset profile fetch failed for ${ticker}:`, error);
    return null;
  }
}

// ============ v8 Chart API ============

async function yahooChart(ticker: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?${qs}`;
  const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
  const json = await resp.json();
  return json?.chart?.result?.[0] ?? null;
}

// In-flight request deduplication — prevents duplicate Yahoo API calls for the same ticker
type YahooPriceResult = { price: number; currency: string; previousClose: number | null } | null;
const inFlightPrices = new Map<string, Promise<YahooPriceResult>>();

/**
 * Fetch current price from Yahoo Finance (v8 chart API)
 */
export async function fetchYahooPrice(ticker: string): Promise<YahooPriceResult> {
  const cacheKey = `yahoo_live_${ticker}`;
  const cached = getCached<{ price: number; currency: string; previousClose: number | null }>(
    cacheKey,
  );
  if (cached) return cached;

  const existing = inFlightPrices.get(ticker);
  if (existing) return existing;

  const promise = (async (): Promise<YahooPriceResult> => {
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
    } finally {
      inFlightPrices.delete(ticker);
    }
  })();

  inFlightPrices.set(ticker, promise);
  return promise;
}

// In-flight request deduplication for history — two concurrent dashboard requests
// for the same ticker/range share one fetch instead of double-fetching Yahoo and
// double-writing the SQLite cache.
const inFlightHistory = new Map<string, Promise<Array<{ date: string; close: number }>>>();

/**
 * Fetch historical daily data from Yahoo Finance (v8 chart API)
 */
export async function fetchYahooHistory(
  ticker: string,
  startDate: string,
  endDate?: string,
): Promise<Array<{ date: string; close: number }>> {
  const end = endDate || new Date().toISOString().split('T')[0];
  const cacheKey = `yahoo_history_${ticker}_${startDate}_${end}`;
  const cached = getCached<Array<{ date: string; close: number }>>(cacheKey);
  if (cached) return cached;

  const inFlightKey = `${ticker}_${startDate}_${end}`;
  const existing = inFlightHistory.get(inFlightKey);
  if (existing) return existing;

  const promise = fetchYahooHistoryUncached(ticker, startDate, end, cacheKey).finally(() => {
    inFlightHistory.delete(inFlightKey);
  });
  inFlightHistory.set(inFlightKey, promise);
  return promise;
}

async function fetchYahooHistoryUncached(
  ticker: string,
  startDate: string,
  end: string,
  cacheKey: string,
): Promise<Array<{ date: string; close: number }>> {
  // Check persistent SQLite cache first
  const cachedData = loadHistoricalPrices(ticker, startDate);
  const lastCached = getLastCachedDate(ticker);
  const firstCached = getFirstCachedDate(ticker);
  const today = new Date().toISOString().split('T')[0];

  // Check if cache covers the requested start date
  const cacheCoversStart = firstCached != null && firstCached <= startDate;

  // If we have cached data that covers the start and is recent (within 3 days), use it
  const daysDiff = lastCached
    ? Math.floor((new Date(today).getTime() - new Date(lastCached).getTime()) / 86_400_000)
    : Infinity;
  if (cachedData.length > 10 && daysDiff <= 3 && cacheCoversStart) {
    setCached(cacheKey, cachedData, 12 * 3600);
    return cachedData;
  }

  // Determine what ranges to fetch
  // 1. Backfill: if cache starts later than requested startDate, fetch the gap
  // 2. Forward: if cache doesn't cover recent dates, fetch from lastCached to end
  const fetchRanges: Array<{ from: string; to: string }> = [];

  if (!cacheCoversStart) {
    // Need to backfill from startDate to firstCached (or end if no cache)
    const backfillEnd = firstCached && firstCached > startDate ? firstCached : end;
    fetchRanges.push({ from: startDate, to: backfillEnd });
  }

  if (!lastCached || lastCached < end) {
    // Need forward fetch from lastCached (or startDate) to end
    const forwardFrom = lastCached && lastCached > startDate ? lastCached : startDate;
    // Avoid duplicate range if backfill already covers this
    if (fetchRanges.length === 0 || forwardFrom > fetchRanges[0].to) {
      fetchRanges.push({ from: forwardFrom, to: end });
    }
  }

  if (fetchRanges.length === 0) {
    // Cache is complete — return it
    const mergedData = loadHistoricalPrices(ticker, startDate);
    mergedData.sort((a, b) => a.date.localeCompare(b.date));
    setCached(cacheKey, mergedData, 12 * 3600);
    return mergedData;
  }

  try {
    for (const range of fetchRanges) {
      const period1 = String(Math.floor(new Date(range.from).getTime() / 1000));
      const period2 = String(Math.floor(new Date(range.to).getTime() / 1000));

      const result = await yahooChart(ticker, { interval: '1d', period1, period2 });
      if (!result) continue;

      const timestamps: number[] = result.timestamp || [];
      const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];

      const freshData = timestamps
        .map((ts, i) => ({
          date: new Date(ts * 1000).toISOString().split('T')[0],
          close: closes[i],
        }))
        .filter((r): r is { date: string; close: number } => r.close != null)
        .sort((a, b) => a.date.localeCompare(b.date));

      if (freshData.length > 0) {
        storeHistoricalPrices(ticker, freshData, 'yahoo');
      }
    }

    // Merge: load full range from persistent cache (now includes fresh data)
    const mergedData = loadHistoricalPrices(ticker, startDate);
    mergedData.sort((a, b) => a.date.localeCompare(b.date));
    setCached(cacheKey, mergedData, 12 * 3600);
    return mergedData;
  } catch (error) {
    console.error(`Yahoo history fetch failed for ${ticker}:`, error);
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
  endDate?: string,
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
      .map((d) => ({
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
 * Fetch stock split events from Yahoo Finance (v8 chart API).
 * Returns real split dates + ratios (numerator/denominator), e.g. 10:1 split → ratio 10.
 * Used to assign REAL dates to heuristically detected splits — without them
 * adjustment of transactions cannot distinguish pre- from post-split buys.
 */
export async function fetchYahooSplitEvents(
  ticker: string,
  startDate: string,
  endDate?: string,
): Promise<Array<{ date: string; ratio: number }>> {
  const end = endDate || new Date().toISOString().split('T')[0];
  const cacheKey = `yahoo_splitevents_${ticker}_${startDate}_${end}`;
  const cached = getCached<Array<{ date: string; ratio: number }>>(cacheKey);
  if (cached) return cached;

  try {
    const period1 = String(Math.floor(new Date(startDate).getTime() / 1000));
    const period2 = String(Math.floor(new Date(end).getTime() / 1000));

    const result = await yahooChart(ticker, {
      interval: '1d',
      period1,
      period2,
      events: 'split',
    });

    if (!result?.events?.splits) {
      setCached(cacheKey, [], 12 * 3600);
      return [];
    }

    const splits: Record<string, { date: number; numerator: number; denominator: number }> =
      result.events.splits;
    const raw = Object.values(splits)
      .filter((s) => s.numerator > 0 && s.denominator > 0)
      .map((s) => ({
        date: new Date(s.date * 1000).toISOString().split('T')[0],
        ratio: s.numerator / s.denominator,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Yahoo bywa niespójne i raportuje ten sam split w dwóch sąsiednich dniach
    // (np. EDU 1:10 na 2022-04-07 i 2022-04-08). Zliczenie obu podwoiłoby korektę
    // (×0.01 zamiast ×0.1). Sklejamy zdarzenia o identycznym ratio w oknie ≤4 dni.
    const events: Array<{ date: string; ratio: number }> = [];
    for (const e of raw) {
      const prev = events[events.length - 1];
      if (
        prev &&
        Math.abs(prev.ratio - e.ratio) < 1e-9 &&
        Math.abs(Date.parse(e.date) - Date.parse(prev.date)) <= 4 * 86_400_000
      ) {
        continue;
      }
      events.push(e);
    }

    setCached(cacheKey, events, 12 * 3600);
    return events;
  } catch (error) {
    console.error(`Yahoo split events fetch failed for ${ticker}:`, error);
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
