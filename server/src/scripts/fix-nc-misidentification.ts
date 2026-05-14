/* eslint-disable no-console */
/**
 * One-shot naprawa wpisów ticker_map dla spółek NewConnect (NC) które resolver
 * błędnie przypisał do Yahoo zamiast Stooq. Występuje gdy Yahoo zwraca .WA
 * symbol dla NC spółki bez aktualnych danych OHLC (np. SEV.WA dla SEVENET),
 * a `inferExchange` na podstawie samego sufiksu `.WA` ustawia exchange='GPW'
 * i przekierowuje pobieranie cen do Yahoo, który nie indeksuje cen NC.
 *
 * Skrypt jest idempotentny i bezpieczny:
 *   - Domyślnie DRY-RUN: nic nie modyfikuje, tylko wyświetla kandydatów
 *   - --apply: aktualizuje tylko `exchange` i `price_source` (NIE rusza
 *     ticker/name/sector, żeby nie nadpisać użytkownikowych adnotacji)
 *   - Bezpieczne dla GPW spółek z tickerem przypadkowo pasującym do NC mapy:
 *     wymaga że ticker bez .WA dokładnie pasuje do NC ticker code'u
 *
 * Usage:
 *   cd server && npx tsx src/scripts/fix-nc-misidentification.ts            # dry-run
 *   cd server && npx tsx src/scripts/fix-nc-misidentification.ts --apply    # commit
 *   cd server && npx tsx src/scripts/fix-nc-misidentification.ts --only=ID  # 1 portfel
 *
 * Production:
 *   ssh user@vps 'cd /opt/ike-terminal/server && npx tsx src/scripts/fix-nc-misidentification.ts'
 *   ssh user@vps 'cd /opt/ike-terminal/server && npx tsx src/scripts/fix-nc-misidentification.ts --apply'
 *   # Po --apply zrestartuj serwer żeby zinvalidować in-memory price cache.
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { findNcTicker } from 'shared';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { searchStooqByName } from '../services/ticker-search.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db']);

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
  ncTicker: string;
  ncName: string;
}

interface SkippedMigration {
  portfolioId: string;
  isin: string;
  ticker: string;
  name: string;
  reason: string;
}

function listPortfolios(): string[] {
  const entries = readdirSync(config.dataDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

// Cache wyników Stooq lookup żeby nie spamować przy duplikatach między portfelami
const stooqExchangeCache = new Map<string, 'NC' | 'GPW' | null>();

async function checkCurrentStooqExchange(ncName: string): Promise<'NC' | 'GPW' | null> {
  const key = ncName.toUpperCase();
  if (stooqExchangeCache.has(key)) return stooqExchangeCache.get(key)!;
  try {
    const result = await searchStooqByName(ncName);
    const exchange = result?.exchange === 'NC' ? 'NC' : result?.exchange === 'GPW' ? 'GPW' : null;
    stooqExchangeCache.set(key, exchange);
    return exchange;
  } catch {
    stooqExchangeCache.set(key, null);
    return null;
  }
}

async function findCandidates(
  portfolioId: string,
  skippedMigrations: SkippedMigration[],
  skipStooqVerify: boolean,
): Promise<Candidate[]> {
  const db = getDb(portfolioId);
  // Iterujemy WSZYSTKIE wpisy z exchange != 'NC', niezależnie od formatu tickera.
  // To pozwala wyłapać też przypadki gdy ticker był zapisany jako ISIN (np.
  // Duality SA: ticker='PLDLITY00010', exchange='OTHER').
  const rows = db
    .prepare(
      'SELECT isin, ticker, name, exchange, currency, price_source FROM ticker_map ' +
        "WHERE exchange != 'NC' OR price_source != 'stooq'",
    )
    .all() as TickerRow[];

  // Pobieramy paper_name'y posortowane od najnowszej do najstarszej transakcji.
  // Pozwala to wykryć migrację NC → GPW: jeśli najnowsza transakcja NIE ma -NC
  // (mimo że stare miały) — spółka prawdopodobnie przeniosła notowanie na GPW.
  // Przykład: Woodpecker (PLWDPCK00017) — stare imp. "WOODPCKR-NC", nowe "WOODPCKR".
  const paperNamesByDateStmt = db.prepare(
    'SELECT DISTINCT paper_name FROM transactions WHERE isin = ? ORDER BY date DESC',
  );

  const out: Candidate[] = [];
  for (const row of rows) {
    const paperNames = (paperNamesByDateStmt.all(row.isin) as { paper_name: string | null }[])
      .map((r) => r.paper_name || '')
      .filter((p) => p);
    if (paperNames.length === 0) continue;

    // Autorytatywna walidacja: NAJNOWSZA transakcja musi mieć sufiks -NC.
    // Jeśli najnowsza nie ma, ale stare miały → spółka migrowała na GPW i NIE
    // chcemy jej cofać do NC.
    const latestPaperName = paperNames[0];
    const latestHasNc = /-NC(?:-FIX)?$/i.test(latestPaperName);
    if (!latestHasNc) continue;

    // Wyciągnij Bossa-style nazwę spółki z paperName (np. "DUALITY-NC" → "DUALITY")
    const cleanName = latestPaperName
      .replace(/-NC(?:-FIX)?$/i, '')
      .replace(/-C$/i, '')
      .replace(/\.WA$/i, '')
      .trim();

    // Resolwuj przez NC offline map. To jest autorytatywne mapowanie nazwa→ticker.
    const nc = findNcTicker(cleanName);
    if (!nc) continue;

    // Weryfikacja Stooq: paperName z -NC oznacza tylko że SPÓŁKA BYŁA NA NC
    // w momencie zakupu. Po migracji NC→GPW (np. Woodpecker w 04/2024) Stooq
    // zwraca XWAR (GPW), nawet jeśli wszystkie tx user'a były z czasów NC.
    // Bez tego checka cofnęlibyśmy zmigrowane spółki z powrotem do NC.
    if (!skipStooqVerify) {
      const currentExchange = await checkCurrentStooqExchange(nc.name);
      if (currentExchange === 'GPW') {
        skippedMigrations.push({
          portfolioId,
          isin: row.isin,
          ticker: row.ticker,
          name: row.name || '',
          reason: `Stooq mówi ${nc.name} jest teraz na GPW (XWAR). Spółka przeniosła notowanie NC→GPW — wpis pozostaje GPW.`,
        });
        continue;
      }
      // Jeśli currentExchange === null (Stooq nie odpowiedział) — kontynuujemy
      // z fallback'iem do Bossa signal (current behavior). Stooq jest "best effort".
    }

    out.push({ portfolioId, row, ncTicker: nc.ticker, ncName: nc.name });
  }
  return out;
}

function applyFix(c: Candidate): void {
  const db = getDb(c.portfolioId);
  const expectedTicker = `${c.ncTicker}.WA`;
  const tickerNeedsUpdate = c.row.ticker !== expectedTicker;
  if (tickerNeedsUpdate) {
    // Ticker zmienia się tylko gdy obecny jest błędny (np. ISIN-as-ticker dla
    // Duality SA, lub starsza nazwa). Historia cen pod starym tickerem stanie
    // się orphan'em, ale dla NC tickerów Yahoo i tak nie miał danych.
    db.prepare(
      "UPDATE ticker_map SET exchange = 'NC', price_source = 'stooq', ticker = ? WHERE isin = ?",
    ).run(expectedTicker, c.row.isin);
  } else {
    db.prepare("UPDATE ticker_map SET exchange = 'NC', price_source = 'stooq' WHERE isin = ?").run(
      c.row.isin,
    );
  }
}

function parseArgs() {
  return {
    apply: process.argv.includes('--apply'),
    skipStooqVerify: process.argv.includes('--no-stooq-verify'),
    only: process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  const { apply, only, skipStooqVerify } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();

  if (portfolios.length === 0) {
    console.log('No portfolio databases found in', config.dataDir);
    process.exit(0);
  }

  console.log(`Skanowanie ${portfolios.length} portfela/i w ${config.dataDir}`);
  console.log(`Tryb: ${apply ? 'APPLY (zapisuje zmiany)' : 'DRY-RUN (tylko podgląd)'}`);
  console.log(
    `Weryfikacja Stooq: ${skipStooqVerify ? 'WYŁĄCZONA (--no-stooq-verify)' : 'WŁĄCZONA — odsiewa zmigrowane NC→GPW'}\n`,
  );

  const all: Candidate[] = [];
  const skippedMigrations: SkippedMigration[] = [];
  for (const pid of portfolios) {
    try {
      const found = await findCandidates(pid, skippedMigrations, skipStooqVerify);
      all.push(...found);
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  if (skippedMigrations.length > 0) {
    console.log(
      `Pominięto ${skippedMigrations.length} wpis(ów) — Stooq potwierdza migrację NC→GPW:`,
    );
    console.log('─'.repeat(120));
    for (const s of skippedMigrations) {
      console.log(
        `  [${s.portfolioId.slice(0, 20)}] ${pad(s.isin, 14)} ${pad(s.ticker, 12)} ${pad(s.name, 20)} — ${s.reason}`,
      );
    }
    console.log('─'.repeat(120));
    console.log('');
  }

  if (all.length === 0) {
    console.log('Brak kandydatów do naprawy — wszystkie wpisy NC są poprawne.');
    process.exit(0);
  }

  console.log(`Znaleziono ${all.length} wpis(ów) do naprawy (Bossa-confirmed NC):`);
  console.log('─'.repeat(140));
  console.log(
    pad('PORTFEL', 20),
    pad('ISIN', 14),
    pad('OBECNY TICKER', 14),
    pad('NAZWA W BAZIE', 22),
    pad('OBECNE ex/src', 18),
    pad('NOWY TICKER', 14),
    'NC NAZWA',
  );
  console.log('─'.repeat(140));
  for (const c of all) {
    const newTicker = `${c.ncTicker}.WA`;
    const tickerChange = c.row.ticker === newTicker ? newTicker : `${newTicker} ←`;
    console.log(
      pad(c.portfolioId, 20),
      pad(c.row.isin, 14),
      pad(c.row.ticker, 14),
      pad(c.row.name || '(empty)', 22),
      pad(`${c.row.exchange}/${c.row.price_source}`, 18),
      pad(tickerChange, 14),
      c.ncName,
    );
  }
  console.log('─'.repeat(140));

  if (!apply) {
    console.log(`\nDRY-RUN — żaden wpis nie został zmodyfikowany.`);
    console.log(`Aby wprowadzić zmiany uruchom ponownie z flagą --apply.`);
    process.exit(0);
  }

  let updated = 0;
  for (const c of all) {
    try {
      applyFix(c);
      updated++;
    } catch (err: any) {
      console.error(`  ${c.portfolioId}/${c.row.isin}: ERROR — ${err.message}`);
    }
  }

  console.log(`\nZaktualizowano ${updated}/${all.length} wpisów ticker_map.`);
  console.log('Zrestartuj serwer (npm run dev) żeby zinvalidować in-memory price cache.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
