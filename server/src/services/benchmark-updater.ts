/**
 * Periodically fetches latest benchmark close prices from Stooq
 * and appends them to the persistent price_history.db cache.
 *
 * Called on server startup (with delay) and every 6 hours.
 * Uses the live quote API as primary source (historical API is blocked).
 * Gracefully handles Stooq rate-limiting — logs a warning and skips.
 */
import { getLastCachedDate, storeHistoricalPrices } from './history-cache.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const BENCHMARK_TICKERS = ['wig', 'wig20', 'mwig40', 'swig80'];

/** Detect Stooq block/rate-limit responses */
function isStooqBlocked(text: string): boolean {
  return text.includes('Przekroczony') || text.includes('limit') || text.includes('www@stooq.pl');
}

/**
 * Fetch today's close from Stooq live quote API.
 * Returns { date, close } or null if unavailable.
 */
async function fetchLiveClose(ticker: string): Promise<{ date: string; close: number } | null> {
  const url = `https://stooq.pl/q/l/?s=${ticker}&f=sd2t2ohlcv&h&e=csv`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  const text = await response.text();

  if (isStooqBlocked(text)) {
    console.warn(`[benchmark-updater] Stooq live API blocked for ${ticker}`);
    return null;
  }

  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;

  const headers = lines[0].split(',');
  const values = lines[1].split(',');

  const dateIdx = headers.findIndex(h => h.toLowerCase() === 'data' || h.toLowerCase() === 'date');
  const closeIdx = headers.findIndex(h => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close');

  if (dateIdx === -1 || closeIdx === -1) return null;

  const date = values[dateIdx]?.trim();
  const close = parseFloat(values[closeIdx]?.trim());

  if (!date || isNaN(close)) return null;
  return { date, close };
}

/**
 * Fetch latest benchmark prices from Stooq and store in SQLite cache.
 * Uses live quote API to get today's closing price.
 */
export async function updateBenchmarkPrices(): Promise<void> {
  for (const ticker of BENCHMARK_TICKERS) {
    try {
      const lastDate = getLastCachedDate(ticker);
      if (!lastDate) {
        // No seed data — skip (run seed-benchmarks first)
        console.warn(`[benchmark-updater] ${ticker}: no seed data, skipping (run seed-benchmarks)`);
        continue;
      }

      const today = new Date().toISOString().split('T')[0];
      // Already up to date
      if (lastDate >= today) continue;

      // Fetch today's close from live API
      const liveData = await fetchLiveClose(ticker);

      if (!liveData) {
        console.warn(`[benchmark-updater] ${ticker}: could not fetch live price`);
        continue;
      }

      // Only store if newer than what we have
      if (liveData.date > lastDate) {
        storeHistoricalPrices(ticker, [liveData], 'stooq-live');
        console.log(`[benchmark-updater] ${ticker}: +1 new data point (${liveData.date}, close=${liveData.close}) via live API`);
      }
    } catch (error) {
      console.error(`[benchmark-updater] Failed to update ${ticker}:`, error);
    }
  }
}
