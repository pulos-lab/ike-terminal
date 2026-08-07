/* eslint-disable no-console */
/**
 * One-shot naprawa wpisów `ticker_map` wskazujących CUDZY papier — wykrytych
 * niezgodnością CENY, nie waluty.
 *
 * KLASA BŁĘDU (zmierzona na produkcji 2026-08-06, 14 wpisów w 8 portfelach):
 * polski ticker rozwiązany na inną polską spółkę przez skrócenie nazwy do 3-4
 * znaków w starym resolverze — `ATAL → ATA.WA (ATCCARGO)`, `MIRBUD → MIR.WA
 * (MIRACULUM)`, `UNIMOT → UNI.WA (UNIBEP)`, `TSGAMES → TSG.WA (TESGAS)`,
 * `INTU → INT.WA (INTERNITY)`, `ENPH → ENP.WA (ENAP)`, `TIM → TINS.JK`.
 * Dziś takie trafienia blokuje bramka `namesOverlap` w katalogu BR (zgodność
 * 4-znakowego prefiksu nazwy), ale wpisy sprzed niej chroni kotwica
 * w `upsertTickerMapEntry` — samo się nie naprawi.
 *
 * CZYM TO SIĘ RÓŻNI od `fix-pl-ticker-collision.ts`: tamten łapie polski
 * pseudo-ISIN `.WA` rozwiązany na papier ZAGRANICZNY (sygnał: obca giełda/waluta).
 * Tu sygnałem jest ROZJAZD CENY — kolizja polski↔polski ma poprawną giełdę i walutę,
 * więc tamten filtr jej nie widzi.
 *
 * DLACZEGO CENA, A NIE SAMA WALUTA: przesiew po niezgodności waluty daje niemal
 * same fałszywki — na 31 takich wpisów 30 okazało się poprawnymi listingami
 * (cross-listing albo cena zapisana w walucie konta). Rozstrzyga dopiero
 * porównanie ceny transakcji z notowaniem przypisanego papieru.
 *
 * BEZPIECZNIKI:
 *   - Domyślnie DRY-RUN; `--apply` zapisuje
 *   - Kandydat musi przejść OBA sita: walidację trafienia (`isPlausibleMatch`)
 *     ORAZ rozjazd ceny — samo jedno sito ma zbyt wiele fałszywych alarmów
 *   - Rozjazd wyjaśniony ZAPISANYM splitem jest pomijany (tabela `stock_splits`):
 *     EZRA 1:40, IBKR 4:1, LCID i EDU po 1:10 wyglądają jak zły papier, a są poprawne.
 *     Rozpoznajemy je po zdarzeniu z bazy, NIE po „splitowo wyglądającym" ilorazie —
 *     3,93 dla błędnego ATAL i 3,92 dla poprawnego IBKR są nieodróżnialne
 *   - Nowy wpis jest zapisywany TYLKO gdy sam przejdzie weryfikację cenową.
 *     Brak rozpoznania → SKIP, nie kasujemy istniejącego wpisu: „cudza cena"
 *     jest zła, ale kasowanie w ciemno wywala też historię pod tym tickerem
 *   - CFD/obligacje/opcje pomijane (kursy w innej skali — % nominału, wartość
 *     wewnętrzna, mapa statyczna)
 *
 * WAŻNE: uruchamiać PO wdrożeniu bramki `namesOverlap` i rozgrzewki katalogu,
 * inaczej ponowne rozpoznanie trafi w zimny katalog i zwróci null (same SKIP-y).
 *
 * Usage:
 *   cd server && npx tsx src/scripts/fix-ticker-price-mismatch.ts            # dry-run
 *   cd server && npx tsx src/scripts/fix-ticker-price-mismatch.ts --apply    # zapis
 *   cd server && npx tsx src/scripts/fix-ticker-price-mismatch.ts --only=ID  # 1 portfel
 *
 * Produkcja (po deployu):
 *   ssh … 'cd /opt/ike-terminal/server && npx tsx src/scripts/fix-ticker-price-mismatch.ts'
 *   # Po --apply zrestartuj serwer, żeby zinvalidować in-memory cache cen.
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import type { TickerMapEntry } from 'shared';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import { resolveIsin } from '../services/isin-resolver.js';
import { isPlausibleMatch } from '../services/ticker-match.js';
import { fetchYahooHistoryDirect } from '../services/yahoo-finance.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db', 'import_profiles.db']);

/** Tolerancja dopasowania ilorazu cen. Luźna, bo porównujemy cenę WYKONANIA
 *  transakcji z kursem zamknięcia — kilkanaście procent różnicy jest normalne. */
const RATIO_TOLERANCE = 0.25;

/** Tolerancja dla dopasowania do KURSU WALUTOWEGO — ciaśniejsza, bo kurs jest
 *  liczbą precyzyjną, a nie widełkami jak cena wykonania vs kurs zamknięcia. */
const FX_TOLERANCE = 0.1;

export type PriceVerdict =
  | 'zgodna'
  | 'inna-waluta'
  | 'jednostka-gbx'
  | 'split'
  | 'niezgodna'
  | 'brak-danych';

/**
 * Czy cena transakcji pasuje do notowania przypisanego papieru?
 *
 * Czysta funkcja — cała wiedza o tym, co JEST błędem, a co tylko wygląda:
 *  - iloraz ≈ 1              → ten sam papier, ta sama skala
 *  - iloraz ≈ kurs walutowy  → poprawny listing, cena zapisana w innej walucie
 *  - iloraz ≈ 100 lub 1/100  → funty vs pensy
 *  - iloraz ≈ ZNANY split    → papier poprawny, różnicę robi split
 *  - reszta                  → cudzy papier
 *
 * PUŁAPKA, którą to kosztowało: split rozpoznajemy po ZAPISANYM zdarzeniu
 * (`stock_splits`), nie po tym, że iloraz „wygląda na splitowy". Iloraz 3,93 dla
 * ATAL → ATA.WA (ATCCARGO, realny błąd) i 3,92 dla IBKR po splicie 4:1 (wpis
 * poprawny) są NIEODRÓŻNIALNE. Heurystyka po samej liczbie przepuszczała ATAL.
 */
export function classifyPrice(opts: {
  txPrice: number;
  providerPrice: number | null;
  /** Kurs waluty notowania wyrażony w walucie transakcji (mapCur → txCur). */
  fxRate: number | null;
  /** Iloczyn ratio splitów ZAPISANYCH dla tego papieru po dacie transakcji (1 = brak). */
  splitRatio?: number;
}): PriceVerdict {
  const { txPrice, providerPrice, fxRate, splitRatio = 1 } = opts;
  if (!providerPrice || providerPrice <= 0 || !txPrice || txPrice <= 0) return 'brak-danych';

  const ratio = txPrice / providerPrice;
  const near = (a: number, b: number) => b > 0 && Math.abs(a / b - 1) < RATIO_TOLERANCE;

  if (near(ratio, 1)) return 'zgodna';
  // Kurs walutowy jest liczbą PRECYZYJNĄ — przy 25% tolerancji zbyt łatwo o zbieg
  // okoliczności (patrz TIM → TIMB). Realny przypadek trafia w kilka procent:
  // IWDA 540,68/144,24 = 3,749 przy kursie 3,73.
  if (fxRate && Math.abs(ratio / fxRate - 1) < FX_TOLERANCE) return 'inna-waluta';
  if (near(ratio, 100) || near(ratio, 0.01)) return 'jednostka-gbx';
  if (splitRatio !== 1 && near(ratio, splitRatio)) return 'split';
  return 'niezgodna';
}

/** Werdykty, przy których wpis uznajemy za dobry (papier się zgadza). */
export function verdictLooksCorrect(v: PriceVerdict): boolean {
  return v === 'zgodna' || v === 'inna-waluta' || v === 'jednostka-gbx';
}

/**
 * Czy ponowić rozpoznanie, udając walutę obcą?
 *
 * PRZYCZYNA ŹRÓDŁOWA CZĘŚCI TYCH BŁĘDÓW (zmierzona 2026-08-06): transakcja niesie
 * walutę KONTA (PLN), a nie walutę notowania. Cena zgadza się co do grosza
 * z notowaniem rodzimym — `INTU` 551,07 „PLN" vs Intuit 545,40 USD, `ABEA.DE`
 * 270,25 vs 267,55 EUR, `NOVOB.CO` 282,80 vs 287,50 DKK. Zła etykieta wpycha
 * zagraniczny papier w POLSKĄ gałąź resolvera (`isPseudoIsin && txCurrency==='PLN'`),
 * gdzie akceptowane są tylko listingi `.WA` — i dopiero tam skracanie nazwy dorabia
 * `INTU` → `INT` (Internity). Kolizja tickera jest SKUTKIEM, nie przyczyną.
 *
 * Ponowienie z walutą inną niż PLN kieruje resolver w gałąź zagraniczną. Wartość
 * waluty jest tylko przełącznikiem gałęzi — `buildEntry` i tak nadpisze ją walutą
 * zwróconą przez Yahoo. Wynik i tak musi przejść weryfikację cenową.
 */
export function shouldRetryAsForeign(txCurrency: string, firstAttemptFailed: boolean): boolean {
  return firstAttemptFailed && (txCurrency || '').toUpperCase() === 'PLN';
}

interface TickerRow {
  isin: string;
  ticker: string;
  name: string;
  exchange: string;
  currency: string;
}

interface Candidate {
  portfolioId: string;
  row: TickerRow;
  paperName: string;
  txCurrency: string;
  txDate: string;
  txPrice: number;
  verdict: PriceVerdict;
}

interface Outcome {
  portfolioId: string;
  isin: string;
  oldDesc: string;
  newDesc: string;
  status: 'fixed' | 'skipped';
  reason?: string;
  /** Ustawiane, gdy waluta transakcji ≠ waluta notowania naprawionego papieru.
   *  Skrypt tego NIE naprawia (osobna sprawa: reconcileQuoteCurrencies). */
  currencyLabelNote?: string;
}

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

/** GBX/GBp i GBP to ta sama waluta w innej jednostce. */
function normCur(c: string): string {
  const u = (c || '').toUpperCase();
  return u === 'GBX' ? 'GBP' : u;
}

/** Notowanie przypisanego papieru w okolicy daty transakcji (pensy → funty). */
async function providerPriceAt(ticker: string, date: string, mapCur: string) {
  const raw = await fetchYahooHistoryDirect(ticker, date);
  if (raw == null) return null;
  return normCur(mapCur) === 'GBP' && ticker.endsWith('.L') ? raw / 100 : raw;
}

/**
 * Kurs waluty Z DNIA TRANSAKCJI, nie dzisiejszy.
 *
 * PUŁAPKA (dry-run na produkcji 2026-08-07): przy kursie bieżącym skrypt
 * zaproponował `TIM` (polski, 50,69 PLN ze stycznia 2024) → `TIMB` na NYSE, czyli
 * BRAZYLIJSKI telekom o identycznej nazwie prawnej „TIM S.A.". Iloraz 50,69/17,78
 * = 2,85 nie pasuje do kursu USD/PLN z tamtej daty (~3,99), ale mieścił się
 * w tolerancji względem kursu DZISIEJSZEGO (~3,5). Porównywanie ceny sprzed dwóch
 * lat z dzisiejszym kursem to nie jest weryfikacja.
 */
async function fxBetween(from: string, to: string, date: string): Promise<number | null> {
  const f = normCur(from);
  const t = normCur(to);
  if (!f || !t || f === t) return 1;
  const asOf = await fetchYahooHistoryDirect(`${f}${t}=X`, date);
  if (asOf && asOf > 0) return asOf;
  // Brak notowania pary na tę datę → NIE podstawiamy kursu bieżącego. Bez kursu
  // gałąź „inna waluta" po prostu nie zadziała, a wynik trafi do SKIP-ów.
  return null;
}

/** Kandydaci: trafienie nieprzekonujące dla walidatora ORAZ rozjechana cena. */
async function findCandidates(portfolioId: string): Promise<Candidate[]> {
  const db = getDb(portfolioId);
  const rows = db
    .prepare(
      `SELECT m.isin, m.ticker, m.name, m.exchange, m.currency
       FROM ticker_map m
       WHERE m.isin NOT LIKE 'OPT:%'
         AND EXISTS (SELECT 1 FROM transactions t WHERE t.isin = m.isin
                     AND t.category NOT IN ('bond','cfd','option'))`,
    )
    .all() as TickerRow[];

  const lastTxStmt = db.prepare(
    `SELECT paper_name, currency, date, price FROM transactions
     WHERE isin = ? AND price > 0 ORDER BY date DESC LIMIT 1`,
  );
  // Splity ZAPISANE po dacie transakcji tłumaczą rozjazd ceny bez zmiany papieru.
  const splitsStmt = db.prepare('SELECT ratio FROM stock_splits WHERE isin = ? AND split_date > ?');
  const splitRatioSince = (isin: string, date: string): number =>
    (splitsStmt.all(isin, date) as Array<{ ratio: number }>).reduce(
      (acc, s) => acc * (s.ratio || 1),
      1,
    );

  const out: Candidate[] = [];
  for (const row of rows) {
    const tx = lastTxStmt.get(row.isin) as
      | { paper_name: string; currency: string; date: string; price: number }
      | undefined;
    if (!tx) continue;

    // Sito 1 (bez sieci): czy trafienie w ogóle wygląda na ten papier?
    if (isPlausibleMatch([row.isin, tx.paper_name], { symbol: row.ticker, name: row.name || '' })) {
      continue;
    }

    // Sito 2 (sieć): czy cena się rozjeżdża? Samo sito 1 ma ~80% fałszywek
    // (skrócone nazwy od brokerów: „AMPHASTAR PHARMACEUTICALS IN" → AMPH).
    const date = tx.date.slice(0, 10);
    const providerPrice = await providerPriceAt(row.ticker, date, row.currency);
    const fxRate = await fxBetween(row.currency, tx.currency, date);
    const splitRatio = splitRatioSince(row.isin, date);
    const verdict = classifyPrice({ txPrice: tx.price, providerPrice, fxRate, splitRatio });
    if (verdict !== 'niezgodna') continue;

    out.push({
      portfolioId,
      row,
      paperName: tx.paper_name || row.isin,
      txCurrency: tx.currency,
      txDate: date,
      txPrice: tx.price,
      verdict,
    });
  }
  return out;
}

/** Jedna próba rozpoznania + weryfikacja cenowa nowego trafienia. */
async function attempt(c: Candidate, currency: string) {
  const entry = await resolveIsin(c.row.isin, c.paperName, currency);
  if (!entry || entry.ticker === c.row.ticker)
    return { entry, verdict: null as PriceVerdict | null };
  const price = await providerPriceAt(entry.ticker, c.txDate, entry.currency);
  const fx = await fxBetween(entry.currency, c.txCurrency, c.txDate);
  return {
    entry,
    verdict: classifyPrice({ txPrice: c.txPrice, providerPrice: price, fxRate: fx }),
  };
}

async function repair(c: Candidate, apply: boolean): Promise<Outcome> {
  const oldDesc = `${c.row.ticker} ${c.row.exchange}/${c.row.currency} (${c.row.name || '?'})`;
  const base = { portfolioId: c.portfolioId, isin: c.row.isin, oldDesc };

  let entry: TickerMapEntry | null = null;
  let verdict: PriceVerdict | null = null;
  try {
    ({ entry, verdict } = await attempt(c, c.txCurrency));

    // Druga próba dla papierów z etykietą PLN — patrz `shouldRetryAsForeign`.
    // Bez niej zagraniczna spółka z błędną etykietą waluty wpada z powrotem
    // w polską gałąź i „naprawa" kończy się tym samym błędem albo nullem.
    if (shouldRetryAsForeign(c.txCurrency, !entry || !verdict || !verdictLooksCorrect(verdict))) {
      const foreign = await attempt(c, 'USD');
      if (foreign.verdict && verdictLooksCorrect(foreign.verdict)) {
        entry = foreign.entry;
        verdict = foreign.verdict;
      }
    }
  } catch (err: any) {
    return { ...base, newDesc: '—', status: 'skipped', reason: `resolveIsin: ${err.message}` };
  }

  if (!entry) {
    return {
      ...base,
      newDesc: '—',
      status: 'skipped',
      reason: 'resolver nic nie zwrócił — wpis ZOSTAJE (kasowanie wywaliłoby historię)',
    };
  }

  const newDesc = `${entry.ticker} ${entry.exchange}/${entry.currency} (${entry.name})`;
  if (entry.ticker === c.row.ticker) {
    return {
      ...base,
      newDesc,
      status: 'skipped',
      reason: 'resolver zwraca ten sam ticker — zweryfikuj ręcznie',
    };
  }

  if (!verdict || !verdictLooksCorrect(verdict)) {
    return {
      ...base,
      newDesc,
      status: 'skipped',
      reason: `nowe trafienie też nie przechodzi weryfikacji ceny (${verdict ?? 'brak-danych'})`,
    };
  }

  // Etykieta waluty transakcji bywa walutą KONTA, nie notowania — to właśnie ona
  // wepchnęła te papiery w polską gałąź. Sygnalizujemy, ale nie naprawiamy tutaj.
  const labelMismatch =
    normCur(c.txCurrency) !== normCur(entry.currency)
      ? `waluta transakcji ${c.txCurrency} ≠ waluta notowania ${entry.currency} — etykieta do naprawy osobno`
      : undefined;

  // force=true — kotwica w upsertTickerMapEntry celowo NIE puszcza nadpisania
  // istniejącego wpisu (chroni ciągłość historii cen przed cichą podmianą
  // tickera). Tu obchodzimy ją świadomie, po weryfikacji cenowej obu stron.
  if (apply) upsertTickerMapEntry(entry, c.portfolioId, true);
  return { ...base, newDesc, status: 'fixed', currencyLabelNote: labelMismatch };
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
    console.log('Brak baz portfeli w', config.dataDir);
    return;
  }

  console.log(
    `${apply ? 'ZAPIS' : 'DRY-RUN'} — skan ${portfolios.length} portfeli (${config.dataDir})\n`,
  );

  const outcomes: Outcome[] = [];
  for (const pid of portfolios) {
    let candidates: Candidate[] = [];
    try {
      candidates = await findCandidates(pid);
    } catch (err: any) {
      console.error(`[${pid}] skan nieudany: ${err.message}`);
      continue;
    }
    for (const c of candidates) {
      console.log(
        `[${pad(pid.slice(0, 8), 8)}] ${pad(c.row.isin, 14)} tx ${c.txPrice} ${c.txCurrency} @${c.txDate}`,
      );
      outcomes.push(await repair(c, apply));
    }
  }

  const fixed = outcomes.filter((o) => o.status === 'fixed');
  const skipped = outcomes.filter((o) => o.status === 'skipped');

  console.log(`\n── Do naprawy: ${fixed.length} ──`);
  for (const o of fixed) {
    console.log(`  ${pad(o.portfolioId.slice(0, 8), 8)} ${pad(o.isin, 14)} ${o.oldDesc}`);
    console.log(`  ${' '.repeat(23)}→ ${o.newDesc}`);
    if (o.currencyLabelNote) console.log(`  ${' '.repeat(23)}  ⚠ ${o.currencyLabelNote}`);
  }
  console.log(`\n── Pominięte: ${skipped.length} ──`);
  for (const o of skipped) {
    console.log(
      `  ${pad(o.portfolioId.slice(0, 8), 8)} ${pad(o.isin, 14)} ${o.oldDesc} — ${o.reason}`,
    );
  }
  if (!apply && fixed.length > 0) {
    console.log('\nTo był DRY-RUN. Uruchom z --apply, żeby zapisać, i zrestartuj serwer.');
  }
}

// Uruchomienie tylko jako skrypt — import w testach nie może odpalić skanu.
if (process.argv[1] && process.argv[1].includes('fix-ticker-price-mismatch')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
