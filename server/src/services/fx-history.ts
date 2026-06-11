/**
 * Historyczne kursy walut → PLN dla zamkniętych pozycji.
 *
 * Zamknięta pozycja w walucie obcej ma dwie nogi w różnych datach: otwarcie
 * (koszt) i zamknięcie (przychód). Realny wynik w PLN wymaga przeliczenia każdej
 * nogi po kursie z jej dnia — samo `profitLoss × kurs` gubi efekt walutowy na
 * kapitale (np. zysk 10 USD przy osłabieniu złotego o 10% to dużo więcej niż
 * 10 × kurs zamknięcia).
 *
 * Kursy z Yahoo (`USDPLN=X`) przez fetchYahooHistory — 3-warstwowy cache
 * (NodeCache → price_history.db → sieć), więc po pierwszym żądaniu lookup jest
 * praktycznie darmowy.
 */
import type { ClosedTrade, DividendRecord, DividendCurrencyTotal } from 'shared';
import { fetchYahooHistory } from './yahoo-finance.js';

/** Kurs waluta→PLN na dany dzień (YYYY-MM-DD lub ISO). null = brak danych. */
export type FxToPlnLookup = (currency: string, date: string) => number | null;

/** Weekend/święto: cofamy się do ostatniego notowania, maks. tyle dni. */
const MAX_LOOKBACK_DAYS = 7;

/** GBX/GBp (pensy) = 1/100 GBP — Yahoo ma tylko parę GBPPLN=X. */
function fxPairFor(currency: string): { pair: string; factor: number } | null {
  const upper = currency.toUpperCase();
  if (upper === 'PLN') return null;
  if (upper === 'GBX' || upper === 'GBP') {
    return { pair: 'GBP', factor: currency.toUpperCase() === 'GBX' ? 0.01 : 1 };
  }
  return { pair: upper, factor: 1 };
}

function shiftDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Kurs z mapy dziennej z cofaniem do ostatniego notowania (weekend/święto). */
function rateAt(byDate: Map<string, number> | undefined, date: string): number | null {
  if (!byDate) return null;
  let key = date.slice(0, 10);
  for (let i = 0; i <= MAX_LOOKBACK_DAYS; i++) {
    const rate = byDate.get(key);
    if (rate !== undefined) return rate;
    key = shiftDays(key, -1);
  }
  return null;
}

/** Seria z fetchYahooHistory → mapa data→close (tylko dodatnie); null gdy pusta/błąd. */
async function fetchRateSeries(symbol: string, start: string): Promise<Map<string, number> | null> {
  try {
    const data = await fetchYahooHistory(symbol, start);
    const byDate = new Map<string, number>();
    for (const d of data) {
      if (d.close > 0) byDate.set(d.date, d.close);
    }
    return byDate.size > 0 ? byDate : null;
  } catch (err) {
    console.warn(`fx-history: brak kursów ${symbol}:`, err);
    return null;
  }
}

/** Bezpośrednia seria nie pokrywa zakresu → potrzebny kurs krzyżowy przez USD.
 *  Yahoo dla niektórych par xxxPLN=X zwraca szczątkową historię (np. CADPLN=X:
 *  1 punkt), podczas gdy xxxUSD=X i USDPLN=X są kompletne. */
function needsCrossRate(direct: Map<string, number> | null, fromDate: string): boolean {
  if (!direct || direct.size < 2) return true;
  let earliest = '9999-12-31';
  for (const key of direct.keys()) {
    if (key < earliest) earliest = key;
  }
  return earliest > shiftDays(fromDate, 14);
}

/**
 * Buduje lookup kursów dziennych dla podanych walut od `fromDate`.
 * Brak pary / błąd sieci nie rzuca — lookup zwraca null dla tej waluty,
 * a wywołujący zostawia pola PLN niewypełnione.
 *
 * Kurs bezpośredni (`xxxPLN=X`) ma priorytet; gdy seria jest szczątkowa lub
 * nie pokrywa zakresu, fallback per-data na kurs krzyżowy `xxxUSD=X × USDPLN=X`.
 */
export async function buildFxToPlnLookup(
  currencies: string[],
  fromDate: string,
): Promise<FxToPlnLookup> {
  const pairs = new Set<string>();
  for (const cur of currencies) {
    const norm = fxPairFor(cur);
    if (norm) pairs.add(norm.pair);
  }

  // Bufor na lookback (start zakresu może wypaść w weekend)
  const startKey = fromDate.slice(0, 10);
  const start = shiftDays(startKey, -(MAX_LOOKBACK_DAYS * 2));

  const direct = new Map<string, Map<string, number>>();
  await Promise.all(
    Array.from(pairs).map(async (pair) => {
      const series = await fetchRateSeries(`${pair}PLN=X`, start);
      if (series) direct.set(pair, series);
    }),
  );

  const crossPairs = Array.from(pairs).filter(
    (pair) => pair !== 'USD' && needsCrossRate(direct.get(pair) ?? null, startKey),
  );
  const crossUsd = new Map<string, Map<string, number>>();
  let usdPln = direct.get('USD') ?? null;
  if (crossPairs.length > 0) {
    const fetches: Promise<void>[] = crossPairs.map(async (pair) => {
      const series = await fetchRateSeries(`${pair}USD=X`, start);
      if (series) crossUsd.set(pair, series);
    });
    if (!usdPln) {
      fetches.push(
        fetchRateSeries('USDPLN=X', start).then((series) => {
          usdPln = series;
        }),
      );
    }
    await Promise.all(fetches);
  }

  return (currency, date) => {
    const norm = fxPairFor(currency);
    if (!norm) return 1; // PLN
    const directRate = rateAt(direct.get(norm.pair), date);
    if (directRate !== null) return directRate * norm.factor;
    const curUsd = rateAt(crossUsd.get(norm.pair), date);
    const usdRate = rateAt(usdPln ?? undefined, date);
    if (curUsd !== null && usdRate !== null) return curUsd * usdRate * norm.factor;
    return null;
  };
}

/**
 * Wypełnia `profitLossPln`, `costBasisPln`, `fxRateOpen/Close` na zamkniętych
 * pozycjach (mutacja in-place). Pozycje bez kursu lub bez `costBasis` zostają
 * nietknięte — klient pokazuje je jako nieprzeliczalne zamiast sumować fałszywie.
 *
 * Konwencja: noga otwarcia po kursie z dnia otwarcia, noga zamknięcia po kursie
 * z dnia zamknięcia (jak rozliczenie podatkowe, bez reguły D-1). Wyjątek CFD:
 * wynik materializuje się w walucie konta w dniu zamknięcia, więc całość po
 * kursie zamknięcia (notional to dźwignia, nie zaangażowany kapitał).
 */
export function convertClosedTradesToPln(trades: ClosedTrade[], fx: FxToPlnLookup): void {
  for (const trade of trades) {
    if (trade.currency.toUpperCase() === 'PLN') {
      trade.profitLossPln = trade.profitLoss;
      if (trade.costBasis !== undefined) trade.costBasisPln = trade.costBasis;
      trade.fxRateOpen = 1;
      trade.fxRateClose = 1;
      continue;
    }

    const openFx = fx(trade.currency, trade.buyDate);
    const closeFx = fx(trade.currency, trade.sellDate);
    if (openFx == null || closeFx == null || trade.costBasis === undefined) continue;

    trade.fxRateOpen = openFx;
    trade.fxRateClose = closeFx;

    if (trade.category === 'cfd') {
      trade.profitLossPln = trade.profitLoss * closeFx;
      trade.costBasisPln = trade.costBasis * closeFx;
      continue;
    }

    const fees = (trade.fees ?? []).reduce((s, f) => s + f.amount, 0);
    if (trade.isShort) {
      // buyDate/buyPrice = otwarcie shorta (gotówka wpływa przy otwarciu),
      // sellDate/sellPrice = odkupienie. costBasis = wartość otwarcia + prowizja otwarcia.
      const openValue = trade.costBasis - trade.buyCommission;
      const coverValue =
        openValue - trade.profitLoss - trade.buyCommission - trade.sellCommission - fees;
      trade.profitLossPln =
        (openValue - trade.buyCommission) * openFx -
        (coverValue + trade.sellCommission + fees) * closeFx;
    } else {
      // costBasis = wartość nabycia (z nominałem obligacji) + prowizja kupna,
      // stąd wartość sprzedaży = P/L + costBasis + prowizja sprzedaży + opłaty.
      const sellValue = trade.profitLoss + trade.costBasis + trade.sellCommission + fees;
      trade.profitLossPln =
        (sellValue - trade.sellCommission - fees) * closeFx - trade.costBasis * openFx;
    }
    trade.costBasisPln = trade.costBasis * openFx;
  }
}

/** Sumy dywidend per waluta + łączna równowartość w PLN. */
export interface DividendsPlnSummary {
  totalPln: number;
  totalPlnApprox: boolean;
  byCurrency: DividendCurrencyTotal[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

type DividendLike = Pick<DividendRecord, 'amount' | 'currency' | 'date'>;

/**
 * Pure: sumuje dywidendy per waluta i przelicza każdy rekord na PLN po kursie
 * z dnia jego wypłaty (`fx`). PLN liczy się 1:1.
 *
 * `totalPln` to suma równowartości rekordów dających się przeliczyć. Waluta bez
 * ANI jednego kursu dostaje `pln=null`; jeśli choć jeden rekord danej waluty nie
 * ma kursu, `totalPlnApprox=true` sygnalizuje, że łączna suma jest zaniżona.
 */
export function summarizeDividendsByCurrency(
  dividends: DividendLike[],
  fx: FxToPlnLookup,
): DividendsPlnSummary {
  // Agregacja per waluta: kwota oryginalna, suma PLN z przeliczalnych rekordów,
  // ile rekordów udało się przeliczyć (do wykrycia walut bez ANI jednego kursu).
  const agg = new Map<string, { amount: number; pln: number; converted: number; total: number }>();
  for (const d of dividends) {
    const cur = d.currency.toUpperCase();
    const e = agg.get(cur) ?? { amount: 0, pln: 0, converted: 0, total: 0 };
    e.amount += d.amount;
    e.total += 1;
    const rate = fx(cur, d.date);
    if (rate != null) {
      e.pln += d.amount * rate;
      e.converted += 1;
    }
    agg.set(cur, e);
  }

  let totalPln = 0;
  let totalPlnApprox = false;
  const byCurrency: DividendCurrencyTotal[] = [];
  for (const [currency, e] of agg) {
    const pln = e.converted > 0 ? round2(e.pln) : null; // null tylko gdy zero rekordów przeliczono
    if (pln != null) totalPln += pln;
    if (e.converted < e.total) totalPlnApprox = true; // część (lub całość) waluty bez kursu
    byCurrency.push({ currency, amount: round2(e.amount), pln });
  }
  // Malejąco po PLN; waluty bez kursu (pln=null) na końcu.
  byCurrency.sort((a, b) => (b.pln ?? -Infinity) - (a.pln ?? -Infinity));

  return { totalPln: round2(totalPln), totalPlnApprox, byCurrency };
}

/**
 * Wrapper dla endpointu: buduje lookup kursów (od najwcześniejszej daty wśród
 * walut obcych) i woła `summarizeDividendsByCurrency`. Same PLN-y → bez sieci.
 */
export async function summarizeDividendsInPln(
  dividends: DividendLike[],
): Promise<DividendsPlnSummary> {
  if (dividends.length === 0) return { totalPln: 0, totalPlnApprox: false, byCurrency: [] };

  const foreign = dividends.filter((d) => d.currency.toUpperCase() !== 'PLN');
  let minDate = '9999-12-31';
  for (const d of foreign) {
    const key = d.date.slice(0, 10);
    if (key < minDate) minDate = key;
  }
  const fx: FxToPlnLookup =
    foreign.length > 0
      ? await buildFxToPlnLookup(Array.from(new Set(foreign.map((d) => d.currency))), minDate)
      : (cur) => (cur.toUpperCase() === 'PLN' ? 1 : null);

  return summarizeDividendsByCurrency(dividends, fx);
}

/**
 * Wygodny wrapper dla endpointu: zbiera waluty i najwcześniejszą datę z pozycji,
 * buduje lookup i konwertuje. No-op (poza PLN-ami) gdy wszystko w PLN.
 */
export async function annotateClosedTradesPln(trades: ClosedTrade[]): Promise<void> {
  if (trades.length === 0) return;
  const foreign = trades.filter((t) => t.currency.toUpperCase() !== 'PLN');
  let minDate = '9999-12-31';
  for (const t of foreign) {
    const open = t.buyDate.slice(0, 10);
    if (open < minDate) minDate = open;
  }
  const lookup =
    foreign.length > 0
      ? await buildFxToPlnLookup(Array.from(new Set(foreign.map((t) => t.currency))), minDate)
      : (((cur: string) => (cur.toUpperCase() === 'PLN' ? 1 : null)) as FxToPlnLookup);
  convertClosedTradesToPln(trades, lookup);
}
