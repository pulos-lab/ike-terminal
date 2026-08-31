/**
 * Per-portfolio memo dla computePortfolioHistory.
 *
 * Problem: pojedyncze załadowanie dashboardu odpala /history, /cash-flow i
 * /metrics — każdy z nich niezależnie liczył pełną historię portfela
 * (fetch historii każdego tickera + par FX + benchmarku i iteracja po każdym
 * dniu od początku portfela) = 3 pełne przeliczenia per page load.
 *
 * Klucz cache: (portfolioId, benchmarkTicker, benchmarkSource, baseCurrency,
 * dataVersion, dzień kalendarzowy).
 *
 * - `dataVersion` (db/data-version.ts) jest bumpowana przy KAŻDYM zapisie
 *   transactions / cash_operations / ticker_map (repa DB) oraz przy zmianach
 *   splitów (routes). Dzięki temu transactions/operations/tickerMap/splits
 *   przekazywane w argumentach NIE muszą wchodzić do klucza — są re-czytane
 *   z DB per request, ale każda ich zmiana przechodzi przez zapis, który
 *   bumpuje wersję i unieważnia cache.
 * - dzień kalendarzowy w kluczu gwarantuje, że długo żyjący proces nie poda
 *   wczorajszej serii (engine liczy historię do "dzisiaj").
 * - cache trzyma Promise (nie wynik) — równoległe requesty dashboardu
 *   współdzielą jedno przeliczenie w locie; odrzucony Promise jest usuwany.
 * - pojemność: MAX_MEMO_ENTRIES wpisów LRU-ish per proces (każdy benchmark /
 *   portfel to osobny wpis). Wpisy z poprzednich dni są usuwane aktywnie
 *   (evictStaleDays) — inaczej wczorajszy balast zajmuje sloty LRU i wypycha
 *   żywe portfele przy kilku najemcach naraz.
 *
 * Memo obsługuje wyłącznie pełny zakres dat (startDate/endDate = undefined) —
 * dokładnie tak wołają je endpointy dashboardu (klient sam filtruje zakres).
 */
import type {
  Transaction,
  CashOperation,
  TickerMapEntry,
  DetectedSplit,
  AppliedSpinOff,
  OptionContract,
} from 'shared';
import { computePortfolioHistory } from './portfolio-engine.js';
import { getPortfolioDataVersion } from '../db/data-version.js';

type ComputeHistoryFn = typeof computePortfolioHistory;
type HistoryResult = Awaited<ReturnType<ComputeHistoryFn>>;

// Klucz zawiera (portfolioId × benchmark), więc 8 wpisów starczało na ~4 portfele
// przy dwóch benchmarkach — na produkcji multi-tenant memo thrashowało i każdy
// dashboard liczył od zera. 24 wpisy + sweep starych dni mieszczą kilkunastu
// aktywnych użytkowników bez istotnego kosztu pamięci.
const MAX_MEMO_ENTRIES = 24;

/**
 * Wersja logiki silnika w kluczu memo — podbij przy zmianie SPOSOBU liczenia historii
 * bez zmiany danych w DB (dataVersion tego nie wykryje, a memo in-memory przeżywa
 * hot-reload tsx watch). v2: wycena obligacji przez mnożnik nominal/100.
 * v3: transformacja spin-offów (applySpinOffs) w strumieniu transakcji.
 * v4: cash flow transakcji księgowany w paymentCurrency (fxRate brokera / kurs dzienny).
 * v5: wycena opcji przez mnożnik kontraktu (option_contracts).
 * v6: wycena dzienna pozycji krótkich (ujemne shares) — koniec zawyżania o proceeds shorta.
 * v7: kandydaci splitów o nieznanym ratio (np. 1:12 Paysafe) — korekta cen historycznych
 *     dopiero po potwierdzeniu zdarzeniem split z Yahoo; koniec skoków na wykresie.
 * v8: wycena opcji wartością wewnętrzną (intrinsic) z kursu instrumentu bazowego —
 *     koniec martwej interpolowanej premii ukrywającej zobowiązanie głęboko-ITM shortów.
 * v9: TWR odporny na wartość bliską zeru/ujemną (formuła standardowa + zamrożenie <5%
 *     szczytu, bez fałszywego Modified Dietz) + brak blipa dnia przypisania (akcje po strike
 *     nie nadpisują kursu rynkowego).
 * v10: syntetyczne wpisy dla papierów bez ticker_map (delisted) — wycena z cen
 *     transakcji zamiast twardego zera (koniec startu wykresu od −50% i skoków
 *     przy sprzedaży) + metadane unpricedInstruments.
 */
const ENGINE_VERSION = 10;

const memo = new Map<string, Promise<HistoryResult>>();

/** Wyczyść cały cache memo (testy / diagnostyka). */
export function clearHistoryMemo(): void {
  memo.clear();
}

/** Liczba wpisów w memo — do diagnostyki adminowej. */
export function getHistoryMemoSize(): number {
  return memo.size;
}

/**
 * Usuń wpisy z innego dnia kalendarzowego niż `today`.
 *
 * Dzień jest ostatnim segmentem klucza, więc wpisy z wczoraj są jednoznacznie
 * rozpoznawalne. Są bezużyteczne (nikt ich już nie odczyta — klucz nowego
 * requestu zawiera dzisiejszą datę), a zajmują sloty LRU: bez tego sweepu
 * podniesienie MAX_MEMO_ENTRIES tylko przedłuża życie balastu.
 */
function evictStaleDays(today: string): void {
  for (const key of memo.keys()) {
    if (!key.endsWith(`|${today}`)) memo.delete(key);
  }
}

/**
 * Zmemoizowany wrapper na computePortfolioHistory (pełny zakres dat).
 *
 * `computeFn` jest wstrzykiwalne wyłącznie dla testów (licznik wywołań) —
 * produkcyjne call sites nie przekazują tego parametru.
 */
export function computePortfolioHistoryMemoized(
  portfolioId: string,
  transactions: Transaction[],
  operations: CashOperation[],
  tickerMap: Map<string, TickerMapEntry>,
  benchmarkTicker: string,
  benchmarkSource: 'yahoo' | 'stooq' | 'none',
  splits: DetectedSplit[] = [],
  baseCurrency: string = 'PLN',
  computeFn: ComputeHistoryFn = computePortfolioHistory,
  // Spin-offy nie wchodzą do klucza memo z tego samego powodu co splits:
  // każda ich mutacja przechodzi przez applier/routes, które bumpują dataVersion.
  spinOffs: AppliedSpinOff[] = [],
  // Kontrakty opcyjne też nie wchodzą do klucza: zapis następuje wyłącznie w imporcie
  // i ręcznym dodaniu transakcji, które bumpują dataVersion.
  optionContracts?: Map<string, OptionContract>,
): Promise<HistoryResult> {
  const today = new Date().toISOString().split('T')[0];
  const key = [
    `v${ENGINE_VERSION}`,
    portfolioId,
    benchmarkTicker,
    benchmarkSource,
    baseCurrency.toUpperCase(),
    getPortfolioDataVersion(portfolioId),
    today,
  ].join('|');

  const cached = memo.get(key);
  if (cached) {
    // LRU touch — delete + set przenosi wpis na koniec iteracji Mapy
    memo.delete(key);
    memo.set(key, cached);
    return cached;
  }

  const promise = computeFn(
    transactions,
    operations,
    tickerMap,
    benchmarkTicker,
    benchmarkSource,
    undefined,
    undefined,
    splits,
    baseCurrency,
    spinOffs,
    optionContracts,
  ).catch((err) => {
    // Nie cache'ujemy błędów — kolejny request spróbuje od nowa
    memo.delete(key);
    throw err;
  });

  memo.set(key, promise);

  // Najpierw balast z poprzednich dni, dopiero potem LRU — inaczej wczorajsze
  // wpisy wypychałyby świeże serie innych portfeli.
  evictStaleDays(today);

  // Eviction najstarszych wpisów (pierwsze klucze w iteracji Mapy)
  while (memo.size > MAX_MEMO_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }

  return promise;
}
