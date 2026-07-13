/**
 * Shared Stooq utilities — constants, CSV parsing, block detection.
 * Used by stooq.ts and benchmark-updater.ts.
 */

export const STOOQ_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/** Stooq ticker → Yahoo ticker mapping for benchmark live fallback */
export const BENCHMARK_YAHOO_FALLBACK: Record<string, string> = {
  wig: 'WIG.WA',
  wig20: 'WIG20.WA',
  mwig40: 'MWIG40.WA',
  swig80: 'SWIG80.WA',
};

/** Detect Stooq block/rate-limit responses (including new API key requirement) */
export function isStooqBlocked(text: string): boolean {
  return (
    text.includes('Przekroczony') ||
    text.includes('limit') ||
    text.includes('www@stooq.pl') ||
    text.includes('apikey')
  );
}

/**
 * Parse Stooq CSV header line into column indices for date and close fields.
 * Handles both Polish (Data/Zamknięcie) and English (Date/Close) headers.
 */
export function parseStooqCsvHeaders(headerLine: string): { dateIdx: number; closeIdx: number } {
  const headers = headerLine.split(',');
  const dateIdx = headers.findIndex(
    (h) => h.toLowerCase() === 'data' || h.toLowerCase() === 'date',
  );
  const closeIdx = headers.findIndex(
    (h) => h.toLowerCase().includes('zamkni') || h.toLowerCase() === 'close',
  );
  return { dateIdx, closeIdx };
}

/**
 * Parse Stooq live quote CSV (single row) into { date, close }.
 * Returns null if blocked, malformed, or missing data.
 */
export function parseStooqLiveCsv(text: string): { date: string; close: number } | null {
  if (isStooqBlocked(text)) return null;

  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;

  const values = lines[1].split(',');
  const { dateIdx, closeIdx } = parseStooqCsvHeaders(lines[0]);

  if (dateIdx === -1 || closeIdx === -1) return null;

  const date = values[dateIdx]?.trim();
  const close = parseFloat(values[closeIdx]?.trim());

  if (!date || isNaN(close)) return null;
  return { date, close };
}

/** Strip .WA/.NC exchange suffix from a Polish ticker. */
export function stripTickerSuffix(ticker: string): string {
  return ticker.replace(/\.(WA|NC)$/i, '');
}

/**
 * Normalize Bossa paper name by stripping broker-specific suffixes.
 * Bossa adds suffixes like `-FIX` (fix price), `-NC` (NewConnect), `-NC-FIX`,
 * `-C` (correction), `.WA` (Warsaw exchange). These cause mismatches when
 * the operations CSV uses a different variant than the transactions CSV.
 *
 * @example
 * normalizeBossaPaperName('PLASTBOX-FIX')   // 'PLASTBOX'
 * normalizeBossaPaperName('SEVENET-NC-FIX') // 'SEVENET'
 * normalizeBossaPaperName('CDR')            // 'CDR'
 * normalizeBossaPaperName('JSW.WA')         // 'JSW'
 */
export function normalizeBossaPaperName(name: string): string {
  return name
    .replace(/-NC(?:-FIX)?$/i, '')
    .replace(/-FIX$/i, '')
    .replace(/-C$/i, '')
    .replace(/\.WA$/i, '')
    .trim();
}

/**
 * Detect if a paper name indicates NewConnect (from Bossa suffix).
 */
export function isNewConnectPaperName(name: string): boolean {
  return /-NC(?:-FIX)?$/i.test(name);
}
