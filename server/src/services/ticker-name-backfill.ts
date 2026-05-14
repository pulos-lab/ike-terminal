import { getDb } from '../db/connection.js';
import { fetchYahooTickerName } from './ticker-search.js';

/**
 * Backfill ticker_map.name for entries where `name = ticker` — almost always a leftover
 * from the older POST /transactions auto-create code that used `ticker.toUpperCase()` as
 * a placeholder (Yahoo chart API doesn't return display names, only currency). We now
 * fetch the real name via Yahoo search on auto-create, but pre-existing rows stay broken
 * because `upsertTickerMapEntry` respects existing entries (force=false default).
 *
 * Idempotent — once a row gets a real name, the WHERE clause won't match it again.
 * Safe to call repeatedly (e.g. on every server startup). Skips silently on network
 * errors; the next startup retries.
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
       WHERE UPPER(name) = UPPER(ticker)`,
    )
    .all() as Candidate[];

  if (candidates.length === 0) return { candidates: 0, updated: 0, skipped: 0 };

  const update = db.prepare('UPDATE ticker_map SET name = ? WHERE isin = ?');
  let updated = 0;
  let skipped = 0;

  for (const c of candidates) {
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
