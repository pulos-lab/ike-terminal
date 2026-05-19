/**
 * Diagnostic: list manually-added transactions whose stored `currency` does not match
 * the quote currency of the resolved ticker in `ticker_map`. These are likely artifacts
 * of the old AddTransactionDialog flow which overwrote `currency` with the user's
 * settlement currency choice (e.g. AAPL stored as PLN instead of USD).
 *
 * Read-only — does not mutate anything. User decides what to do per row.
 *
 * Usage:
 *   cd server && npx tsx src/scripts/find-broken-manual-fx.ts
 *   cd server && npx tsx src/scripts/find-broken-manual-fx.ts --only=<portfolioId>
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db']);

interface Row {
  id: number;
  date: string;
  isin: string;
  paper_name: string;
  side: string;
  currency: string;
  payment_currency: string | null;
  fx_rate: number | null;
  ticker_currency: string | null;
  ticker: string | null;
}

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function findSuspicious(pid: string): Row[] {
  const db = getDb(pid);
  return db
    .prepare(
      `
      SELECT
        t.id, t.date, t.isin, t.paper_name, t.side,
        t.currency, t.payment_currency, t.fx_rate,
        tm.currency AS ticker_currency,
        tm.ticker AS ticker
      FROM transactions t
      LEFT JOIN ticker_map tm ON tm.isin = t.isin
      WHERE t.source = 'manual'
        AND tm.currency IS NOT NULL
        AND UPPER(tm.currency) <> UPPER(t.currency)
      ORDER BY t.date DESC, t.id DESC
    `,
    )
    .all() as Row[];
}

function parseArgs(): { only: string | null } {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null;
  return { only };
}

function main() {
  const { only } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();
  if (portfolios.length === 0) {
    console.log('No portfolio databases found in', config.dataDir);
    return;
  }

  let totalSuspicious = 0;
  for (const pid of portfolios) {
    let rows: Row[];
    try {
      rows = findSuspicious(pid);
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
      continue;
    }
    if (rows.length === 0) {
      console.log(`  ${pid}: clean`);
      continue;
    }
    totalSuspicious += rows.length;
    console.log(`\n  ${pid}: ${rows.length} suspicious manual tx(s)`);
    for (const r of rows) {
      console.log(
        `    #${r.id} ${r.date} ${r.side} ${r.ticker ?? r.isin} (${r.paper_name}) — ` +
          `stored currency=${r.currency} but ticker_map.currency=${r.ticker_currency}; ` +
          `payment_currency=${r.payment_currency ?? '(null)'}, fx_rate=${r.fx_rate ?? '(null)'}`,
      );
    }
  }
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Portfolios scanned:        ${portfolios.length}`);
  console.log(`Total suspicious manual:   ${totalSuspicious}`);
  if (totalSuspicious > 0) {
    console.log(
      '\nNote: edit each suspicious transaction in the UI (Transakcje → ołówek) ' +
        'to set correct paymentCurrency + fxRate. The `currency` field will be ' +
        'restored from ticker_map on save.',
    );
  }
}

main();
