/* eslint-disable no-console */
/**
 * One-shot backfill: odsetki od wolnych środków z XTB → subkind='interest'.
 *
 * Tło: parser XTB księgował "Free funds interest" jako operation_type='other'
 * BEZ subkind, więc w panelu "Korekty i koszty" odsetki lądowały w kategorii
 * "Inne" zamiast w wirtualnej kategorii "Odsetki" (UI dzieli `other` po
 * subkind='interest'). Poprawka w parserze dotyczy tylko NOWYCH importów —
 * wpisy już zaimportowane trzeba oznaczyć wstecz.
 *
 * Zakres: WYŁĄCZNIE wiersze odsetek (dodatni przychód). Podatek od odsetek
 * ("Free-funds Interest Tax") jest księgowany jako operation_type='fee' i
 * ZOSTAJE kosztem — filtr na operation_type='other' go nie łapie, a dodatkowy
 * guard na "tax" w opisie chroni przed wpisem zaksięgowanym inaczej.
 *
 * Bezpieczeństwo:
 *   - Domyślnie DRY-RUN; --apply zapisuje, --only=ID ogranicza do portfela
 *   - Rusza tylko wpisy z subkind IS NULL — idempotentny (drugi przebieg = 0)
 *   - Nie zmienia kwot ani dat, wyłącznie subkind (kategoryzacja w UI);
 *     silnik traktuje 'other' z subkind i bez tak samo (cash tak, MWR nie),
 *     więc wartość portfela i MWR/TWR nie drgną
 *
 * Usage (lokalnie):
 *   npm run fix:xtb-interest-subkind -w server              # dry-run
 *   npm run fix:xtb-interest-subkind -w server -- --apply   # commit
 *   npm run fix:xtb-interest-subkind -w server -- --only=ID # 1 portfel
 *
 * Production (prod ma tylko skompilowany dist — `node`, NIE tsx; DATA_DIR jest
 * OBOWIĄZKOWY: bez niego config.ts rozwiąże ścieżkę do /opt/ike-terminal/app/data,
 * gdzie leży wyłącznie zastane price_history.db → skrypt cicho nic nie zrobi):
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/app && DATA_DIR=/opt/ike-terminal/data node server/dist/scripts/fix-xtb-interest-subkind.js'
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/app && DATA_DIR=/opt/ike-terminal/data node server/dist/scripts/fix-xtb-interest-subkind.js --apply'
 *   # Po --apply zrestartuj serwer (systemctl restart ike-terminal) — memo historii
 *   # portfela (history-memo) jest in-memory i nie zobaczy zmiany z zewnętrznego procesu.
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db']);

/**
 * Opis pochodzi z kolumny Comment wyciągu ("Free-funds Interest 2026-06") albo —
 * gdy Comment pusty — z nazwy typu ("Free funds interest"). XTB używa obu pisowni
 * (z dywizem i ze spacją). Negatywny lookahead trzyma podatek poza zakresem.
 */
const INTEREST_RE = /^free[- ]funds interest(?!\s+tax)/i;

interface OperationRow {
  id: number;
  date: string;
  description: string;
  amount: number;
  currency: string;
  source: string;
}

interface Candidate {
  portfolioId: string;
  row: OperationRow;
}

function listPortfolios(): string[] {
  const entries = readdirSync(config.dataDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function findCandidates(portfolioId: string, skipped: Candidate[]): Candidate[] {
  const db = getDb(portfolioId);
  // source: 'xtb' = parser wbudowany, 'generic' = ten sam plik przez import
  // uniwersalny (profil XTB emitował 'other' dla parytetu z wbudowanym).
  const rows = db
    .prepare(
      'SELECT id, date, description, amount, currency, source FROM cash_operations ' +
        "WHERE operation_type = 'other' AND subkind IS NULL " +
        "AND source IN ('xtb', 'generic') AND description LIKE 'Free%funds%nterest%'",
    )
    .all() as OperationRow[];

  const out: Candidate[] = [];
  for (const row of rows) {
    if (!INTEREST_RE.test(row.description)) {
      skipped.push({ portfolioId, row });
      continue;
    }
    out.push({ portfolioId, row });
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

  const all: Candidate[] = [];
  const skipped: Candidate[] = [];
  for (const pid of portfolios) {
    try {
      all.push(...findCandidates(pid, skipped));
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`Pominięto ${skipped.length} wpis(ów) (opis łapie się w LIKE, ale nie w regexie):`);
    for (const s of skipped) {
      console.log(`  [${pad(s.portfolioId, 20)}] ${s.row.date} — "${s.row.description}"`);
    }
    console.log('');
  }

  if (all.length === 0) {
    console.log('Brak wpisów do korekty — odsetki XTB mają już subkind (albo ich nie ma).');
    process.exit(0);
  }

  console.log(`Znaleziono ${all.length} wpis(ów) do oznaczenia jako subkind='interest':`);
  console.log('─'.repeat(110));
  console.log(pad('PORTFEL', 20), pad('DATA', 12), pad('KWOTA', 14), pad('ŹRÓDŁO', 8), 'OPIS');
  console.log('─'.repeat(110));
  for (const c of all) {
    console.log(
      pad(c.portfolioId, 20),
      pad(c.row.date.slice(0, 10), 12),
      pad(`${c.row.amount} ${c.row.currency}`, 14),
      pad(c.row.source, 8),
      c.row.description,
    );
  }
  console.log('─'.repeat(110));

  if (!apply) {
    console.log(`\nDRY-RUN — żaden wpis nie został zmodyfikowany.`);
    console.log(`Aby wprowadzić zmiany uruchom ponownie z flagą --apply.`);
    process.exit(0);
  }

  let updated = 0;
  for (const c of all) {
    try {
      getDb(c.portfolioId)
        .prepare("UPDATE cash_operations SET subkind = 'interest' WHERE id = ?")
        .run(c.row.id);
      updated++;
    } catch (err: any) {
      console.error(`  BŁĄD [${c.portfolioId}] id=${c.row.id}: ${err.message}`);
    }
  }

  console.log(`\n✅ Zaktualizowano ${updated}/${all.length} wpis(ów).`);
  console.log('Zrestartuj serwer, żeby panel "Korekty i koszty" pokazał nową kategorię.');
}

main();
