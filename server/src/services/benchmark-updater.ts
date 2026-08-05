/**
 * Periodically fetches latest benchmark close prices and appends
 * them to the persistent price_history.db cache.
 *
 * Called on server startup (with delay) and every 6 hours.
 * Primary source: Stooq live quote API.
 * Fallback: Yahoo Finance (range=1d) when Stooq is blocked.
 */
import { getLastCachedDate, storeHistoricalPrices } from './history-cache.js';
import { STOOQ_USER_AGENT, BENCHMARK_YAHOO_FALLBACK, parseStooqLiveCsv } from './stooq-utils.js';
import { detectYahooBlock, getYahooGuard, withYahooLimit } from './yahoo-guard.js';

const BENCHMARK_TICKERS = ['wig', 'wig20', 'mwig40', 'swig80'];
const FETCH_TIMEOUT = 10_000;

/**
 * Fetch today's close from Stooq live quote API.
 * Returns { date, close } or null if unavailable.
 */
async function fetchStooqLiveClose(
  ticker: string,
): Promise<{ date: string; close: number } | null> {
  const url = `https://stooq.pl/q/l/?s=${ticker}&f=sd2t2ohlcv&h&e=csv`;
  const response = await fetch(url, {
    headers: { 'User-Agent': STOOQ_USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const text = await response.text();
  return parseStooqLiveCsv(text);
}

/**
 * Fetch today's close from Yahoo Finance (range=1d).
 * Fallback when Stooq is blocked.
 */
async function fetchYahooLiveClose(
  yahooTicker: string,
): Promise<{ date: string; close: number } | null> {
  try {
    // Ten sam limiter/bezpiecznik co reszta ścieżek Yahoo — limit jest per IP,
    // nie per moduł, więc benchmarki nie mogą go omijać bokiem.
    if (getYahooGuard().isBlocked()) return null;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=1d`;
    const response = await withYahooLimit(() =>
      fetch(url, {
        headers: { 'User-Agent': STOOQ_USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      }),
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (detectYahooBlock(response.status, body)) getYahooGuard().registerBlock();
      return null;
    }
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

      // Try Stooq live API first
      let liveData = await fetchStooqLiveClose(ticker);
      let source = 'stooq-live';

      // Fallback to Yahoo if Stooq is blocked
      if (!liveData) {
        const yahooTicker = BENCHMARK_YAHOO_FALLBACK[ticker];
        if (yahooTicker) {
          liveData = await fetchYahooLiveClose(yahooTicker);
          source = 'yahoo-live';
        }
      }

      if (!liveData) {
        console.warn(
          `[benchmark-updater] ${ticker}: could not fetch live price (Stooq + Yahoo failed)`,
        );
        continue;
      }

      // Only store if newer than what we have
      if (liveData.date > lastDate) {
        storeHistoricalPrices(ticker, [liveData], source);
        console.log(
          `[benchmark-updater] ${ticker}: +1 new data point (${liveData.date}, close=${liveData.close}) via ${source}`,
        );
      }
    } catch (error) {
      console.error(`[benchmark-updater] Failed to update ${ticker}:`, error);
    }
  }
}
