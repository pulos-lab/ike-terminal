/**
 * One-shot recomputation of paymentCurrency for all Bossa/DEGIRO transactions
 * across every portfolio in DATA_DIR.
 *
 * Use after deploying the reconciler feature to fix historical imports made
 * before the parser hardcode was replaced by ledger simulation.
 *
 * Usage (local):
 *   cd server && npx tsx src/scripts/reconcile-all-portfolios.ts
 *
 * Usage (production VPS, after deploy):
 *   ssh user@vps 'cd /opt/ike-terminal/server && npx tsx src/scripts/reconcile-all-portfolios.ts'
 *
 * Flags:
 *   --dry-run   Print what WOULD change without writing. (not yet implemented
 *               — the underlying reconciler writes unconditionally when the
 *               computed value differs. Kept as a placeholder for future.)
 *   --only=ID   Process a single portfolio by its DB filename (sans `.db`).
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { reconcilePaymentCurrencies } from '../services/payment-currency-reconciler.js';
import { getAllTransactions } from '../db/transactions-repo.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db']);

function listPortfolios(): string[] {
  const entries = readdirSync(config.dataDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function parseArgs(): { only: string | null } {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null;
  return { only };
}

async function main() {
  const { only } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();

  if (portfolios.length === 0) {
    console.log('No portfolio databases found in', config.dataDir);
    process.exit(0);
  }

  console.log(
    `Reconciling paymentCurrency across ${portfolios.length} portfolio(s) in ${config.dataDir}\n`,
  );

  let totalUpdated = 0;
  let totalWarnings = 0;
  const changed: Array<{ pid: string; updated: number; warnings: number; bossaDegiroTxs: number }> =
    [];

  for (const pid of portfolios) {
    try {
      const txs = getAllTransactions(pid);
      const bossaDegiroTxs = txs.filter(
        (t) => t.source === 'bossa' || t.source === 'degiro',
      ).length;

      const { updatedCount, warnings } = reconcilePaymentCurrencies(pid, ['bossa', 'degiro']);
      totalUpdated += updatedCount;
      totalWarnings += warnings.length;

      if (updatedCount > 0 || warnings.length > 0) {
        changed.push({ pid, updated: updatedCount, warnings: warnings.length, bossaDegiroTxs });
        console.log(
          `  ${pid}: ${updatedCount} updated, ${warnings.length} warnings (${bossaDegiroTxs} bossa/degiro txs)`,
        );
        for (const w of warnings.slice(0, 3)) console.log(`      ! ${w}`);
        if (warnings.length > 3)
          console.log(`      ... and ${warnings.length - 3} more warning(s)`);
      } else {
        console.log(`  ${pid}: clean (${bossaDegiroTxs} bossa/degiro txs)`);
      }
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Total portfolios processed: ${portfolios.length}`);
  console.log(`Total transactions updated: ${totalUpdated}`);
  console.log(`Total warnings:             ${totalWarnings}`);
  console.log(`Portfolios with changes:    ${changed.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
