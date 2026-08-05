/**
 * Żywa diagnostyka batcha cen (Yahoo v7) — jeden request na wiele symboli.
 * Uruchomienie: npx tsx src/scripts/probe-batch-quotes.ts
 */
import { primeYahooQuotes, summarizeQuoteFreshness } from '../src/services/yahoo-quotes.js';
import { getCached } from '../src/services/price-cache.js';

const SYMBOLS = ['AAPL', 'MSFT', 'CDR.WA', 'PKN.WA', 'SHEL.L', 'USDPLN=X', 'EURPLN=X'];

let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
  calls++;
  console.log(`  → HTTP ${String(args[0]).slice(0, 110)}…`);
  return realFetch(...args);
}) as typeof realFetch;

const t0 = Date.now();
const { primed, missed } = await primeYahooQuotes(SYMBOLS);
const ms = Date.now() - t0;

console.log(`\nprimed=${primed}/${SYMBOLS.length} missed=[${missed.join(', ')}] w ${ms} ms`);
console.log(`requestów HTTP (łącznie z auth/crumb): ${calls}\n`);
for (const s of SYMBOLS) {
  const q = getCached<any>(`yahoo_live_${s}`);
  console.log(
    `  ${s.padEnd(10)} ${q ? `${q.price} ${q.currency} state=${q.marketState} prev=${q.previousClose}` : '— brak'}`,
  );
}
console.log('\nfx_USDPLN =', getCached('fx_USDPLN'));
console.log('świeżość:', summarizeQuoteFreshness(SYMBOLS));
