/* eslint-disable no-console */
/**
 * Backfill `ticker_map.exchange` dla wpisów, które utknęły na 'OTHER'.
 *
 * Skąd się biorą: ręczne dodanie tickera (POST /transactions) zapisywało wpis
 * z pseudo-ISIN-em `AUTO_<TICKER>` i zahardkodowanym `exchange='OTHER'`, bo Yahoo
 * chart API nie zwraca giełdy. Samoleczenie takiego wpisu nie działa: naprawia je
 * wyłącznie `resolveUnknownIsins`, a ten bierze pod uwagę jedynie wpisy wyglądające
 * na prowizoryczny stub (`ticker === name`) — po tym, jak `backfillTickerNames`
 * dopisze prawdziwą nazwę, wpis przestaje spełniać ten warunek i zostaje zakotwiczony
 * z 'OTHER' na zawsze.
 *
 * Skutki 'OTHER' (stan na 2026-08): pozycja wypada z wykresu „Regiony" do wiadra
 * „Inne" (gdy brak też kraju) i — przed #233 — nie dostawała ikony kalendarza wyników.
 *
 * Skrypt zmienia WYŁĄCZNIE kolumnę `exchange`. Nie rusza tickera, nazwy ani ISIN-u,
 * bo to one kotwiczą historię cen (patrz `upsertTickerMapEntry`).
 *
 * Run (dry-run, tylko raport):  npm run backfill:exchange -w server
 * Run (zapis):                  npm run backfill:exchange -w server -- --apply
 * Prod:                         DATA_DIR=/opt/ike-terminal/data node dist/scripts/backfill-ticker-exchange.js --apply
 */

import { CFD_TICKER_MAP } from 'shared';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { config } from '../src/config.js';
import { inferExchange } from '../src/services/isin-resolver.js';
import { fetchYahooSymbolInfo } from '../src/services/ticker-search.js';

const APPLY = process.argv.includes('--apply');
const POLITENESS_MS = 250;

interface Row {
  isin: string;
  ticker: string;
  name: string | null;
  currency: string | null;
  country: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Instrument syntetyczny (CFD/surowiec/indeks/para FX) — NIE ma giełdy akcji.
 * Jego ticker koliduje z realnymi symbolami: wyszukiwarka Yahoo na „GOLD" zwraca
 * Barrick Gold z NYSE, a na „OIL" Marathon Oil. Ten sam guard co w
 * `ticker-name-backfill.ts`; wykryte na realnych danych podczas dry-runu.
 */
export function shouldSkipTicker(ticker: string): boolean {
  return !!CFD_TICKER_MAP[ticker.toUpperCase()];
}

/**
 * Giełda bez odpytywania sieci — z sufiksu tickera, kraju i waluty.
 * Świadomie NIE zgadujemy NYSE vs NASDAQ: bez kodu z Yahoo nie ma jak ich rozróżnić,
 * a wszystkie konsumenty i tak traktują je tak samo (rynek US). Zwracamy null,
 * gdy nie ma podstaw — lepiej zostawić 'OTHER' niż wpisać zmyśloną giełdę.
 */
export function offlineExchangeGuess(row: Row): string | null {
  const ticker = row.ticker.toUpperCase();
  const suffixGuess = inferExchange(ticker);
  if (suffixGuess !== 'OTHER') return suffixGuess;

  if (row.country === 'Poland') return 'GPW';
  // Instrumenty syntetyczne (pary FX `=X`, kontrakty `=F`, krypto `-USD`) nie są
  // notowane na żadnej giełdzie akcji — zostawiamy je w spokoju.
  if (/[=]/.test(ticker) || /-USD$/.test(ticker)) return null;
  if (ticker.includes('.')) return null; // sufiks nieznany naszej mapie
  return null;
}

async function processDb(file: string): Promise<{ changed: number; scanned: number }> {
  const db = new Database(file);
  let rows: Row[];
  try {
    rows = db
      .prepare(
        `SELECT isin, ticker, name, currency, country FROM ticker_map
         WHERE exchange = 'OTHER' AND isin NOT LIKE 'OPT:%'`,
      )
      .all() as Row[];
  } catch {
    db.close();
    return { changed: 0, scanned: 0 }; // baza bez ticker_map (auth/price_history)
  }

  const update = db.prepare('UPDATE ticker_map SET exchange = ? WHERE isin = ?');
  let changed = 0;

  for (const row of rows) {
    if (shouldSkipTicker(row.ticker)) {
      console.log(`  ${path.basename(file).slice(0, 8)}  ${row.ticker.padEnd(12)} POMIJAM (CFD)`);
      continue;
    }

    let target = offlineExchangeGuess(row);

    // Czysty symbol bez sufiksu — jedyne wiarygodne źródło giełdy to kod Yahoo.
    if (!target && !row.ticker.includes('.') && !/[=]/.test(row.ticker)) {
      const info = await fetchYahooSymbolInfo(row.ticker);
      await sleep(POLITENESS_MS);
      if (info?.exchange) {
        const guess = inferExchange(row.ticker.toUpperCase(), info.exchange);
        if (guess !== 'OTHER') target = guess;
      }
    }

    if (!target) continue;
    console.log(
      `  ${path.basename(file).slice(0, 8)}  ${row.ticker.padEnd(12)} OTHER → ${target}` +
        `   (${row.name ?? '?'}, ${row.currency ?? '?'}, ${row.country ?? 'brak kraju'})`,
    );
    if (APPLY) update.run(target, row.isin);
    changed += 1;
  }

  db.close();
  return { changed, scanned: rows.length };
}

async function main(): Promise<void> {
  const dir = config.dataDir;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .filter((f) => !['auth.db', 'price_history.db', 'import_profiles.db'].includes(f))
    .map((f) => path.join(dir, f));

  console.log(`${APPLY ? 'ZAPIS' : 'DRY-RUN (bez zapisu)'} — ${files.length} baz w ${dir}\n`);

  let totalChanged = 0;
  let totalScanned = 0;
  for (const file of files) {
    const { changed, scanned } = await processDb(file);
    totalChanged += changed;
    totalScanned += scanned;
  }

  console.log(
    `\nPrzejrzano ${totalScanned} wpisów z exchange='OTHER'; ` +
      `${APPLY ? 'zaktualizowano' : 'do aktualizacji'}: ${totalChanged}.`,
  );
  if (!APPLY && totalChanged > 0) console.log('Uruchom ponownie z --apply, żeby zapisać.');
}

// Uruchamiamy TYLKO przy bezpośrednim wywołaniu — testy importują z tego pliku
// czyste helpery i nie mogą przy okazji odpalić backfillu na realnych bazach.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Backfill nie powiódł się:', err);
    process.exit(1);
  });
}
