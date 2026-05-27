/* eslint-disable no-console */
/**
 * Diagnostic: pokazuje wszystkie wpisy ticker_map dla danego ISIN-u + ich transakcje.
 * Pomaga zrozumieć dlaczego resolver mógł zwrócić określoną wartość.
 *
 * Usage:
 *   node dist/scripts/diagnose-isin.js PLSEVNT00018
 *   node dist/scripts/diagnose-isin.js SEVENET   # nazwa pasująca do name LIKE
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db']);

interface TickerRow {
  isin: string;
  ticker: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  price_source: string | null;
}

function listPortfolios(): string[] {
  const entries = readdirSync(config.dataDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function main(): void {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: node dist/scripts/diagnose-isin.js <ISIN|name>');
    process.exit(1);
  }

  const portfolios = listPortfolios();
  console.log(`Szukam "${query}" w ${portfolios.length} portfelach (${config.dataDir})\n`);

  let totalHits = 0;
  for (const pid of portfolios) {
    try {
      const db = getDb(pid);
      // Match po ISIN lub name (case-insensitive contains)
      const rows = db
        .prepare(
          `SELECT isin, ticker, name, exchange, currency, price_source
             FROM ticker_map
            WHERE isin = ? OR isin LIKE ? OR UPPER(name) LIKE ? OR UPPER(ticker) LIKE ?`,
        )
        .all(
          query,
          `%${query}%`,
          `%${query.toUpperCase()}%`,
          `%${query.toUpperCase()}%`,
        ) as TickerRow[];

      for (const row of rows) {
        totalHits++;
        console.log(`─── Portfolio: ${pid.slice(0, 20)} ───`);
        console.log(`  ISIN:         ${row.isin}`);
        console.log(`  ticker:       ${row.ticker}`);
        console.log(`  name:         ${row.name}`);
        console.log(`  exchange:     ${row.exchange}`);
        console.log(`  currency:     ${row.currency}`);
        console.log(`  price_source: ${row.price_source}`);

        // Pobierz transakcje
        const txs = db
          .prepare(
            `SELECT date, paper_name, side, quantity, price, source
               FROM transactions
              WHERE isin = ?
              ORDER BY date DESC
              LIMIT 5`,
          )
          .all(row.isin) as Array<{
          date: string;
          paper_name: string | null;
          side: string;
          quantity: number;
          price: number;
          source: string;
        }>;

        if (txs.length === 0) {
          console.log(`  transactions: 0 (orphan)`);
        } else {
          console.log(`  transactions (last ${txs.length}):`);
          for (const tx of txs) {
            console.log(
              `    ${tx.date}  paper="${tx.paper_name}"  ${tx.side}${tx.quantity}@${tx.price}  src=${tx.source}`,
            );
          }
        }
        console.log('');
      }
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  console.log(`Razem ${totalHits} wpis(ów).`);
}

main();
