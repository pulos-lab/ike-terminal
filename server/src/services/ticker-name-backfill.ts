import { CFD_TICKER_MAP } from 'shared';
import { getDb } from '../db/connection.js';
import { fetchYahooTickerName } from './ticker-search.js';

/**
 * Backfill ticker_map.name for entries where `name = ticker` — almost always a leftover
 * from the older POST /transactions auto-create code that used `ticker.toUpperCase()` as
 * a placeholder (Yahoo chart API doesn't return display names, only currency). We now
 * fetch the real name via Yahoo search on auto-create, but pre-existing rows stay broken
 * because `upsertTickerMapEntry` respects existing entries (force=false default).
 *
 * Scope is intentionally narrow — we only touch rows that look like auto-create
 * placeholders (ISIN prefix `AUTO_`) OR sit on a major equity exchange. This protects
 * certificate entries (e.g. ING Turbo `INTLGLD*`) where `name = ticker` is legitimate.
 *
 * CFD instruments (`OIL`/`GOLD`/`US500`/forex pairs) are additionally filtered out in
 * code via `CFD_TICKER_MAP` — Yahoo search would gladly return "Marathon Oil Corp."
 * for `OIL` and clobber the CFD name, even though the user's intent was a futures CFD.
 *
 * Idempotent — once a row gets a real name, the WHERE clause won't match it again.
 * Safe to call repeatedly (e.g. on every server startup). Skips silently on network
 * errors; the next startup retries. `fetchYahooTickerName` also requires an exact
 * symbol match on Yahoo's side, so even rows that slip into the candidate set won't
 * get a random first-quote name pasted in.
 */
export interface BackfillResult {
  candidates: number;
  updated: number;
  skipped: number;
}

interface Candidate {
  isin: string;
  ticker: string;
}

export async function backfillTickerNamesForPortfolio(pid: string): Promise<BackfillResult> {
  const db = getDb(pid);
  const candidates = db
    .prepare(
      `SELECT isin, ticker FROM ticker_map
       WHERE UPPER(name) = UPPER(ticker)
         AND price_source = 'yahoo'
         AND (
           isin LIKE 'AUTO\\_%' ESCAPE '\\'
           OR exchange IN ('NYSE', 'NASDAQ', 'GPW', 'NC', 'XETRA', 'LSE', 'TSX')
         )`,
    )
    .all() as Candidate[];

  if (candidates.length === 0) return { candidates: 0, updated: 0, skipped: 0 };

  // Skip CFD instruments — their tickers (OIL/GOLD/US500/…) collide with real
  // Yahoo equity symbols (Marathon Oil, Barrick Gold) and a name swap would be
  // semantically wrong even though Yahoo returns a valid match.
  const filtered = candidates.filter((c) => !CFD_TICKER_MAP[c.ticker.toUpperCase()]);

  const update = db.prepare('UPDATE ticker_map SET name = ? WHERE isin = ?');
  let updated = 0;
  let skipped = candidates.length - filtered.length;

  for (const c of filtered) {
    let yahooName: string | null = null;
    try {
      yahooName = await fetchYahooTickerName(c.ticker);
    } catch {
      // Network blip — leave for next startup
    }
    if (!yahooName || yahooName.toUpperCase() === c.ticker.toUpperCase()) {
      skipped++;
      continue;
    }
    update.run(yahooName, c.isin);
    updated++;
  }

  return { candidates: candidates.length, updated, skipped };
}
