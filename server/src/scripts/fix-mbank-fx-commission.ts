/* eslint-disable no-console */
/**
 * One-shot naprawa transakcji mBank eMakler zaimportowanych PRZED PR #222.
 *
 * eMakler rozlicza się wyłącznie w PLN: kolumna „Kurs" to notowanie (USD/EUR),
 * a „Wartość" kwota obciążenia konta w złotych. Stary parser czytał tylko kurs,
 * więc:
 *   - prowizja podana przez brokera w PLN trafiała do `total` liczonego
 *     w walucie notowania (`value[USD] ± prowizja[PLN]`),
 *   - `fx_rate` zostawał pusty, przez co silnik przeliczał całość kursem
 *     rynkowym z Yahoo zamiast kursem brokera.
 *
 * Nowy parser bierze jedno i drugie z pliku, ale wiersze zaimportowane wcześniej
 * zostają błędne. Ten skrypt je poprawia BEZ udziału użytkownika — kurs
 * rozliczenia da się odtworzyć z samej prowizji, bo eMakler nalicza ją jako
 * procent kwoty W ZŁOTÓWKACH (0,29% rynki zagraniczne, 0,39% GPW; potwierdzone
 * co do grosza na 114 ze 164 zleceń zagranicznych realnego rachunku).
 *
 * Trzy przypadki, rozpoznawane po danych (kolejność ma znaczenie):
 *
 *   A. prowizja ≈ 0,29% wartości w PLN → kurs = (prowizja/0,0029)/wartość.
 *      Zweryfikowany na 4 wierszach produkcyjnych: odchyłka od kursu rynkowego
 *      −0,11%…+0,12%.
 *   B. prowizja ≈ wartość × kurs rynkowy → pole prowizji zawiera KWOTĘ
 *      ROZLICZENIA, nie prowizję. To ślad po jeszcze starszym błędzie (parser
 *      zgadywał indeks kolumny 7, a w raporcie „transakcje bieżące" pod tym
 *      indeksem jest „Wartość"). Kurs = prowizja/wartość, prowizja = 0.
 *   C. reszta — prowizja minimalna (14 zł zagranica, 5 zł GPW), z której nie da
 *      się odwrócić taryfy. Przeliczamy ją kursem rynkowym z dnia transakcji
 *      i TYM SAMYM kursem wypełniamy `fx_rate`. To jest behawioralnie neutralne:
 *      bez `fx_rate` silnik i tak sięga po kurs dzienny z tego samego źródła
 *      (portfolio-engine, gałąź `quotePln/payPln`). Zapisanie go wprost nic nie
 *      zmienia w wycenie, a czyni skrypt idempotentnym.
 *
 * Idempotentny: rusza wyłącznie wiersze `source='mbank'`, w których waluta
 * notowania różni się od waluty rozliczenia i `fx_rate IS NULL`. Każdy z trzech
 * przypadków wypełnia `fx_rate`, więc drugie uruchomienie nie widzi już nic —
 * bez sięgania po `synthetic_origin`, które ma w silniku własne znaczenie
 * (spin-offy, transfery) i nie wolno go używać jako znacznika migracji.
 *
 * Guard: jeśli odtworzony kurs odbiega od rynkowego o więcej niż 2%, wiersz jest
 * POMIJANY z ostrzeżeniem zamiast nadpisany.
 *
 * Usage:
 *   cd server && npx tsx src/scripts/fix-mbank-fx-commission.ts            # dry-run
 *   cd server && npx tsx src/scripts/fix-mbank-fx-commission.ts --apply    # zapis
 *
 * Production (po deployu #222):
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/APP/server && DATA_DIR=/opt/ike-terminal/data node dist/scripts/fix-mbank-fx-commission.js'
 *   # ...i to samo z --apply. UWAGA: skrypty na prodzie idą przez `node dist`,
 *   # a DATA_DIR jest OBOWIĄZKOWY — bez niego skrypt cicho nie zrobi nic.
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { loadHistoricalPrices } from '../services/history-cache.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db', 'import_profiles.db']);

/** Taryfa eMaklera: rynki zagraniczne 0,29%, GPW 0,39%. */
const FOREIGN_RATE = 0.0029;
/** Maksymalna dopuszczalna odchyłka odtworzonego kursu od rynkowego. */
const MAX_DRIFT = 0.02;

interface Row {
  id: number;
  date: string;
  paper_name: string;
  side: 'K' | 'S';
  quantity: number;
  price: number;
  value: number;
  commission: number;
  total: number;
  currency: string;
  payment_currency: string | null;
}

export interface FixPlan {
  fxRate: number;
  commission: number;
  total: number;
  /** Który z przypadków A/B/C zadecydował — do logu i do testów. */
  how: 'tariff' | 'settlement-in-commission' | 'market-fallback';
  note: string;
}

/**
 * Czysta decyzja „co zrobić z tym wierszem" — wydzielona z powłoki skryptu,
 * żeby dała się przetestować na liczbach z produkcji bez dotykania bazy.
 * Zwraca `null`, gdy nie ma czego poprawiać (prowizja zero).
 */
export function planFix(
  row: Pick<Row, 'side' | 'quantity' | 'price' | 'value' | 'commission'>,
  market: number,
): FixPlan | null {
  const value = row.value || row.quantity * row.price;
  if (!(row.commission > 0) || !(value > 0)) return null;

  const tariffFx = row.commission / FOREIGN_RATE / value;
  const settlementFx = row.commission / value;

  let fxRate: number;
  let commission: number;
  let how: FixPlan['how'];
  let note: string;

  if (Math.abs(tariffFx / market - 1) <= MAX_DRIFT) {
    fxRate = round6(tariffFx);
    commission = round2(row.commission / fxRate);
    how = 'tariff';
    note = `taryfa 0,29% → kurs ${fxRate}`;
  } else if (Math.abs(settlementFx / market - 1) <= MAX_DRIFT) {
    fxRate = round6(settlementFx);
    commission = 0;
    how = 'settlement-in-commission';
    note = `pole prowizji zawierało kwotę rozliczenia → kurs ${fxRate}, prowizja 0`;
  } else {
    fxRate = round6(market);
    commission = round2(row.commission / market);
    how = 'market-fallback';
    note = `prowizja minimalna → kurs rynkowy ${market.toFixed(4)} (nie kurs brokera)`;
  }

  const total = row.side === 'K' ? round2(value + commission) : round2(value - commission);
  return { fxRate, commission, total, how, note };
}

/** Kurs zamknięcia z cache'u: dzień transakcji lub najbliższy wcześniejszy. */
function marketRate(quote: string, payment: string, date: string): number | null {
  const ticker = `${quote}${payment}=X`;
  const day = date.slice(0, 10);
  const from = new Date(new Date(day).getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const series = loadHistoricalPrices(ticker, from).filter((p) => p.date <= day);
  return series.length > 0 ? series[series.length - 1].close : null;
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const dbFiles = readdirSync(config.dataDir).filter(
    (f) => f.endsWith('.db') && !EXCLUDED.has(basename(f)),
  );

  let totalFixed = 0;
  let totalSkipped = 0;

  for (const file of dbFiles) {
    const portfolioId = basename(file, '.db');
    let db;
    try {
      db = getDb(portfolioId);
    } catch {
      continue;
    }

    let rows: Row[];
    try {
      rows = db
        .prepare(
          `SELECT id, date, paper_name, side, quantity, price, value, commission, total,
                currency, payment_currency
           FROM transactions
          WHERE source = 'mbank'
            AND payment_currency IS NOT NULL
            AND currency <> payment_currency
            AND fx_rate IS NULL`,
        )
        .all() as Row[];
    } catch {
      continue;
    }
    if (rows.length === 0) continue;

    console.log(`\n=== ${portfolioId} — ${rows.length} wierszy do sprawdzenia`);

    const updates: (FixPlan & { id: number })[] = [];

    for (const r of rows) {
      const payment = r.payment_currency!;
      const market = marketRate(r.currency, payment, r.date);
      if (!market) {
        console.log(
          `  POMINIĘTY id=${r.id} ${r.paper_name}: brak kursu ${r.currency}${payment} w cache`,
        );
        totalSkipped++;
        continue;
      }

      const plan = planFix(r, market);
      if (!plan) {
        console.log(`  bez zmian id=${r.id} ${r.paper_name}: prowizja 0`);
        continue;
      }

      updates.push({ id: r.id, ...plan });
      console.log(
        `  id=${r.id} ${r.paper_name} ${r.date.slice(0, 10)} ${r.quantity}×${r.price} ${r.currency}\n` +
          `     prowizja ${r.commission} → ${plan.commission} ${r.currency} | total ${r.total} → ${plan.total} | ${plan.note}`,
      );
    }

    if (updates.length === 0) continue;

    if (apply) {
      const stmt = db.prepare(
        `UPDATE transactions SET fx_rate = ?, commission = ?, total = ? WHERE id = ?`,
      );
      db.transaction(() => {
        for (const u of updates) stmt.run(u.fxRate, u.commission, u.total, u.id);
      })();
      console.log(`  ZAPISANO ${updates.length} wierszy`);
    }
    totalFixed += updates.length;
  }

  console.log(
    `\n${apply ? 'ZAPISANE' : 'DO ZAPISU (dry-run)'}: ${totalFixed} wierszy, pominiętych: ${totalSkipped}`,
  );
  if (!apply && totalFixed > 0) console.log('Uruchom ponownie z --apply, żeby zapisać.');
}

// Ciało skryptu odpala się TYLKO przy bezpośrednim uruchomieniu — plik jest też
// importowany przez testy `planFix` i nie może wtedy iterować po bazach.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
