import { getCached, setCached } from './price-cache.js';
import { storeHistoricalPrices, loadHistoricalPrices, getLastCachedDate } from './history-cache.js';
import { config } from '../config.js';

/** Stooq ticker → Yahoo ticker mapping for benchmark live fallback */
const BENCHMARK_YAHOO_FALLBACK: Record<string, string> = {
  wig: 'WIG.WA',
  wig20: 'WIG20.WA',
  mwig40: 'MWIG40.WA',
  swig80: 'SWIG80.WA',
};

/** Detect Stooq block/rate-limit responses (including new API key requirement) */
function isStooqBlocked(text: string): boolean {
  return (
    text.includes('Przekroczony') ||
    text.includes('limit') ||
    text.includes('www@stooq.pl') ||
    text.includes('apikey')
  );
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Concurrency limiter for Stooq requests (max 3 simultaneous)
const STOOQ_MAX_CONCURRENT = 3;
let stooqActiveCount = 0;
const stooqQueue: Array<() => void> = [];

async function withStooqLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (stooqActiveCount >= STOOQ_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => stooqQueue.push(resolve));
  }
  stooqActiveCount++;
  try {
    return await fn();
  } finally {
    stooqActiveCount--;
    const next = stooqQueue.shift();
    if (next) next();
  }
}

// Tickers that have a different symbol on Stooq than on Bossa/GPW
const STOOQ_TICKER_ALIASES: Record<string, string> = {
  big: 'bcs', // BigCheese Studio → BCS on Stooq
  cyb: 'cbf', // CyberFolks → CBF on Stooq
};

// Tickers that should NOT be fetched from Stooq (wrong company or no data)
const STOOQ_TICKER_BLACKLIST = new Set([
  'wod', // WOD on Stooq is a different company than Woodpecker (WOD.WA)
]);

function resolveStooqTicker(ticker: string): string | null {
  const raw = ticker.replace('.WA', '').toLowerCase();
  if (STOOQ_TICKER_BLACKLIST.has(raw)) return null;
  return STOOQ_TICKER_ALIASES[raw] || raw;
}

/**
 * Fetch current price from Stooq for Polish stocks
 * Ticker format for Stooq: lowercase without .WA (e.g., "crj" for CRJ.WA)
 */
export async function fetchStooqPrice(ticker: string): Promise<number | null> {
  const stooqTicker = resolveStooqTicker(ticker);
  if (!stooqTicker) return null;
  const cacheKey = `stooq_live_${stooqTicker}`;
  const cached = getCached<number>(cacheKey);
  if (cached !== undefined) return cached;

  return withStooqLimit(async () => {
    try {
      const url = `https://stooq.pl/q/l/?s=${stooqTicker}&f=sd2t2ohlcv&h&e=csv`;
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      const text = await response.text();
      const lines = text.trim().split('\n');
      if (lines.length < 2) return null;

      const headers = lines[0].split(',');
      const values = lines[1].split(',');
      const closeIdx = headers.findIndex(
        (h) => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close',
      );

      if (closeIdx === -1) return null;
      const price = parseFloat(values[closeIdx]);
      if (isNaN(price)) return null;

      setCached(cacheKey, price, config.cache.stooqLiveTtl);
      return price;
    } catch (error) {
      console.error(`Stooq price fetch failed for ${ticker}:`, error);
      return null;
    }
  });
}

/**
 * Fetch previous close from Stooq (for daily change calculation)
 */
export async function fetchStooqPreviousClose(ticker: string): Promise<number | null> {
  const stooqTicker = resolveStooqTicker(ticker);
  if (!stooqTicker) return null;
  const cacheKey = `stooq_prevclose_${stooqTicker}`;
  const cached = getCached<number>(cacheKey);
  if (cached !== undefined) return cached;

  return withStooqLimit(async () => {
    try {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 10); // 10 days back to handle weekends/holidays
      const d1 = start.toISOString().slice(0, 10).replace(/-/g, '');
      const d2 = end.toISOString().slice(0, 10).replace(/-/g, '');
      const url = `https://stooq.pl/q/d/l/?s=${stooqTicker}&i=d&d1=${d1}&d2=${d2}`;
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      const text = await response.text();
      if (isStooqBlocked(text)) {
        // Fallback to SQLite cache
        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        const cachedRows = loadHistoricalPrices(
          stooqTicker,
          tenDaysAgo.toISOString().split('T')[0],
        );
        if (cachedRows.length >= 2) {
          cachedRows.sort((a, b) => a.date.localeCompare(b.date));
          const prevCloseVal = cachedRows[cachedRows.length - 2].close;
          setCached(cacheKey, prevCloseVal, config.cache.stooqLiveTtl);
          return prevCloseVal;
        }
        return null;
      }
      const lines = text.trim().split('\n');
      if (lines.length < 3) {
        // Not enough data from API — fallback to SQLite cache
        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        const cachedRows = loadHistoricalPrices(
          stooqTicker,
          tenDaysAgo.toISOString().split('T')[0],
        );
        if (cachedRows.length >= 2) {
          cachedRows.sort((a, b) => a.date.localeCompare(b.date));
          const prevCloseVal = cachedRows[cachedRows.length - 2].close;
          setCached(cacheKey, prevCloseVal, config.cache.stooqLiveTtl);
          return prevCloseVal;
        }
        return null;
      }

      const headers = lines[0].split(',');
      const closeIdx = headers.findIndex(
        (h) => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close',
      );
      if (closeIdx === -1) return null;

      // Parse all rows, sort by date, take second-to-last
      const rows: { date: string; close: number }[] = [];
      const dateIdx = headers.findIndex(
        (h) => h.toLowerCase() === 'data' || h.toLowerCase() === 'date',
      );
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(',');
        const date = dateIdx >= 0 ? vals[dateIdx] : '';
        const close = parseFloat(vals[closeIdx]);
        if (!isNaN(close) && date) rows.push({ date, close });
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      if (rows.length < 2) return null;

      const prevClose = rows[rows.length - 2].close;
      setCached(cacheKey, prevClose, config.cache.stooqLiveTtl);
      return prevClose;
    } catch (error) {
      console.error(`Stooq previous close fetch failed for ${ticker}:`, error);
      return null;
    }
  });
}

/**
 * Try to fetch today's close via Stooq live API, falling back to Yahoo.
 * Used when Stooq historical API is blocked but we need the latest data point.
 */
async function fetchLiveClose(
  stooqTicker: string,
): Promise<{ date: string; close: number } | null> {
  try {
    // Try Stooq live quote API first
    const url = `https://stooq.pl/q/l/?s=${stooqTicker}&f=sd2t2ohlcv&h&e=csv`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const text = await response.text();

    if (!isStooqBlocked(text)) {
      const lines = text.trim().split('\n');
      if (lines.length >= 2) {
        const headers = lines[0].split(',');
        const values = lines[1].split(',');
        const dateIdx = headers.findIndex(
          (h) => h.toLowerCase() === 'data' || h.toLowerCase() === 'date',
        );
        const closeIdx = headers.findIndex(
          (h) => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close',
        );
        if (dateIdx !== -1 && closeIdx !== -1) {
          const date = values[dateIdx]?.trim();
          const close = parseFloat(values[closeIdx]?.trim());
          if (date && !isNaN(close)) return { date, close };
        }
      }
    }
  } catch {
    /* fall through to Yahoo */
  }

  // Fallback: Yahoo Finance live
  const yahooTicker = BENCHMARK_YAHOO_FALLBACK[stooqTicker];
  if (!yahooTicker) return null;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=1d`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const json = (await response.json()) as any;
    const result = json.chart?.result?.[0];
    if (!result?.timestamp?.length) return null;
    const lastIdx = result.timestamp.length - 1;
    const ts = result.timestamp[lastIdx];
    const close = result.indicators?.quote?.[0]?.close?.[lastIdx];
    if (!ts || close == null || isNaN(close)) return null;
    const date = new Date(ts * 1000).toISOString().split('T')[0];
    return { date, close };
  } catch {
    return null;
  }
}

/**
 * Fetch historical daily data from Stooq
 */
export async function fetchStooqHistory(
  ticker: string,
  startDate?: string,
): Promise<Array<{ date: string; close: number }>> {
  const stooqTicker = resolveStooqTicker(ticker);
  if (!stooqTicker) return [];
  const cacheKey = `stooq_history_${stooqTicker}_${startDate || 'all'}`;
  const cached = getCached<Array<{ date: string; close: number }>>(cacheKey);
  if (cached) return cached;

  // Check persistent SQLite cache first
  const cachedData = loadHistoricalPrices(stooqTicker, startDate);
  const lastCached = getLastCachedDate(stooqTicker);
  const today = new Date().toISOString().split('T')[0];

  // If we have cached data and it's recent (within 3 days — covers weekends), use it
  const daysDiff = lastCached
    ? Math.floor((new Date(today).getTime() - new Date(lastCached).getTime()) / 86_400_000)
    : Infinity;
  if (cachedData.length > 10 && daysDiff <= 3) {
    setCached(cacheKey, cachedData, 12 * 3600);
    return cachedData;
  }

  // Fetch only missing data (from last cached date or startDate)
  const fetchFrom =
    lastCached && lastCached > (startDate || '2000-01-01')
      ? lastCached // fetch from last cached date onwards
      : startDate;

  return withStooqLimit(async () => {
    try {
      let url = `https://stooq.pl/q/d/l/?s=${stooqTicker}&i=d`;
      if (fetchFrom) {
        const d1 = fetchFrom.replace(/-/g, '');
        const d2 = today.replace(/-/g, '');
        url += `&d1=${d1}&d2=${d2}`;
      }

      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      const text = await response.text();
      if (isStooqBlocked(text)) {
        console.warn(`Stooq historical API blocked for ${stooqTicker}, trying live fallback`);
        // Try to supplement cache with today's live data point
        const liveData = await fetchLiveClose(stooqTicker);
        if (liveData && (!lastCached || liveData.date > lastCached)) {
          storeHistoricalPrices(stooqTicker, [liveData], 'stooq-live');
          console.log(
            `[stooq] ${stooqTicker}: added live data point (${liveData.date}, close=${liveData.close})`,
          );
          // Reload merged data from cache
          const mergedData = loadHistoricalPrices(stooqTicker, startDate);
          mergedData.sort((a, b) => a.date.localeCompare(b.date));
          setCached(cacheKey, mergedData, 12 * 3600);
          return mergedData;
        }
        // Fall back to whatever we have in persistent cache
        if (cachedData.length > 0) {
          setCached(cacheKey, cachedData, 12 * 3600);
          return cachedData;
        }
        return [];
      }
      const lines = text.trim().split('\n');
      if (lines.length < 2) {
        // No data from Stooq, use persistent cache
        if (cachedData.length > 0) return cachedData;
        return [];
      }

      const headers = lines[0].split(',');
      const dateIdx = headers.findIndex(
        (h) => h.toLowerCase() === 'data' || h.toLowerCase() === 'date',
      );
      const closeIdx = headers.findIndex(
        (h) => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close',
      );

      if (dateIdx === -1 || closeIdx === -1) {
        if (cachedData.length > 0) return cachedData;
        return [];
      }

      const freshData: Array<{ date: string; close: number }> = [];
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',');
        if (values.length <= Math.max(dateIdx, closeIdx)) continue;
        const date = values[dateIdx];
        const close = parseFloat(values[closeIdx]);
        if (date && !isNaN(close)) {
          freshData.push({ date, close });
        }
      }

      // Store fresh data in persistent cache
      if (freshData.length > 0) {
        storeHistoricalPrices(stooqTicker, freshData, 'stooq');
      }

      // Merge: load full range from persistent cache (now includes fresh data)
      const mergedData = loadHistoricalPrices(stooqTicker, startDate);
      mergedData.sort((a, b) => a.date.localeCompare(b.date));
      setCached(cacheKey, mergedData, 12 * 3600);
      return mergedData;
    } catch (error) {
      console.error(`Stooq history fetch failed for ${ticker}:`, error);
      // Fall back to persistent cache
      if (cachedData.length > 0) return cachedData;
      return [];
    }
  });
}
