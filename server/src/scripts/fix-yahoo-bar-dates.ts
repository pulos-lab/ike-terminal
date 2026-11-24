/* eslint-disable no-console */
/**
 * Naprawa dat w `price_history` dla serii Yahoo zapisanych z przesunięciem
 * o dzień wstecz.
 *
 * Skąd się wzięły: do tej poprawki słupek dzienny był datowany datą UTC stempla,
 * a Yahoo stempluje go początkiem sesji w czasie giełdy. Dla par walutowych latem
 * (północ w Londynie = 23:00 UTC dnia poprzedniego), ASX w czasie AEDT i NZX cały
 * rok sesja z dnia D lądowała pod datą D-1 — poniedziałek pod niedzielą, piątek
 * pod czwartkiem (szczegóły i pomiary: `services/yahoo-bar-date.ts`). Nowy kod
 * datuje poprawnie, ale wierszy już zapisanych nie ruszy: cache uznaje je za
 * komplet i nie pobiera drugi raz.
 *
 * Co robi: dla każdej podejrzanej serii pobiera ją z Yahoo OD NOWA (już z datami
 * sesji) i dopiero mając komplet podmienia wiersze `source='yahoo'` w jednej
 * transakcji. Brak odpowiedzi albo odpowiedź wyraźnie krótsza od zastanej serii
 * = seria zostaje nietknięta. Wiersze z innych źródeł nie są usuwane.
 *
 * Podejrzana seria = taka, która ma wiersze NIEDZIELNE (skutek przesunięcia
 * poniedziałku), a sobotnich prawie wcale. Rynek 7-dniowy (krypto) ma jednych
 * i drugich po równo i jest pomijany. Seria poprawna, która mimo to wpadnie do
 * listy (giełda z sesją niedzielną), po ponownym pobraniu wychodzi identyczna —
 * skrypt jest idempotentny i dla takiej serii raportuje zero zmian.
 *
 * KOLEJNOŚĆ: dopiero PO wdrożeniu poprawki datowania (skrypt sam jej używa),
 * a po zapisie restart serwera — historia siedzi też w cache'u w pamięci (12 h)
 * i w memo wykresu.
 *
 * Skrypt MUSI leżeć w `src/scripts/` (nie `scripts/`) — tylko stamtąd trafia do
 * `dist` i da się go uruchomić na produkcji.
 *
 * Run (dry-run, tylko raport):  npm run fix:yahoo-bar-dates -w server
 * Run (zapis):                  npm run fix:yahoo-bar-dates -w server -- --apply
 * Wybrane serie:                … -- --ticker=USDPLN=X,GRX.AX
 * Prod (dry-run):  cd /opt/ike-terminal/app/server && sudo -u ike-terminal DATA_DIR=/opt/ike-terminal/data node dist/scripts/fix-yahoo-bar-dates.js
 * Prod (zapis):    ta sama komenda z --apply, potem restart usługi
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { config } from '../config.js';
import { fetchYahooDailyClosesDirect } from '../services/yahoo-finance.js';

const POLITENESS_MS = 300;
/** Świeża seria musi pokryć co najmniej tyle zastanych wierszy, żeby ją przyjąć. */
const MIN_COVERAGE = 0.9;
/** Względna różnica zamknięcia, od której uznajemy wartość dnia za zmienioną. */
const VALUE_CHANGE_EPS = 1e-4;

export interface PriceRow {
  date: string;
  close: number;
}

export interface SeriesStats {
  ticker: string;
  sundays: number;
  saturdays: number;
  rows: number;
  first: string;
  last: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dzień tygodnia daty `YYYY-MM-DD` (0 = niedziela), bez udziału strefy procesu. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function countWeekend(rows: PriceRow[]): number {
  return rows.filter((r) => weekdayOf(r.date) === 0 || weekdayOf(r.date) === 6).length;
}

/**
 * Czy seria wygląda na przesuniętą o dzień. Niedziele bez sobót to podpis
 * poniedziałku zapisanego dzień za wcześnie; rynek 7-dniowy ma obu po równo.
 */
export function isShiftedSeriesCandidate(
  stats: Pick<SeriesStats, 'sundays' | 'saturdays'>,
): boolean {
  return stats.sundays > 0 && stats.saturdays * 2 < stats.sundays;
}

export type RepairPlan =
  | { kind: 'skip'; reason: string }
  | {
      kind: 'replace';
      /** Usuwamy zastane wiersze Yahoo z datą >= tej (pierwsza świeża sesja − 1 dzień). */
      deleteFrom: string;
      deleted: number;
      inserted: number;
      /** Zastane wiersze sprzed zasięgu świeżej serii — zostają, jak były. */
      keptOlder: number;
      weekendBefore: number;
      weekendAfter: number;
      /** Zastane daty, których w świeżej serii nie ma (znikające niedziele itd.). */
      datesRemoved: number;
      /** Świeże daty, których nie było (dochodzące piątki + nowszy ogon). */
      datesAdded: number;
      /** Dni obecne przed i po, których zamknięcie się zmienia. */
      valuesChanged: number;
      maxRelChange: number;
      examples: Array<{ date: string; before: number; after: number }>;
    };

/**
 * Plan podmiany jednej serii: czysta funkcja z zastanych wierszy Yahoo i świeżo
 * pobranej serii (posortowanych rosnąco po dacie).
 */
export function planBarDateRepair(existing: PriceRow[], fresh: PriceRow[]): RepairPlan {
  if (existing.length === 0) return { kind: 'skip', reason: 'brak zastanych wierszy Yahoo' };
  if (fresh.length === 0) return { kind: 'skip', reason: 'Yahoo oddało pustą serię' };

  // Przesunięty odpowiednik pierwszej świeżej sesji leży dzień wcześniej.
  const deleteFrom = shiftDays(fresh[0].date, -1);
  const toDelete = existing.filter((r) => r.date >= deleteFrom);
  const keptOlder = existing.length - toDelete.length;

  // Kompletność liczymy na wspólnym zakresie: świeża seria sięga dziś, zastana
  // mogła się urwać dawno temu — nowszy ogon nie może maskować dziur w środku.
  const lastExisting = existing[existing.length - 1].date;
  const freshInSpan = fresh.filter((r) => r.date <= shiftDays(lastExisting, 1)).length;
  if (freshInSpan < toDelete.length * MIN_COVERAGE) {
    return {
      kind: 'skip',
      reason: `Yahoo oddało ${freshInSpan} sesji na zakres, w którym mamy ${toDelete.length} — seria wygląda na uciętą`,
    };
  }

  const before = new Map(toDelete.map((r) => [r.date, r.close]));
  const after = new Map(fresh.map((r) => [r.date, r.close]));

  let valuesChanged = 0;
  let maxRelChange = 0;
  const examples: Array<{ date: string; before: number; after: number }> = [];
  for (const [date, oldClose] of before) {
    const newClose = after.get(date);
    if (newClose === undefined || oldClose === 0) continue;
    const rel = Math.abs(newClose - oldClose) / Math.abs(oldClose);
    if (rel <= VALUE_CHANGE_EPS) continue;
    valuesChanged += 1;
    maxRelChange = Math.max(maxRelChange, rel);
    if (examples.length < 3) examples.push({ date, before: oldClose, after: newClose });
  }

  return {
    kind: 'replace',
    deleteFrom,
    deleted: toDelete.length,
    inserted: fresh.length,
    keptOlder,
    weekendBefore: countWeekend(toDelete),
    weekendAfter: countWeekend(fresh),
    datesRemoved: [...before.keys()].filter((d) => !after.has(d)).length,
    datesAdded: [...after.keys()].filter((d) => !before.has(d)).length,
    valuesChanged,
    maxRelChange,
    examples,
  };
}

function parseArgs(argv: string[]): { apply: boolean; tickers: string[] | null } {
  const tickerArg = argv.find((a) => a.startsWith('--ticker='));
  const tickers = tickerArg
    ? tickerArg
        .slice('--ticker='.length)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : null;
  return { apply: argv.includes('--apply'), tickers };
}

async function main(): Promise<void> {
  const { apply, tickers } = parseArgs(process.argv.slice(2));
  const dbPath = path.join(config.dataDir, 'price_history.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Brak ${dbPath} — ustaw DATA_DIR na katalog danych`);
  }

  const db = new Database(dbPath);
  const stats = db
    .prepare(
      `SELECT ticker,
              SUM(strftime('%w', date) = '0') AS sundays,
              SUM(strftime('%w', date) = '6') AS saturdays,
              COUNT(*) AS rows, MIN(date) AS first, MAX(date) AS last
       FROM price_history WHERE source = 'yahoo' GROUP BY ticker ORDER BY ticker`,
    )
    .all() as SeriesStats[];

  const candidates = tickers
    ? stats.filter((s) => tickers.includes(s.ticker))
    : stats.filter(isShiftedSeriesCandidate);

  console.log(
    `${apply ? 'ZAPIS' : 'DRY-RUN (bez zapisu)'} — ${dbPath}\n` +
      `Serii Yahoo: ${stats.length}, do sprawdzenia: ${candidates.length}` +
      (tickers ? ` (wskazane: ${tickers.join(', ')})` : ' (z wierszami niedzielnymi)') +
      '\n',
  );

  const loadYahooRows = db.prepare(
    `SELECT date, close FROM price_history WHERE ticker = ? AND source = 'yahoo' ORDER BY date`,
  );
  const deleteRows = db.prepare(
    `DELETE FROM price_history WHERE ticker = ? AND source = 'yahoo' AND date >= ?`,
  );
  const insertRow = db.prepare(
    `INSERT OR REPLACE INTO price_history (ticker, date, close, source) VALUES (?, ?, ?, 'yahoo')`,
  );
  const replaceSeries = db.transaction((ticker: string, deleteFrom: string, rows: PriceRow[]) => {
    deleteRows.run(ticker, deleteFrom);
    for (const r of rows) insertRow.run(ticker, r.date, r.close);
  });

  const todayUtc = new Date().toISOString().split('T')[0];
  const fetchEnd = shiftDays(todayUtc, 1);
  let repaired = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const s of candidates) {
    const existing = loadYahooRows.all(s.ticker) as PriceRow[];
    let fresh: PriceRow[] | null;
    try {
      fresh = await fetchYahooDailyClosesDirect(s.ticker, s.first, fetchEnd, todayUtc);
    } catch (err) {
      console.log(`  ${s.ticker.padEnd(12)} POMIJAM — błąd Yahoo: ${(err as Error).message}`);
      skipped += 1;
      await sleep(POLITENESS_MS);
      continue;
    }
    await sleep(POLITENESS_MS);

    const plan = planBarDateRepair(existing, fresh ?? []);
    if (plan.kind === 'skip') {
      console.log(`  ${s.ticker.padEnd(12)} POMIJAM — ${plan.reason}`);
      skipped += 1;
      continue;
    }

    if (plan.datesRemoved === 0 && plan.valuesChanged === 0) {
      console.log(`  ${s.ticker.padEnd(12)} bez zmian (daty zgodne z sesjami)`);
      unchanged += 1;
      continue;
    }

    console.log(
      `  ${s.ticker.padEnd(12)} ${plan.deleted} → ${plan.inserted} wierszy; ` +
        `weekendowych ${plan.weekendBefore} → ${plan.weekendAfter}; ` +
        `daty znikające ${plan.datesRemoved}, dochodzące ${plan.datesAdded}; ` +
        `zmiana kursu w ${plan.valuesChanged} dniach (max ${(plan.maxRelChange * 100).toFixed(2)}%)` +
        (plan.keptOlder > 0 ? `; starszych nietkniętych ${plan.keptOlder}` : ''),
    );
    for (const e of plan.examples) {
      console.log(`      ${e.date}: ${e.before} → ${e.after}`);
    }
    if (apply) replaceSeries(s.ticker, plan.deleteFrom, fresh ?? []);
    repaired += 1;
  }

  db.close();

  console.log(
    `\n${apply ? 'Podmieniono' : 'Do podmiany'}: ${repaired}; bez zmian: ${unchanged}; pominięto: ${skipped}.`,
  );
  if (!apply && repaired > 0) console.log('Uruchom ponownie z --apply, żeby zapisać.');
  if (apply && repaired > 0) {
    console.log('Zrestartuj serwer — historia siedzi też w cache w pamięci i w memo wykresu.');
  }
}

// Uruchamiamy TYLKO przy bezpośrednim wywołaniu — testy importują z tego pliku
// czyste helpery i nie mogą przy okazji odpalić naprawy na realnej bazie.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Naprawa dat nie powiodła się:', err);
    process.exit(1);
  });
}
