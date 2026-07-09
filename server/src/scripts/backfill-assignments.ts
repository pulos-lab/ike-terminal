/**
 * Backfill znacznika `option_event='assignment'` dla istniejących transakcji akcyjnych
 * powstałych z przypisania opcji. Re-import IBKR NIE ustawia znacznika na starych wierszach
 * (dedup zliczeniowy tylko INSERT-uje nowe), więc oznaczamy je jednorazowo tym skryptem.
 *
 * Detekcja (precyzyjna, bez sieci): transakcja akcyjna, której `price` ≈ strike opcji
 * zamkniętej TEGO SAMEGO DNIA na TYM SAMYM instrumencie bazowym. Przy przypisaniu broker
 * księguje akcje dokładnie po cenie wykonania (strike), więc dopasowanie strike↔cena jest
 * jednoznaczne i odporne na splity (inaczej niż porównanie z kursem Yahoo).
 *
 * Usage (local):    cd server && npx tsx src/scripts/backfill-assignments.ts [--only=ID] [--dry-run]
 * Usage (prod VPS): ssh … 'cd /opt/ike-terminal/server && npx tsx src/scripts/backfill-assignments.ts'
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { parseOccTicker } from 'shared';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { getAllTransactions } from '../db/transactions-repo.js';
import { getTickerMap } from '../db/ticker-map-repo.js';
import { bumpPortfolioDataVersion } from '../db/data-version.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'import_profiles.db']);
const STRIKE_TOLERANCE = 0.01; // 1% — cena akcji z przypisania = strike (dokładnie)

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function parseArgs(): { only: string | null; dryRun: boolean } {
  return {
    only: process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null,
    dryRun: process.argv.includes('--dry-run'),
  };
}

function backfillPortfolio(pid: string, dryRun: boolean): number {
  const txs = getAllTransactions(pid);
  const tickerMap = getTickerMap(pid);

  // Strike'i opcji zamkniętych/otwartych per (dzień, underlying) — z transakcji OPT:.
  const optionStrikesByDay = new Map<string, Array<{ underlying: string; strike: number }>>();
  for (const t of txs) {
    if (!t.isin.startsWith('OPT:')) continue;
    const parsed = parseOccTicker(t.isin.slice('OPT:'.length));
    if (!parsed) continue;
    const day = t.date.split('T')[0];
    const arr = optionStrikesByDay.get(day) ?? [];
    arr.push({ underlying: parsed.underlying, strike: parsed.strike });
    optionStrikesByDay.set(day, arr);
  }

  const toMark: number[] = [];
  for (const t of txs) {
    if (t.id == null) continue;
    if (t.optionEvent) continue; // już oznaczone
    if (t.isin.startsWith('OPT:') || t.category === 'option') continue; // interesują nas AKCJE
    const ticker = tickerMap.get(t.isin)?.ticker;
    if (!ticker) continue;
    const sameDay = optionStrikesByDay.get(t.date.split('T')[0]);
    if (!sameDay) continue;
    const matches = sameDay.some(
      (o) => o.underlying === ticker && Math.abs(t.price / o.strike - 1) < STRIKE_TOLERANCE,
    );
    if (matches) toMark.push(t.id);
  }

  if (toMark.length === 0) return 0;
  console.log(`  ${pid}: ${toMark.length} transakcji z przypisania${dryRun ? ' (dry-run)' : ''}`);
  if (dryRun) return toMark.length;

  const db = getDb(pid);
  const stmt = db.prepare(
    "UPDATE transactions SET option_event = 'assignment' WHERE id = ? AND option_event IS NULL",
  );
  const run = db.transaction((ids: number[]) => {
    let n = 0;
    for (const id of ids) n += stmt.run(id).changes;
    return n;
  });
  const changed = run(toMark);
  if (changed > 0) bumpPortfolioDataVersion(pid);
  return changed;
}

function main() {
  const { only, dryRun } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();
  if (portfolios.length === 0) {
    console.log('Brak baz portfeli w', config.dataDir);
    return;
  }
  console.log(`Backfill przypisań w ${portfolios.length} portfelu(-ach) (${config.dataDir})\n`);
  let total = 0;
  for (const pid of portfolios) total += backfillPortfolio(pid, dryRun);
  console.log(`\nRazem oznaczonych: ${total}`);
}

main();
