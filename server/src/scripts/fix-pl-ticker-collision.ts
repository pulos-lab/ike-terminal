/* eslint-disable no-console */
/**
 * One-shot naprawa wpisów ticker_map, w których polski pseudo-ISIN z sufiksem
 * `.WA` (XTB/mBank) został błędnie rozwiązany na ZAGRANICZNY papier o tym samym
 * oznaczeniu tickera. Dzieje się to gdy w chwili importu Stooq był rate-limitowany:
 * resolver spadał do Yahoo, a to samo 3-literowe oznaczenie bywa innym instrumentem
 * na obcej giełdzie (np. EXC.WA/Excellence-NC → Exelon Corp NASDAQ, CCC.WA/Modivo →
 * CCC Intelligent Solutions, MNS.WA/Mennica Skarbowa → Monster Beverage).
 *
 * Skrypt jest idempotentny i bezpieczny:
 *   - Działa TYLKO na wpisach isin LIKE '%.WA' o zagranicznej giełdzie lub walucie ≠ PLN
 *   - Wymaga, by transakcje pod tym ISIN-em były w PLN (gwarancja: to warszawski papier,
 *     a nie realne zagraniczne pozycje użytkownika)
 *   - Ponownie rozwiązuje przez resolveIsin (naprawiony resolver + żywy Stooq); zapisuje
 *     tylko gdy nowy wynik to NC/GPW/CATALYST w PLN. Zagraniczny/pusty wynik → SKIP
 *   - Domyślnie DRY-RUN; --apply zapisuje zmiany
 *
 * WAŻNE: uruchamiać PO wdrożeniu poprawki resolvera (fix/polish-pseudo-isin-foreign-
 * collision), inaczej stary resolver ponownie złapie tę samą zagraniczną kolizję.
 *
 * Usage:
 *   cd server && npx tsx src/scripts/fix-pl-ticker-collision.ts            # dry-run
 *   cd server && npx tsx src/scripts/fix-pl-ticker-collision.ts --apply    # commit
 *   cd server && npx tsx src/scripts/fix-pl-ticker-collision.ts --only=ID  # 1 portfel
 *
 * Production (po deployu):
 *   ssh user@vps 'cd /opt/ike-terminal/server && npx tsx src/scripts/fix-pl-ticker-collision.ts'
 *   ssh user@vps 'cd /opt/ike-terminal/server && npx tsx src/scripts/fix-pl-ticker-collision.ts --apply'
 *   # Po --apply zrestartuj serwer, żeby zinvalidować in-memory price cache.
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import type { TickerMapEntry } from 'shared';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import { resolveIsin } from '../services/isin-resolver.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db']);
const PL_EXCHANGES = new Set(['NC', 'GPW', 'CATALYST']);

interface TickerRow {
  isin: string;
  ticker: string;
  name: string;
  exchange: string;
  currency: string;
  price_source: string;
}

interface Candidate {
  portfolioId: string;
  row: TickerRow;
  paperName: string;
}

interface Outcome {
  portfolioId: string;
  isin: string;
  oldDesc: string;
  newDesc: string;
  status: 'fixed' | 'skipped';
  reason?: string;
}

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

/** Kandydaci: polski pseudo-ISIN (.WA) rozwiązany na zagraniczny listing/walutę. */
function findCandidates(portfolioId: string): Candidate[] {
  const db = getDb(portfolioId);
  const rows = db
    .prepare(
      'SELECT isin, ticker, name, exchange, currency, price_source FROM ticker_map ' +
        "WHERE isin LIKE '%.WA' AND (exchange NOT IN ('NC','GPW','CATALYST') OR currency != 'PLN')",
    )
    .all() as TickerRow[];

  const latestPaperStmt = db.prepare(
    'SELECT paper_name FROM transactions WHERE isin = ? ORDER BY date DESC LIMIT 1',
  );
  // Bezpiecznik: liczba transakcji NIE-PLN pod tym ISIN-em. Jeśli userzy mają realne
  // zagraniczne pozycje (mało prawdopodobne dla ISIN-u .WA, ale chronimy się), pomiń.
  const nonPlnCountStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE isin = ? AND currency != 'PLN' " +
      "AND category NOT IN ('fx_exchange')",
  );

  const out: Candidate[] = [];
  for (const row of rows) {
    const paperRow = latestPaperStmt.get(row.isin) as { paper_name: string | null } | undefined;
    const paperName = paperRow?.paper_name || row.isin;
    const nonPln = (nonPlnCountStmt.get(row.isin) as { n: number }).n;
    // Dopuszczamy pojedyncze ręczne wpisy w obcej walucie (artefakt złej identyfikacji),
    // ale jeśli WSZYSTKIE albo większość transakcji jest nie-PLN — to prawdziwy papier obcy.
    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE isin = ?').get(row.isin) as {
        n: number;
      }
    ).n;
    if (total > 0 && nonPln > total / 2) continue; // większość nie-PLN → realnie zagraniczny
    out.push({ portfolioId, row, paperName });
  }
  return out;
}

async function reResolve(c: Candidate, apply: boolean): Promise<Outcome> {
  const oldDesc = `${c.row.ticker} ${c.row.exchange}/${c.row.currency} (${c.row.name || '?'})`;
  let entry: TickerMapEntry | null = null;
  try {
    entry = await resolveIsin(c.row.isin, c.paperName, 'PLN');
  } catch (err: any) {
    return {
      portfolioId: c.portfolioId,
      isin: c.row.isin,
      oldDesc,
      newDesc: '—',
      status: 'skipped',
      reason: `resolveIsin error: ${err.message}`,
    };
  }

  if (!entry) {
    return {
      portfolioId: c.portfolioId,
      isin: c.row.isin,
      oldDesc,
      newDesc: '—',
      status: 'skipped',
      reason: 'resolver zwrócił null (Stooq niedostępny?) — spróbuj ponownie',
    };
  }

  const newDesc = `${entry.ticker} ${entry.exchange}/${entry.currency} (${entry.name})`;
  const isPlNow = PL_EXCHANGES.has(entry.exchange) && entry.currency === 'PLN';
  if (!isPlNow) {
    return {
      portfolioId: c.portfolioId,
      isin: c.row.isin,
      oldDesc,
      newDesc,
      status: 'skipped',
      reason: 'ponowne rozwiązanie nadal nie-PLN — możliwe, że to realnie zagraniczny papier',
    };
  }

  if (apply) upsertTickerMapEntry(entry, c.portfolioId);
  return { portfolioId: c.portfolioId, isin: c.row.isin, oldDesc, newDesc, status: 'fixed' };
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

async function main() {
  const { apply, only } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();

  if (portfolios.length === 0) {
    console.log('No portfolio databases found in', config.dataDir);
    process.exit(0);
  }

  console.log(`Skanowanie ${portfolios.length} portfela/i w ${config.dataDir}`);
  console.log(`Tryb: ${apply ? 'APPLY (zapisuje zmiany)' : 'DRY-RUN (tylko podgląd)'}\n`);

  const candidates: Candidate[] = [];
  for (const pid of portfolios) {
    try {
      candidates.push(...findCandidates(pid));
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  if (candidates.length === 0) {
    console.log('Brak kandydatów — wszystkie wpisy .WA są poprawne (PLN, GPW/NC/CATALYST).');
    process.exit(0);
  }

  console.log(`Znaleziono ${candidates.length} kandydat(ów). Ponowne rozwiązywanie...\n`);

  // Sekwencyjnie — resolveIsin i tak ma wewnętrzny limiter Stooqa; unikamy zalania sieci.
  const outcomes: Outcome[] = [];
  for (const c of candidates) {
    outcomes.push(await reResolve(c, apply));
  }

  const fixed = outcomes.filter((o) => o.status === 'fixed');
  const skipped = outcomes.filter((o) => o.status === 'skipped');

  console.log('─'.repeat(150));
  console.log(pad('PORTFEL', 20), pad('ISIN', 12), pad('STARE', 48), '→  NOWE');
  console.log('─'.repeat(150));
  for (const o of outcomes) {
    const mark = o.status === 'fixed' ? '✓' : '✗';
    console.log(
      mark,
      pad(o.portfolioId.slice(0, 18), 18),
      pad(o.isin, 12),
      pad(o.oldDesc, 48),
      `→  ${o.newDesc}${o.reason ? `   [${o.reason}]` : ''}`,
    );
  }
  console.log('─'.repeat(150));
  console.log(`\nNaprawialne: ${fixed.length}, pominięte: ${skipped.length}`);

  if (!apply) {
    console.log(`\nDRY-RUN — nic nie zapisano. Uruchom ponownie z --apply, aby wprowadzić zmiany.`);
    process.exit(0);
  }

  console.log(`\nZaktualizowano ${fixed.length} wpisów ticker_map.`);
  console.log('Zrestartuj serwer, żeby zinvalidować in-memory price cache.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
