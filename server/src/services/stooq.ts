import { getCached, setCached } from './price-cache.js';
import { storeHistoricalPrices, loadHistoricalPrices, getLastCachedDate } from './history-cache.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Concurrency limiter for Stooq requests (max 3 simultaneous)
const STOOQ_MAX_CONCURRENT = 3;
let stooqActiveCount = 0;
const stooqQueue: Array<() => void> = [];

async function withStooqLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (stooqActiveCount >= STOOQ_MAX_CONCURRENT) {
    await new Promise<void>(resolve => stooqQueue.push(resolve));
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
  'big': 'bcs',   // BigCheese Studio → BCS on Stooq
  'cyb': 'cbf',   // CyberFolks → CBF on Stooq
};

// Tickers that should NOT be fetched from Stooq (wrong company or no data)
const STOOQ_TICKER_BLACKLIST = new Set([
  'wod',   // WOD on Stooq is a different company than Woodpecker (WOD.WA)
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
      const closeIdx = headers.findIndex(h => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close');

      if (closeIdx === -1) return null;
      const price = parseFloat(values[closeIdx]);
      if (isNaN(price)) return null;

      setCached(cacheKey, price);
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
      if (text.includes('Przekroczony') || text.includes('limit')) return null;
      const lines = text.trim().split('\n');
      if (lines.length < 3) return null; // need at least header + 2 data rows

      const headers = lines[0].split(',');
      const closeIdx = headers.findIndex(h => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close');
      if (closeIdx === -1) return null;

      // Parse all rows, sort by date, take second-to-last
      const rows: { date: string; close: number }[] = [];
      const dateIdx = headers.findIndex(h => h.toLowerCase() === 'data' || h.toLowerCase() === 'date');
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(',');
        const date = dateIdx >= 0 ? vals[dateIdx] : '';
        const close = parseFloat(vals[closeIdx]);
        if (!isNaN(close) && date) rows.push({ date, close });
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      if (rows.length < 2) return null;

      const prevClose = rows[rows.length - 2].close;
      setCached(cacheKey, prevClose);
      return prevClose;
    } catch (error) {
      console.error(`Stooq previous close fetch failed for ${ticker}:`, error);
      return null;
    }
  });
}

/**
 * Fetch historical daily data from Stooq
 */
export async function fetchStooqHistory(ticker: string, startDate?: string): Promise<Array<{ date: string; close: number }>> {
  const stooqTicker = resolveStooqTicker(ticker);
  if (!stooqTicker) return [];
  const cacheKey = `stooq_history_${stooqTicker}_${startDate || 'all'}`;
  const cached = getCached<Array<{ date: string; close: number }>>(cacheKey);
  if (cached) return cached;

  // Check persistent SQLite cache first
  const cachedData = loadHistoricalPrices(stooqTicker, startDate);
  const lastCached = getLastCachedDate(stooqTicker);
  const today = new Date().toISOString().split('T')[0];

  // If we have cached data and it's recent (within 2 days), use it
  if (cachedData.length > 10 && lastCached && lastCached >= today.slice(0, 8)) {
    setCached(cacheKey, cachedData, 12 * 3600);
    return cachedData;
  }

  // Fetch only missing data (from last cached date or startDate)
  const fetchFrom = lastCached && lastCached > (startDate || '2000-01-01')
    ? lastCached  // fetch from last cached date onwards
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
      if (text.includes('Przekroczony') || text.includes('limit')) {
        console.warn(`Stooq rate limit hit for ${stooqTicker}, using SQLite cache (${cachedData.length} points)`);
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
      const dateIdx = headers.findIndex(h => h.toLowerCase() === 'data' || h.toLowerCase() === 'date');
      const closeIdx = headers.findIndex(h => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close');

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
