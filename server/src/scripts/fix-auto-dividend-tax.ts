/* eslint-disable no-console */
/**
 * One-shot korekta dywidend auto-yahoo z USA policzonych zawyżoną stawką podatku.
 *
 * Tło: do 2026-07 tabele stawek zakładały brak W-8BEN dla USA (30% WHT), podczas
 * gdy Bossa/XTB/mBank honorują W-8BEN i potrącają traktatowe 15% (potwierdzone
 * realnymi wyciągami). Skaner dywidend (dividend-scanner.ts) wstawiał więc wpisy
 * z netto 70% brutto zamiast 85% (IKE/IKZE) i 66% zamiast 81% (zwykłe).
 *
 * Skrypt naprawia WYŁĄCZNIE wpisy source='auto-yahoo' (importy z plików brokera
 * niosą realne kwoty i są poprawne). Cel rozpoznaje po opisie generowanym przez
 * skaner: "Dywidenda TICKER (N szt. × X CUR, podatek P% [KONTO])":
 *   - "podatek 30% [IKE/IKZE]" → tylko USA (DE na IKE/IKZE to 26%) → 15%
 *   - "podatek 34% [zwykłe]"   → tylko USA → 19%
 *   - "podatek 30% [zwykłe]" NIE jest ruszane — to Niemcy (30.4% zaokrąglone)!
 *
 * Bezpieczeństwo:
 *   - Domyślnie DRY-RUN; --apply zapisuje, --only=ID ogranicza do portfela
 *   - Przed korektą odtwarza brutto z opisu (szt. × kwota) i weryfikuje, że
 *     zapisane netto zgadza się ze STARĄ stawką — wpis zmieniony ręcznie przez
 *     użytkownika jest pomijany i raportowany
 *   - Idempotentny: po korekcie opis ma już "podatek 15%/19%" i nie łapie się
 *
 * Usage:
 *   cd server && npx tsx src/scripts/fix-auto-dividend-tax.ts            # dry-run
 *   cd server && npx tsx src/scripts/fix-auto-dividend-tax.ts --apply    # commit
 *   cd server && npx tsx src/scripts/fix-auto-dividend-tax.ts --only=ID  # 1 portfel
 *
 * Production:
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/server && npx tsx src/scripts/fix-auto-dividend-tax.ts'
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/server && npx tsx src/scripts/fix-auto-dividend-tax.ts --apply'
 *   # Po --apply zrestartuj serwer — memo historii portfela (history-memo) jest
 *   # in-memory i nie zobaczy zmiany z zewnętrznego procesu.
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db']);

/** Zawyżona stawka → poprawna stawka, per typ konta z opisu. */
const CORRECTIONS: Record<string, { oldRate: number; newRate: number }> = {
  '30|IKE/IKZE': { oldRate: 0.3, newRate: 0.15 },
  '34|zwykłe': { oldRate: 0.34, newRate: 0.19 },
};

const DESCRIPTION_RE =
  /^Dywidenda (\S+) \((\d+(?:\.\d+)?) szt\. × (\d+(?:\.\d+)?) (\w+), podatek (\d+)% \[(IKE\/IKZE|zwykłe)\]\)$/u;

interface OperationRow {
  id: number;
  date: string;
  description: string;
  amount: number;
  currency: string;
  ticker: string | null;
}

interface Correction {
  portfolioId: string;
  row: OperationRow;
  newAmount: number;
  newDescription: string;
}

interface Skipped {
  portfolioId: string;
  row: OperationRow;
  reason: string;
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

function listPortfolios(): string[] {
  const entries = readdirSync(config.dataDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function findCorrections(portfolioId: string, skipped: Skipped[]): Correction[] {
  const db = getDb(portfolioId);
  const rows = db
    .prepare(
      'SELECT id, date, description, amount, currency, ticker FROM cash_operations ' +
        "WHERE source = 'auto-yahoo' AND operation_type = 'dividend' " +
        "AND description LIKE '%podatek 3_%'",
    )
    .all() as OperationRow[];

  const out: Correction[] = [];
  for (const row of rows) {
    const m = row.description.match(DESCRIPTION_RE);
    if (!m) {
      skipped.push({ portfolioId, row, reason: 'opis nie pasuje do formatu skanera' });
      continue;
    }
    const [, , sharesStr, perShareStr, , pctStr, accountType] = m;
    const correction = CORRECTIONS[`${pctStr}|${accountType}`];
    // 30% [zwykłe] = Niemcy (30.4% po zaokrągleniu) — celowo poza CORRECTIONS
    if (!correction) continue;

    // Odtwórz brutto tak jak skaner: round2(szt. × kwota/akcję)
    const gross = roundTo2(Number(sharesStr) * Number(perShareStr));
    const expectedOldNet = roundTo2(gross - roundTo2(gross * correction.oldRate));
    if (Math.abs(row.amount - expectedOldNet) > 0.011) {
      skipped.push({
        portfolioId,
        row,
        reason: `netto ${row.amount} ≠ oczekiwane ${expectedOldNet} przy starej stawce — wpis edytowany ręcznie?`,
      });
      continue;
    }

    const newAmount = roundTo2(gross - roundTo2(gross * correction.newRate));
    const newPct = Math.round(correction.newRate * 100);
    const newDescription = row.description.replace(`podatek ${pctStr}%`, `podatek ${newPct}%`);
    out.push({ portfolioId, row, newAmount, newDescription });
  }
  return out;
}

function parseArgs() {
  return {
    apply: process.argv.includes('--apply'),
    only: process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function main() {
  const { apply, only } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();

  if (portfolios.length === 0) {
    console.log('No portfolio databases found in', config.dataDir);
    process.exit(0);
  }

  console.log(`Skanowanie ${portfolios.length} portfela/i w ${config.dataDir}`);
  console.log(`Tryb: ${apply ? 'APPLY (zapisuje zmiany)' : 'DRY-RUN (tylko podgląd)'}\n`);

  const all: Correction[] = [];
  const skipped: Skipped[] = [];
  for (const pid of portfolios) {
    try {
      all.push(...findCorrections(pid, skipped));
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`Pominięto ${skipped.length} wpis(ów):`);
    console.log('─'.repeat(120));
    for (const s of skipped) {
      console.log(
        `  [${pad(s.portfolioId, 20)}] ${s.row.date} ${pad(s.row.ticker ?? '?', 8)} ${s.row.amount} ${s.row.currency} — ${s.reason}`,
      );
    }
    console.log('─'.repeat(120));
    console.log('');
  }

  if (all.length === 0) {
    console.log('Brak wpisów do korekty — żadna dywidenda auto-yahoo nie ma zawyżonej stawki USA.');
    process.exit(0);
  }

  console.log(`Znaleziono ${all.length} wpis(ów) do korekty:`);
  console.log('─'.repeat(120));
  console.log(
    pad('PORTFEL', 20),
    pad('DATA', 10),
    pad('TICKER', 8),
    pad('BYŁO', 12),
    pad('BĘDZIE', 12),
    'NOWY OPIS',
  );
  console.log('─'.repeat(120));
  for (const c of all) {
    console.log(
      pad(c.portfolioId, 20),
      pad(c.row.date.slice(0, 10), 10),
      pad(c.row.ticker ?? '?', 8),
      pad(`${c.row.amount} ${c.row.currency}`, 12),
      pad(`${c.newAmount} ${c.row.currency}`, 12),
      c.newDescription,
    );
  }
  console.log('─'.repeat(120));

  if (!apply) {
    console.log(`\nDRY-RUN — żaden wpis nie został zmodyfikowany.`);
    console.log(`Aby wprowadzić zmiany uruchom ponownie z flagą --apply.`);
    process.exit(0);
  }

  let updated = 0;
  for (const c of all) {
    try {
      getDb(c.portfolioId)
        .prepare('UPDATE cash_operations SET amount = ?, description = ? WHERE id = ?')
        .run(c.newAmount, c.newDescription, c.row.id);
      updated++;
    } catch (err: any) {
      console.error(`  ${c.portfolioId}/#${c.row.id}: ERROR — ${err.message}`);
    }
  }

  console.log(`\nZaktualizowano ${updated}/${all.length} wpisów cash_operations.`);
  console.log('Zrestartuj serwer, żeby zinvalidować in-memory cache historii portfela.');
}

main();
