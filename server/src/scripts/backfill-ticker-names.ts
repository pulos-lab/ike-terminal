/**
 * Backfill ticker_map.name for entries where `name = ticker` (auto-create from older
 * POST /transactions code that didn't fetch Yahoo's longname). Walks every portfolio,
 * runs Yahoo search for each candidate symbol, and updates the name in-place when a
 * better one is found. ISIN is the primary key — ticker_map row stays unchanged
 * otherwise.
 *
 * Usage:
 *   cd server && npx tsx src/scripts/backfill-ticker-names.ts          # all portfolios
 *   cd server && npx tsx src/scripts/backfill-ticker-names.ts --dry-run
 *   cd server && npx tsx src/scripts/backfill-ticker-names.ts --only=<portfolioId>
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { backfillTickerNamesForPortfolio } from '../services/ticker-name-backfill.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db']);

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function parseArgs() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null;
  return { only };
}

async function main() {
  const { only } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();
  if (portfolios.length === 0) {
    console.log('No portfolio databases found in', config.dataDir);
    return;
  }

  console.log(`Backfilling ticker_map.name across ${portfolios.length} portfolio(s)\n`);

  let totalCandidates = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const pid of portfolios) {
    try {
      const { candidates, updated, skipped } = await backfillTickerNamesForPortfolio(pid);
      totalCandidates += candidates;
      totalUpdated += updated;
      totalSkipped += skipped;
      if (candidates === 0) {
        console.log(`  ${pid}: clean`);
      } else {
        console.log(
          `  ${pid}: ${candidates} candidate(s) → ${updated} updated, ${skipped} skipped`,
        );
      }
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Portfolios scanned:       ${portfolios.length}`);
  console.log(`Candidates found:         ${totalCandidates}`);
  console.log(`Names updated:            ${totalUpdated}`);
  console.log(`Skipped (no Yahoo match): ${totalSkipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
