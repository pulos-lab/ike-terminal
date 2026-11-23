import { BENCHMARKS, type BenchmarkDayChange, type BenchmarkKey } from 'shared';
import { fetchYahooPrice } from './yahoo-finance.js';
import type { CachedLiveQuote } from './yahoo-quotes.js';

/**
 * Indeks giełdowy nie rusza się o kilkadziesiąt procent w jedną sesję. Taki
 * wynik oznacza nieświeże „poprzednie zamknięcie" w źródle, nie rynek — wtedy
 * milczymy, zamiast pokazać liczbę obok wyniku portfela.
 */
const MAX_PLAUSIBLE_INDEX_MOVE_PCT = 25;

type Quote = Pick<CachedLiveQuote, 'price' | 'previousClose' | 'quoteTime'>;

export function isBenchmarkKey(value: unknown): value is BenchmarkKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BENCHMARKS, value);
}

/**
 * Dzienna zmiana indeksu z notowania live. `asOf` jest OBOWIĄZKOWE dla wyniku:
 * klient porównuje dzień notowania z dniem sesji portfela i bez znacznika czasu
 * nie umiałby odróżnić dzisiejszego ruchu S&P od wczorajszego (rano, przed
 * otwarciem w USA, źródło wciąż zwraca poprzednią sesję).
 */
export function benchmarkDayChangeFromQuote(
  benchmark: BenchmarkKey,
  quote: Quote | null,
): BenchmarkDayChange {
  const empty: BenchmarkDayChange = { benchmark, changePct: null, asOf: null };
  if (!quote) return empty;
  const { price, previousClose, quoteTime } = quote;
  if (!Number.isFinite(price) || previousClose == null || !(previousClose > 0)) return empty;
  if (quoteTime == null || !Number.isFinite(quoteTime)) return empty;

  const changePct = (price / previousClose - 1) * 100;
  if (Math.abs(changePct) > MAX_PLAUSIBLE_INDEX_MOVE_PCT) return empty;
  return { benchmark, changePct, asOf: new Date(quoteTime).toISOString() };
}

/**
 * Dzisiejsza zmiana benchmarku wybranego na dashboardzie. Historia benchmarku
 * (wykres) do tego się nie nadaje: jej ostatni punkt bywa kopią poprzedniej
 * sesji, dopóki nie spłynie dzisiejsze zamknięcie. Awaria źródła = `null`,
 * nigdy błąd — to dopisek przy wyniku dnia, nie warunek jego pokazania.
 */
export async function getBenchmarkDayChange(
  benchmark: BenchmarkKey,
  fetchQuote: (ticker: string) => Promise<Quote | null> = fetchYahooPrice,
): Promise<BenchmarkDayChange> {
  const def = BENCHMARKS[benchmark];
  if (!('yahooTicker' in def)) return { benchmark, changePct: null, asOf: null };
  const quote = await fetchQuote(def.yahooTicker).catch(() => null);
  return benchmarkDayChangeFromQuote(benchmark, quote);
}
