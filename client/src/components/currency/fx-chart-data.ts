import type { FxChartPair, FxExchangeRecord } from 'shared';

/**
 * Czyste przekształcenia danych wymian walut pod wykres pary (FxRateChart):
 * przypisanie do pary, kurs w konwencji wykresu, agregacja dzienna, ledger
 * średniego kursu nabycia.
 *
 * KONWENCJE ŹRÓDEŁ (realne dane z baz):
 * - `rate` NIE ma jednej konwencji: IBKR/bossa zapisują kurs rynkowy pary
 *   niezależnie od kierunku wymiany, ręczny dialog `amountFrom/amountTo`.
 *   Dlatego kurs liczymy z KWOT — odporne na źródło i pokazuje kurs
 *   faktycznie uzyskany (ze spreadem brokera), nie rynkowy.
 * - `fx_pair` bywa kierunkiem ("PLN/USD" u bossy), nie parą rynkową
 *   ("USD/PLN" u IBKR) — przypisanie do wykresu po zbiorze walut.
 */

/** Waluta bazowa pary (kwotowana kursem) i waluta kwotowania (jednostka osi Y). */
export const FX_PAIR_META: Record<FxChartPair, { base: string; quote: string; label: string }> = {
  USDPLN: { base: 'USD', quote: 'PLN', label: 'USD/PLN' },
  EURPLN: { base: 'EUR', quote: 'PLN', label: 'EUR/PLN' },
  USDEUR: { base: 'USD', quote: 'EUR', label: 'USD/EUR' },
};

export const FX_CHART_PAIRS = Object.keys(FX_PAIR_META) as FxChartPair[];

/** Para wykresu dla wymiany — po zbiorze walut {from,to}; null gdy żadna. */
export function pairOf(ex: FxExchangeRecord): FxChartPair | null {
  for (const pair of FX_CHART_PAIRS) {
    const { base, quote } = FX_PAIR_META[pair];
    if (
      (ex.currencyFrom === base && ex.currencyTo === quote) ||
      (ex.currencyFrom === quote && ex.currencyTo === base)
    ) {
      return pair;
    }
  }
  return null;
}

/** Kierunek względem waluty BAZOWEJ pary: buy = nabycie bazy (PLN→USD na USD/PLN). */
export function directionOf(ex: FxExchangeRecord, pair: FxChartPair): 'buy' | 'sell' {
  return ex.currencyTo === FX_PAIR_META[pair].base ? 'buy' : 'sell';
}

/** Kwota w walucie bazowej pary (rozmiar wymiany na osi markera/tooltipa). */
export function baseAmount(ex: FxExchangeRecord, pair: FxChartPair): number {
  return ex.currencyFrom === FX_PAIR_META[pair].base ? ex.amountFrom : ex.amountTo;
}

/**
 * Kurs wymiany w konwencji wykresu (waluta kwotowania za 1 bazową) — liczony
 * z kwot, nie z pola `rate` (patrz nagłówek modułu). null przy zerowych kwotach.
 */
export function exchangeRate(ex: FxExchangeRecord, pair: FxChartPair): number | null {
  const { base } = FX_PAIR_META[pair];
  const amtBase = ex.currencyFrom === base ? ex.amountFrom : ex.amountTo;
  const amtQuote = ex.currencyFrom === base ? ex.amountTo : ex.amountFrom;
  if (!(amtBase > 0) || !(amtQuote > 0)) return null;
  return amtQuote / amtBase;
}

export interface FxDayAggregate {
  /** Dzień kalendarzowy wymiany (YYYY-MM-DD) — przed snapem do sesji. */
  date: string;
  direction: 'buy' | 'sell';
  /** Suma kwot w walucie bazowej pary. */
  amountBase: number;
  /** Kurs ważony kwotą bazową. */
  rate: number;
  /** Pojedyncze wymiany wchodzące w agregat (tooltip). */
  exchanges: FxExchangeRecord[];
}

/**
 * Skleja wymiany pary per (dzień, kierunek) — IBKR zamiata resztówki (np.
 * 0,36 EUR) osobnymi wierszami i bez agregacji 27% markerów to szum.
 * Zwraca posortowane rosnąco po dacie.
 */
export function aggregateByDay(exchanges: FxExchangeRecord[], pair: FxChartPair): FxDayAggregate[] {
  const map = new Map<string, FxDayAggregate>();
  for (const ex of exchanges) {
    if (pairOf(ex) !== pair) continue;
    const rate = exchangeRate(ex, pair);
    if (rate === null) continue;
    const date = ex.date.split('T')[0];
    const direction = directionOf(ex, pair);
    const amt = baseAmount(ex, pair);
    const key = `${date}|${direction}`;
    const agg = map.get(key);
    if (agg) {
      // Średnia ważona kwotą bazową: (a1·r1 + a2·r2)/(a1+a2)
      agg.rate = (agg.rate * agg.amountBase + rate * amt) / (agg.amountBase + amt);
      agg.amountBase += amt;
      agg.exchanges.push(ex);
    } else {
      map.set(key, { date, direction, amountBase: amt, rate, exchanges: [ex] });
    }
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Rozmiar markera skalowany kwotą: sqrt-scale w [0.6, 1.4] względem
 * największej wymiany pary — duże wymiany widać od razu, resztówki nie krzyczą.
 */
export function markerSize(amountBase: number, maxAmountBase: number): number {
  if (!(maxAmountBase > 0)) return 1;
  const t = Math.sqrt(Math.max(amountBase, 0) / maxAmountBase);
  return Math.round((0.6 + 0.8 * t) * 100) / 100;
}

/**
 * Schodkowa średnia krocząca kursu nabycia waluty bazowej — jak linia śr.
 * kosztu na wykresie instrumentu: kupno dodaje po kursie wymiany, sprzedaż
 * zdejmuje po bieżącej średniej; saldo zero → przerwa (whitespace).
 *
 * Świadome uproszczenie: liczymy WYŁĄCZNIE z wymian tej pary — wpłaty
 * walutowe i waluta z dywidend/sprzedaży nie wchodzą (to nie jest pełna
 * księga ekspozycji walutowej, tylko "po ile średnio kupowałem X za Y").
 */
export function buildAvgRateLedger(
  aggregates: FxDayAggregate[],
  sessionDates: string[],
): Array<{ time: string; value?: number }> {
  if (!sessionDates.length || !aggregates.length) return [];
  let held = 0;
  let cost = 0;
  let ai = 0;
  const out: Array<{ time: string; value?: number }> = [];
  for (const date of sessionDates) {
    while (ai < aggregates.length && aggregates[ai].date <= date) {
      const agg = aggregates[ai++];
      if (agg.direction === 'buy') {
        held += agg.amountBase;
        cost += agg.amountBase * agg.rate;
      } else if (held > 0) {
        const sold = Math.min(agg.amountBase, held);
        cost -= sold * (cost / held);
        held -= sold;
        if (held <= 1e-9) {
          held = 0;
          cost = 0;
        }
      }
    }
    if (held > 1e-9 && cost > 0) out.push({ time: date, value: cost / held });
    else out.push({ time: date });
  }
  return out;
}
