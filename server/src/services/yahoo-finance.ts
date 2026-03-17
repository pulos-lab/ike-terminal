import { getCached, setCached } from './price-cache.js';
import { storeHistoricalPrices, loadHistoricalPrices, getLastCachedDate } from './history-cache.js';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
};

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
