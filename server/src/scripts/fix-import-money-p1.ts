/* eslint-disable no-console */
/**
 * One-shot backfill po audycie parserów 2026-09 (PR „Pieniądze"). Dwie korekty
 * danych już zaimportowanych — poprawki parserów działają tylko na NOWE importy,
 * a klucz dedup operacji (date, type, amount, currency, ticker) nie obejmuje
 * `fx_rate`, więc ponowny import niczego by nie nadpisał.
 *
 * 1. Kurs `fx_exchange` z Trading 212 i importu uniwersalnego: zapisywany jako
 *    `to/from`, więc wymiana PLN→USD miała ~0,25 zamiast ~4 „PLN za 1 USD"
 *    (konwencja `CashOperation.fxRate`, czytana przez `plnPerXFromOp`). Kurs
 *    liczymy na nowo z KWOT obu nóg (ta sama para, data i batch, przeciwne
 *    znaki) — jednoznacznie, bez zgadywania orientacji. Tylko pary z PLN.
 * 2. Trading 212: podatek u źródła księgowany jako osobny `fee` obok dywidendy,
 *    której `Total` jest już netto → podatek odjęty dwa razy. Wiersze
 *    „Podatek u źródła …" z source='trading212' są usuwane.
 *
 * Bezpieczeństwo:
 *   - Domyślnie DRY-RUN; --apply zapisuje, --only=ID ogranicza do portfela
 *   - Idempotentny: drugi przebieg nie znajduje kandydatów
 *   - Noga bez jednoznacznej pary (0 albo >1 kandydatów) jest raportowana i pomijana
 *   - Po zmianie podbija dataVersion portfela
 *
 * Usage (lokalnie):
 *   npm run fix:import-money-p1 -w server              # dry-run
 *   npm run fix:import-money-p1 -w server -- --apply
 *
 * Production (tylko dist, DATA_DIR OBOWIĄZKOWY, proces jako właściciel data/):
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/app && sudo -u ike-terminal DATA_DIR=/opt/ike-terminal/data node server/dist/scripts/fix-import-money-p1.js'
 *   # … --apply, potem: systemctl restart ike-terminal (memo historii jest in-memory)
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { bumpPortfolioDataVersion } from '../db/data-version.js';
import { fxExchangeRate } from '../parsers/utils.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db', 'import_profiles.db']);

interface FxRow {
  id: number;
  date: string;
  amount: number;
  currency: string;
  fx_rate: number | null;
  fx_pair: string;
  import_batch: string | null;
  source: string;
}

interface RateFix {
  portfolioId: string;
  ids: number[];
  pair: string;
  date: string;
  source: string;
  oldRate: number | null;
  newRate: number;
}

interface WhtRow {
  id: number;
  date: string;
  description: string;
  amount: number;
  currency: string;
}

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function findRateFixes(portfolioId: string, ambiguous: string[]): RateFix[] {
  const rows = getDb(portfolioId)
    .prepare(
      'SELECT id, date, amount, currency, fx_rate, fx_pair, import_batch, source FROM cash_operations ' +
        "WHERE operation_type = 'fx_exchange' AND source IN ('trading212', 'generic') " +
        "AND fx_pair LIKE '%PLN%'",
    )
    .all() as FxRow[];

  const groups = new Map<string, FxRow[]>();
  for (const r of rows) {
    const key = `${r.date}|${r.import_batch ?? ''}|${r.fx_pair}|${r.source}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }

  const fixes: RateFix[] = [];
  for (const legs of groups.values()) {
    const debits = legs.filter((l) => l.amount < 0);
    const credits = legs.filter((l) => l.amount > 0);
    if (debits.length !== 1 || credits.length !== 1) {
      ambiguous.push(
        `[${portfolioId}] ${legs[0].date} ${legs[0].fx_pair} (${legs[0].source}): ` +
          `${debits.length} nóg ujemnych / ${credits.length} dodatnich — pominięto`,
      );
      continue;
    }
    const [from, to] = [debits[0], credits[0]];
    const newRate = fxExchangeRate(from, to);
    if (!newRate) continue;
    const wrong = legs.filter((l) => !l.fx_rate || Math.abs(l.fx_rate / newRate - 1) > 0.01);
    if (wrong.length === 0) continue;
    fixes.push({
      portfolioId,
      ids: wrong.map((l) => l.id),
      pair: from.fx_pair,
      date: from.date,
      source: from.source,
      oldRate: wrong[0].fx_rate,
      newRate,
    });
  }
  return fixes;
}

function findPhantomWht(portfolioId: string): WhtRow[] {
  return getDb(portfolioId)
    .prepare(
      'SELECT id, date, description, amount, currency FROM cash_operations ' +
        "WHERE operation_type = 'fee' AND source = 'trading212' " +
        "AND description LIKE 'Podatek u źródła%'",
    )
    .all() as WhtRow[];
}

function main() {
  const apply = process.argv.includes('--apply');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  const portfolios = only ? [only] : listPortfolios();

  console.log(`Skanowanie ${portfolios.length} portfela/i w ${config.dataDir}`);
  console.log(`Tryb: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

  const ambiguous: string[] = [];
  const rateFixes: RateFix[] = [];
  const wht = new Map<string, WhtRow[]>();
  for (const pid of portfolios) {
    try {
      rateFixes.push(...findRateFixes(pid, ambiguous));
      const w = findPhantomWht(pid);
      if (w.length > 0) wht.set(pid, w);
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  console.log(`1) Kursy fx_exchange do przeliczenia: ${rateFixes.length} wymian(a)`);
  for (const f of rateFixes) {
    console.log(
      `   [${f.portfolioId}] ${f.date.slice(0, 10)} ${f.pair} (${f.source}): ${f.oldRate ?? '—'} → ${f.newRate}`,
    );
  }
  if (ambiguous.length > 0) {
    console.log(`   Niejednoznaczne (bez zmian): ${ambiguous.length}`);
    for (const a of ambiguous) console.log(`   ${a}`);
  }
  const whtCount = [...wht.values()].reduce((s, w) => s + w.length, 0);
  console.log(`\n2) Zdublowany podatek u źródła T212 do usunięcia: ${whtCount} wiersz(y)`);
  for (const [pid, rows] of wht) {
    for (const r of rows) {
      console.log(
        `   [${pid}] ${r.date.slice(0, 10)} ${r.amount} ${r.currency} — ${r.description}`,
      );
    }
  }

  if (!apply) {
    console.log('\nDRY-RUN — nic nie zmieniono. Uruchom z --apply, aby zapisać.');
    return;
  }

  const touched = new Set<string>();
  for (const f of rateFixes) {
    const stmt = getDb(f.portfolioId).prepare(
      'UPDATE cash_operations SET fx_rate = ? WHERE id = ?',
    );
    for (const id of f.ids) stmt.run(f.newRate, id);
    touched.add(f.portfolioId);
  }
  for (const [pid, rows] of wht) {
    const db = getDb(pid);
    const del = db.prepare('DELETE FROM cash_operations WHERE id = ?');
    db.transaction(() => rows.forEach((r) => del.run(r.id)))();
    touched.add(pid);
  }
  for (const pid of touched) bumpPortfolioDataVersion(pid);
  console.log(`\n✅ Zmieniono dane w ${touched.size} portfelu/ach. Zrestartuj serwer.`);
}

main();
