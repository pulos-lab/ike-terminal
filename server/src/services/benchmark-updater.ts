/**
 * Periodically fetches latest benchmark close prices from Stooq
 * and appends them to the persistent price_history.db cache.
 *
 * Called on server startup (with delay) and every 6 hours.
 * Gracefully handles Stooq rate-limiting — logs a warning and skips.
 */
import { getLastCachedDate, storeHistoricalPrices } from './history-cache.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const BENCHMARK_TICKERS = ['wig', 'wig20', 'mwig40', 'swig80'];

/**
 * Fetch latest benchmark prices from Stooq and store in SQLite cache.
 * Only fetches data newer than the last cached date for each ticker.
 */
export async function updateBenchmarkPrices(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];

  for (const ticker of BENCHMARK_TICKERS) {
    try {
      const lastDate = getLastCachedDate(ticker);
      if (!lastDate) {
        // No seed data — skip (run seed-benchmarks first)
        continue;
      }

      // Already up to date
      if (lastDate >= today) continue;

      const d1 = lastDate.replace(/-/g, '');
      const d2 = today.replace(/-/g, '');
      const url = `https://stooq.pl/q/d/l/?s=${ticker}&i=d&d1=${d1}&d2=${d2}`;

      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      const text = await response.text();

      // Rate limit detection
      if (text.includes('Przekroczony') || text.includes('limit')) {
        console.warn(`[benchmark-updater] Stooq rate limit for ${ticker}, skipping`);
        continue;
      }

      const lines = text.trim().split('\n');
      if (lines.length < 2) {
        // Empty response — Stooq sometimes returns just headers or nothing
        continue;
      }

      // Parse CSV: find Data and Zamkniecie/Close columns
      const headers = lines[0].split(',');
      const dateIdx = headers.findIndex(h => h.toLowerCase() === 'data' || h.toLowerCase() === 'date');
      const closeIdx = headers.findIndex(h => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close');

      if (dateIdx === -1 || closeIdx === -1) continue;

      const newData: Array<{ date: string; close: number }> = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length <= Math.max(dateIdx, closeIdx)) continue;

        const date = cols[dateIdx].trim();
        const close = parseFloat(cols[closeIdx].trim());

        // Only store rows newer than what we already have
        if (date && !isNaN(close) && date > lastDate) {
          newData.push({ date, close });
        }
      }

      if (newData.length > 0) {
        storeHistoricalPrices(ticker, newData, 'stooq');
        console.log(`[benchmark-updater] ${ticker}: +${newData.length} new data points (up to ${newData[newData.length - 1].date})`);
      }
    } catch (error) {
      console.error(`[benchmark-updater] Failed to update ${ticker}:`, error);
    }
  }
}
