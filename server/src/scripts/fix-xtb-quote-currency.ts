/* eslint-disable no-console */
/**
 * Backfill walut transakcji XTB: przywrócenie waluty NOTOWANIA w polu `currency`.
 *
 * ── GENEZA ────────────────────────────────────────────────────────────────────
 * Do PR #124 parser XTB zapisywał w `currency` walutę KONTA zamiast waluty
 * notowania, a `fxRate` zostawiał pusty. Kwoty (`price`/`value`/`total`) były
 * i są poprawne — w walucie instrumentu — więc wiersz wychodził wewnętrznie
 * spójny, ale kłamał o tym, czym jest. Skutek: euro liczone jak złotówki.
 *
 * Parser naprawiono 2026-07-07 (#124) i dziś liczy to bezbłędnie — sprawdzone na
 * realnym pliku: `NOVOB.CO qty=8 price=308,35 currency=DKK payCcy=PLN fx=0,5620`.
 * Odnotowany tam rollout „batche XTB na prodzie do re-importu" NIGDY nie został
 * wykonany, więc ~1700 transakcji w ~27 portfelach nadal ma stare etykiety.
 * Ten skrypt jest tym zaległym rolloutem.
 *
 * ── MODEL DZIEDZINOWY (od właściciela produktu, zweryfikowany na danych) ──────
 * Konta XTB są PER WALUTA (PLN/USD/EUR). Na koncie walutowym papier kupuje się
 * w walucie tickera bez konwersji. Na koncie PLN papier zagraniczny → automatyczne
 * przewalutowanie. Konta IKE/IKZE ZAWSZE przewalutowują (nie wolno tam trzymać
 * obcej gotówki). Potwierdzenie: 44 portfele mają jedną walutę wpłat = jedną
 * walutę rozliczenia.
 *
 *   payment_currency := waluta konta (z wpłat w cash_operations)
 *   currency         := waluta notowania (z ticker_map, tj. z Yahoo)
 *   fxRate           := null gdy równe; inaczej kurs pary notowanie→rozliczenie
 *
 * ── DLACZEGO KURS JEST PRZYBLIŻONY ───────────────────────────────────────────
 * Plik XTB podaje cenę w walucie instrumentu (kolumna Comment) i kwotę w walucie
 * konta (kolumna Amount) — iloraz to dokładny kurs brokera. Ale przy zapisie
 * `value` policzono jako `qty × price`, więc kwota w walucie konta PRZEPADŁA i
 * z samej bazy nie da się jej odtworzyć. Zostaje kurs rynkowy z dnia transakcji
 * plus korekta spreadu.
 *
 * Spread zmierzony na 184 PRAWDZIWYCH kursach brokera z poprawnych importów
 * (odchylenie od kursu zamknięcia Yahoo tego samego dnia):
 *
 *        strona     p10      mediana    p90
 *        KUPNO     +0,12%    +0,60%    +0,99%
 *        SPRZEDAŻ  −0,78%    −0,50%    −0,26%
 *
 * Po korekcie stałymi niżej błąd resztkowy: mediana 0,22% (K) / 0,11% (S);
 * ≤0,5% dla ~90% transakcji, ≤1% dla ~99%.
 *
 * UWAGA: część tego rozrzutu to nie spread, tylko ruch kursu w ciągu dnia wobec
 * kursu zamknięcia, z którym porównujemy. Stałe absorbują oba efekty naraz.
 *
 * Przybliżenie dotyczy WYŁĄCZNIE kosztu nabycia i strony gotówkowej. Bieżąca
 * wycena pozycji liczy się z aktualnej ceny w walucie notowania, więc po tym
 * backfillu jest DOKŁADNA. Kto chce kurs co do grosza — wgrywa plik ponownie,
 * a poprawny parser nadpisze przybliżenie prawdziwą wartością.
 *
 * ── BEZPIECZNIKI ─────────────────────────────────────────────────────────────
 *  - tylko `source = 'xtb'`
 *  - pomija CFD i `fx_exchange` — tam parser CELOWO używa waluty konta
 *  - pomija gdy brak wpisu w ticker_map albo brak w nim waluty
 *  - pomija gdy wpis ticker_map nie przechodzi walidacji `isPlausibleMatch`
 *    (mógłby wskazywać cudzą spółkę — wtedy jego waluta też jest podejrzana)
 *  - pomija portfele bez wpłat w cash_operations (waluta konta nieustalalna)
 *  - NIE RUSZA `price`/`value`/`total` — te liczby są poprawne
 *  - domyślnie DRY-RUN
 *
 * Kolejność: NAJPIERW ten skrypt, POTEM `fix-mismatched-tickers` — pozycje
 * z błędnym mapowaniem mają w ticker_map złą walutę, więc guard je tu pominie;
 * po naprawie tickera warto puścić ten skrypt ponownie.
 *
 * Usage (lokalnie):
 *   npx tsx server/src/scripts/fix-xtb-quote-currency.ts
 *   npx tsx server/src/scripts/fix-xtb-quote-currency.ts --apply
 *   npx tsx server/src/scripts/fix-xtb-quote-currency.ts --only=<portfolioId>
 *
 * PRODUKCJA — nie ma tam `tsx`, a DATA_DIR jest OBOWIĄZKOWY (patrz #194):
 *   cd /opt/ike-terminal/app/server
 *   DATA_DIR=/opt/ike-terminal/data node dist/scripts/fix-xtb-quote-currency.js
 *   DATA_DIR=/opt/ike-terminal/data node dist/scripts/fix-xtb-quote-currency.js --apply
 *   systemctl restart ike-terminal
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { getTickerMap } from '../db/ticker-map-repo.js';
import { bumpPortfolioDataVersion } from '../db/data-version.js';
import { fetchYahooHistory } from '../services/yahoo-finance.js';
import { isPlausibleMatch } from '../services/ticker-match.js';

const EXCLUDED_DB = new Set([
  'auth.db',
  'price_history.db',
  'bug-reports.db',
  'import_profiles.db',
]);

/** Kategorie, w których parser CELOWO trzyma walutę konta — nie ruszamy. */
const SKIP_CATEGORIES = new Set(['cfd', 'fx_exchange']);

/**
 * Korekta spreadu XTB nakładana na kurs rynkowy. Wyprowadzona empirycznie
 * z 184 prawdziwych kursów brokera (mediana: +0,60% kupno / −0,50% sprzedaż).
 * Broker sprzedaje walutę drożej i skupuje taniej, więc znaki są przeciwne.
 */
const SPREAD_BUY = 1.006;
const SPREAD_SELL = 0.995;

interface TxRow {
  id: number;
  isin: string;
  paper_name: string;
  currency: string | null;
  payment_currency: string | null;
  fx_rate: number | null;
  category: string | null;
  side: string;
  date: string;
}

interface Change {
  portfolioId: string;
  id: number;
  isin: string;
  date: string;
  side: string;
  fromCcy: string;
  toCcy: string;
  fromPay: string;
  toPay: string;
  fxRate: number | null;
}

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED_DB.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

/** Waluta konta = dominująca waluta wpłat/wypłat XTB. `null` gdy brak danych. */
function accountCurrency(portfolioId: string): string | null {
  try {
    const row = getDb(portfolioId)
      .prepare(
        `SELECT currency, COUNT(*) AS n FROM cash_operations
         WHERE source = 'xtb' AND operation_type IN ('deposit','withdrawal')
         GROUP BY currency ORDER BY n DESC LIMIT 1`,
      )
      .get() as { currency: string } | undefined;
    return row?.currency?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

/** Cache serii FX per para, żeby nie odpytywać Yahoo raz na transakcję. */
const fxCache = new Map<string, Map<string, number>>();

/**
 * Seria kursów dla pary, pobierana od `since` i cache'owana per para.
 *
 * UWAGA: `since` MUSI być globalnie najstarszą datą transakcji w całej produkcji,
 * a nie datą z bieżącego portfela. Cache jest kluczowany samą parą walut, więc
 * pierwsze wywołanie ustala zakres serii dla wszystkich kolejnych portfeli —
 * gdyby przyszło z portfela o krótszej historii, każdy późniejszy portfel ze
 * starszymi transakcjami zgłaszałby „brak kursu" i zostałby po cichu pominięty.
 * Realny przypadek: pierwszy portfel startował od 2025-01-03, a najstarsza
 * transakcja XTB na produkcji jest z 2020-10-07 → 242 wiersze wypadały z backfillu.
 */
async function fxSeries(from: string, to: string, since: string): Promise<Map<string, number>> {
  const key = `${from}${to}`;
  const hit = fxCache.get(key);
  if (hit) return hit;
  const out = new Map<string, number>();
  try {
    const hist = await fetchYahooHistory(`${from}${to}=X`, since);
    for (const p of hist) out.set(p.date, p.close);
  } catch {
    // pusta mapa → wołający zgłosi brak kursu
  }
  fxCache.set(key, out);
  return out;
}

/** Najstarsza transakcja XTB w całej produkcji — wspólny start serii FX. */
function globalEarliestXtbDate(portfolios: string[]): string | null {
  let earliest: string | null = null;
  for (const pid of portfolios) {
    try {
      const row = getDb(pid)
        .prepare(`SELECT MIN(substr(date,1,10)) AS d FROM transactions WHERE source = 'xtb'`)
        .get() as { d: string | null } | undefined;
      const d = row?.d;
      if (d && (earliest === null || d < earliest)) earliest = d;
    } catch {
      // portfel bez tabeli transakcji — pomijamy
    }
  }
  return earliest;
}

/** Kurs na dany dzień; przy braku (weekend/święto) cofa się do 7 dni wstecz. */
function rateOn(series: Map<string, number>, date: string): number | null {
  const d = new Date(date + 'T00:00:00Z');
  for (let i = 0; i < 8; i++) {
    const key = d.toISOString().slice(0, 10);
    const v = series.get(key);
    if (v) return v;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return null;
}

async function processPortfolio(
  portfolioId: string,
  fxSince: string,
  changes: Change[],
  skips: Map<string, number>,
): Promise<void> {
  const bump = (r: string) => skips.set(r, (skips.get(r) ?? 0) + 1);

  let rows: TxRow[];
  try {
    rows = getDb(portfolioId)
      .prepare(
        `SELECT id, isin, paper_name, currency, payment_currency, fx_rate, category, side,
                substr(date,1,10) AS date
         FROM transactions WHERE source = 'xtb'`,
      )
      .all() as TxRow[];
  } catch {
    return;
  }
  if (rows.length === 0) return;

  const acct = accountCurrency(portfolioId);
  if (!acct) {
    for (const _ of rows) bump('brak wpłat — waluta konta nieustalalna');
    return;
  }

  const tickerMap = getTickerMap(portfolioId);

  for (const row of rows) {
    if (row.category && SKIP_CATEGORIES.has(row.category)) {
      bump('CFD/FX — parser celowo używa waluty konta');
      continue;
    }
    const entry = tickerMap.get(row.isin);
    if (!entry?.currency) {
      bump('brak wpisu w ticker_map lub brak w nim waluty');
      continue;
    }
    // Guard: wpis wskazujący cudzą spółkę ma też cudzą walutę.
    if (
      !isPlausibleMatch([row.isin, row.paper_name], {
        symbol: entry.ticker,
        name: entry.name || '',
      })
    ) {
      bump('ticker_map nie przechodzi walidacji — najpierw fix-mismatched-tickers');
      continue;
    }

    const quote = entry.currency.toUpperCase();
    const curCcy = (row.currency || '').toUpperCase();
    const curPay = (row.payment_currency || '').toUpperCase();
    if (curCcy === quote && curPay === acct) {
      bump('już poprawne');
      continue;
    }

    let fxRate: number | null = null;
    if (quote !== acct) {
      const series = await fxSeries(quote, acct, fxSince);
      const mkt = rateOn(series, row.date);
      if (mkt === null) {
        bump(`brak kursu ${quote}/${acct} na dzień transakcji`);
        continue;
      }
      fxRate = mkt * (row.side === 'K' ? SPREAD_BUY : SPREAD_SELL);
      fxRate = Math.round(fxRate * 1e6) / 1e6;
    }

    changes.push({
      portfolioId,
      id: row.id,
      isin: row.isin,
      date: row.date,
      side: row.side,
      fromCcy: curCcy || '—',
      toCcy: quote,
      fromPay: curPay || '—',
      toPay: acct,
      fxRate,
    });
  }
}

function applyChanges(changes: Change[]): void {
  const byPortfolio = new Map<string, Change[]>();
  for (const c of changes) {
    const arr = byPortfolio.get(c.portfolioId) ?? [];
    arr.push(c);
    byPortfolio.set(c.portfolioId, arr);
  }
  for (const [pid, list] of byPortfolio) {
    const db = getDb(pid);
    const stmt = db.prepare(
      'UPDATE transactions SET currency = ?, payment_currency = ?, fx_rate = ? WHERE id = ?',
    );
    const run = db.transaction((items: Change[]) => {
      for (const c of items) stmt.run(c.toCcy, c.toPay, c.fxRate, c.id);
    });
    run(list);
    bumpPortfolioDataVersion(pid); // raz per portfel — invalidacja memo historii
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length) : null;

  const allPortfolios = listPortfolios();
  const portfolios = only ? [only] : allPortfolios;
  console.log(`Analizuję ${portfolios.length} portfel(i)...`);

  // Zakres serii FX liczymy ZAWSZE po wszystkich portfelach, także przy --only:
  // cache jest wspólny dla całego przebiegu, więc musi startować od globalnie
  // najstarszej transakcji, inaczej starsze wiersze cicho wypadną z backfillu.
  const fxSince = globalEarliestXtbDate(allPortfolios);
  if (!fxSince) {
    console.log('Brak transakcji XTB — nic do zrobienia.');
    return;
  }
  console.log(`Serie kursów FX od ${fxSince} (najstarsza transakcja XTB).\n`);

  const changes: Change[] = [];
  const skips = new Map<string, number>();
  for (const pid of portfolios) await processPortfolio(pid, fxSince, changes, skips);

  // ── Raport zbiorczy ──
  const byTransition = new Map<string, number>();
  const byPortfolio = new Map<string, number>();
  for (const c of changes) {
    const k = `${c.fromCcy} → ${c.toCcy}`;
    byTransition.set(k, (byTransition.get(k) ?? 0) + 1);
    byPortfolio.set(c.portfolioId, (byPortfolio.get(c.portfolioId) ?? 0) + 1);
  }

  console.log('=== ZMIANY WALUTY NOTOWANIA ===');
  for (const [k, n] of [...byTransition.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(16)} ${String(n).padStart(6)}`);
  }
  const payChanges = changes.filter((c) => c.fromPay !== c.toPay).length;
  console.log(`\n   zmian payment_currency: ${payChanges}`);
  console.log(`   nadanych fxRate:        ${changes.filter((c) => c.fxRate !== null).length}`);

  console.log('\n=== POMINIĘTE ===');
  for (const [r, n] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(6)}  ${r}`);
  }

  console.log(`\n=== PORTFELE (${byPortfolio.size}) ===`);
  for (const [pid, n] of [...byPortfolio.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`   ${pid.slice(0, 8)}  ${String(n).padStart(5)} transakcji`);
  }

  console.log('\n=== PRÓBKA (pierwsze 15) ===');
  for (const c of changes.slice(0, 15)) {
    const fx = c.fxRate === null ? 'bez konwersji' : `fx=${c.fxRate}`;
    console.log(
      `   ${c.portfolioId.slice(0, 8)} ${c.date} ${c.side} ${c.isin.padEnd(20)} ` +
        `${c.fromCcy}→${c.toCcy}  pay ${c.fromPay}→${c.toPay}  ${fx}`,
    );
  }

  console.log(`\nRAZEM DO ZMIANY: ${changes.length} transakcji w ${byPortfolio.size} portfelach`);

  if (!apply) {
    console.log('\nDRY-RUN — nic nie zapisano. Uruchom z --apply, aby wprowadzić zmiany.');
    return;
  }
  applyChanges(changes);
  console.log(`\nZAPISANO ${changes.length} transakcji.`);
  console.log('UWAGA: wyceny tych portfeli wzrosną — waluty obce przestaną być liczone jak PLN.');
  console.log('Zrestartuj serwer: systemctl restart ike-terminal');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
