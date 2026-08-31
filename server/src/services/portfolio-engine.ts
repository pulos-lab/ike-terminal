import type {
  Transaction,
  CashOperation,
  Position,
  ClosedTrade,
  ClosedTradeFee,
  TickerMapEntry,
  PortfolioHistoryPoint,
  PortfolioMetrics,
  DividendRecord,
  FxExchangeRecord,
  CashFlowRecord,
  DetectedSplit,
  AppliedSpinOff,
  FxImpact,
  FxImpactCurrencyEntry,
  ImpliedFxFlow,
} from 'shared';
import {
  fetchYahooPrice,
  fetchFxRate,
  fetchYahooHistory,
  fetchYahooHistoryDirect,
  fetchYahooSplitEvents,
} from './yahoo-finance.js';
import { primeYahooQuotes } from './yahoo-quotes.js';
import { getLiveQuoteStore } from './live-quote-store.js';
import { fetchStooqPrice, fetchStooqHistory, fetchStooqPreviousClose } from './stooq.js';
import { fetchBiznesradarPrice, fetchBiznesradarHistory } from './biznesradar.js';
import { fetchStockwatchBondPrice } from './stockwatch-bonds.js';
import {
  detectSplits,
  detectSplitsFromPriceSeries,
  normalizeUnadjustedProviderSeries,
  adjustTransactionsForSplits,
  detectSplitFromQuantityMismatch,
  isPlausibleSplitRatio,
  snapToKnownRatio,
} from './split-detector.js';
import {
  applySpinOffs,
  filterDetectedSplitsForSpinOffs,
  type SpinOffGuardEvent,
} from './spin-off-transform.js';
import { expireOptions, resolveOptionExpirySettlements } from './option-expiry-transform.js';
import { getDb } from '../db/connection.js';
import {
  BENCHMARKS,
  DEFAULT_FX_PLN,
  findBondByTicker,
  inferBondNominal,
  SPIN_OFF_MAP,
  parseOccTicker,
  optionIntrinsicValue,
} from 'shared';
import type {
  InstrumentCategory,
  OptionContract,
  ParsedOptionSymbol,
  UnpricedInstrument,
} from 'shared';

// ============ Bond Helpers ============

/**
 * Mnożnik przeliczający kurs obligacji (w % wartości nominalnej — tak kwotuje
 * Catalyst, Bossa i Stooq) na wartość w walucie: `wartość = qty × kurs × nominal/100`.
 * Dla nie-obligacji zwraca 1 (kursy akcji/ETF są już w walucie).
 *
 * Nominał: bond-map (po tickerze serii) → inferencja z pierwszej transakcji K
 * (`value ≈ qty × kurs% × nominal`) → fallback 1000 zł (standard skarbowych/BGK).
 */
function bondPriceMultiplier(
  category: InstrumentCategory | undefined,
  ticker: string | undefined,
  txs: Transaction[],
): number {
  if (category !== 'bond') return 1;
  let nominal = ticker ? findBondByTicker(ticker)?.nominal : undefined;
  if (!nominal) {
    const firstBuy = txs.find((t) => t.side === 'K');
    nominal =
      (firstBuy ? inferBondNominal(firstBuy.quantity, firstBuy.price, firstBuy.value) : null) ??
      1000;
  }
  return nominal / 100;
}

/**
 * Mnożnik ceny instrumentu: przelicza kurs notowania na wartość pozycji
 * (`wartość = qty × kurs × mnożnik`). Obligacje: nominal/100 (kurs w % nominału).
 * Opcje: mnożnik kontraktu z `option_contracts` (premia kwotowana per akcja,
 * standard US equity options = 100). Pozostałe: 1.
 */
function instrumentPriceMultiplier(
  category: InstrumentCategory | undefined,
  ticker: string | undefined,
  txs: Transaction[],
  isin?: string,
  optionContracts?: Map<string, OptionContract>,
): number {
  if (category === 'option') {
    return (isin ? optionContracts?.get(isin)?.multiplier : undefined) ?? 100;
  }
  return bondPriceMultiplier(category, ticker, txs);
}

// ============ Split Helpers ============

/**
 * Merge saved splits with newly detected ones.
 * Zapisane splity (z realnymi datami) mają pierwszeństwo: dla ISIN-u, który ma
 * już JAKIKOLWIEK zapisany split, świeżo wykryte heurystyczne splity są
 * odrzucane (inaczej heurystyczny duplikat z inną datą podwójnie korygowałby
 * transakcje). ISIN może mieć wiele splitów o różnych datach.
 */
function mergeDetectedSplits(saved: DetectedSplit[], detected: DetectedSplit[]): DetectedSplit[] {
  const savedIsins = new Set(saved.map((s) => s.isin));
  const seen = new Set(saved.map((s) => `${s.isin}|${s.date}`));
  const merged = [...saved];
  for (const s of detected) {
    if (savedIsins.has(s.isin)) continue;
    const key = `${s.isin}|${s.date}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(s);
    }
  }
  return merged;
}

/** Dodaje N dni do daty YYYY-MM-DD (UTC, bez przesunięć strefowych). */
function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Nadaje heurystycznie wykrytym splitom REALNE daty z Yahoo (events: 'split').
 *
 * Heurystyka cenowa zna tylko ratio i dolne ograniczenie daty (datę transakcji,
 * po której split na pewno zaszedł). Bez realnej daty nie da się poprawnie
 * skorygować portfela z zakupami przed I po splicie — reguła strict '>' w
 * adjustTransactionsForSplits wymaga faktycznego ex-date.
 *
 * Eventy są akceptowane tylko, gdy iloczyn ich ratio zgadza się (±5%) z
 * heurystycznym ratio. Fallback (brak eventów — np. NewConnect/Stooq):
 * data heurystyczna +1 dzień, żeby transakcja-marker z dnia obserwacji
 * też została skorygowana.
 */
export async function resolveSplitEventDates(
  detected: DetectedSplit[],
  tickerMap: Map<string, TickerMapEntry>,
): Promise<DetectedSplit[]> {
  if (detected.length === 0) return detected;

  const byTicker = new Map<string, DetectedSplit[]>();
  for (const s of detected) {
    const arr = byTicker.get(s.ticker) || [];
    arr.push(s);
    byTicker.set(s.ticker, arr);
  }

  const resolved: DetectedSplit[] = [];
  await Promise.all(
    [...byTicker.entries()].map(async ([ticker, splits]) => {
      const sorted = [...splits].sort((a, b) => a.date.localeCompare(b.date));
      const heuristicProduct = sorted.reduce((acc, s) => acc * s.ratio, 1);
      const entry = tickerMap.get(sorted[0].isin);

      let events: Array<{ date: string; ratio: number }> = [];
      if (entry?.exchange !== 'NC') {
        events = await fetchYahooSplitEvents(ticker, sorted[0].date);
      }

      const eventsProduct = events.reduce((acc, e) => acc * e.ratio, 1);
      const pushYahooEvents = () => {
        for (const e of events) {
          resolved.push({
            ticker,
            isin: sorted[0].isin,
            date: e.date,
            ratio: e.ratio,
            txPrice: sorted[0].txPrice,
            providerPrice: sorted[0].providerPrice,
            source: 'auto',
          });
        }
      };

      // Yahoo jest AUTORYTATYWNE dla dat i ratio splitów. Heurystyka (detectSplits)
      // służy tylko do zdecydowania CZY odpytać Yahoo — jej ratio bywają zaszumione
      // (cena wykonania ≠ kurs zamknięcia) i potrafi zgłosić kilka detekcji na JEDEN
      // realny split (po jednej na każdą transakcję sprzed splitu), co zawyża iloczyn.
      // Dlatego gdy Yahoo zwraca zdarzenia zgodne KIERUNKOWO (reverse vs forward)
      // i MAGNITUDOWO z detekcją, bierzemy dokładne daty+ratio z Yahoo i porzucamy
      // (potencjalnie zdublowaną) heurystykę. Domyka klasę LCID 1:10 / EDU / PSFE 1:12.
      if (events.length > 0) {
        const sameDirection = eventsProduct < 1 === heuristicProduct < 1;
        // Dopasowanie magnitudowe: albo iloczyn Yahoo ≈ iloczyn heurystyk (czysta
        // detekcja lub realny multi-split), albo któraś pojedyncza detekcja ≈ iloczyn
        // Yahoo (nadmiarowe zdublowanie jednego splitu). Tolerancja ±25%.
        const tol = Math.log(1.25);
        const productMatch = Math.abs(Math.log(eventsProduct / heuristicProduct)) < tol;
        const closest = sorted
          .map((s) => s.ratio)
          .reduce((best, r) =>
            Math.abs(Math.log(r / eventsProduct)) < Math.abs(Math.log(best / eventsProduct))
              ? r
              : best,
          );
        const singleMatch = Math.abs(Math.log(closest / eventsProduct)) < tol;
        if (sameDirection && (productMatch || singleMatch)) {
          pushYahooEvents();
          return;
        }
      }

      // Yahoo nie potwierdza detekcji. Kandydat o nieznanym ratio (needsConfirmation)
      // mógł być tylko gwałtownym ruchem kursu — odrzucamy w całości (bez tego historyczne
      // pozycje wyceniałyby się w złej skali, np. skok na wykresie). Split o znanym ratio
      // ufamy heurystyce z datą tx+1 (Yahoo bywa niekompletne dla starszych / mniej
      // płynnych spółek), zachowując dotychczasowe zachowanie.
      if (sorted.some((s) => s.needsConfirmation)) return;

      for (const s of sorted) {
        resolved.push({ ...s, date: addDaysIso(s.date, 1) });
      }
    }),
  );
  return resolved;
}

/**
 * Proaktywnie pobiera zdarzenia split z Yahoo dla spółek, których WSZYSTKIE transakcje
 * wypadają PRZED początkiem dostępnej historii cen providera — i zwraca je jako DetectedSplit.
 *
 * Detekcja cenowa (detectSplits) porównuje cenę transakcji z ceną providera W DNIU
 * TRANSAKCJI. Gdy najwcześniejsza cena providera jest późniejsza niż wszystkie zakupy
 * (Yahoo oddaje ~5 lat historii — starsze transakcje są poza oknem), split nigdy nie
 * zostaje wykryty, a Yahoo podaje ceny SKORYGOWANE o (późniejszy) reverse-split. Efekt:
 * pozycja wyceniana N-krotnie za wysoko od momentu pojawienia się notowań i skok wyceny na
 * granicy okna (realny przypadek: import DEGIRO — Churchill/Lucid 1:10, Virgin Galactic 1:20;
 * transakcje z 2020–2021 sprzed startu serii LCID/SPCE, które zaczynają się w VII 2021).
 *
 * Zapytania ograniczamy DOKŁADNIE do tego przypadku (pierwsza transakcja < pierwsza cena
 * providera), więc portfele „w oknie" nie generują ani jednego dodatkowego strzału do
 * Yahoo — obsługuje je jak dotąd heurystyka. Ratio+datę bierzemy wprost z Yahoo
 * (autorytatywne); ratio spoza skali splitu (np. 1,05 = dywidenda akcyjna) odrzucamy.
 */
export async function fetchSplitsForHeldTickers(
  transactions: Transaction[],
  tickerMap: Map<string, TickerMapEntry>,
  historicalPrices: Map<string, Map<string, number>>,
  opts: {
    skipIsins?: Set<string>;
    skipTickers?: Set<string>;
    fetchEvents?: (
      ticker: string,
      startDate: string,
    ) => Promise<Array<{ date: string; ratio: number }>>;
  } = {},
): Promise<DetectedSplit[]> {
  const fetchEvents = opts.fetchEvents ?? ((t, s) => fetchYahooSplitEvents(t, s));

  // Najwcześniejsza transakcja per ISIN — dolne ograniczenie okna pobierania eventów.
  const firstTx = new Map<string, { date: string; price: number }>();
  for (const tx of [...transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    if (tx.category === 'bond' || tx.category === 'option') continue;
    if (!firstTx.has(tx.isin)) {
      firstTx.set(tx.isin, { date: tx.date.split('T')[0], price: tx.price });
    }
  }

  const results: DetectedSplit[] = [];
  await Promise.all(
    [...firstTx.entries()].map(async ([isin, first]) => {
      if (opts.skipIsins?.has(isin)) return;
      const entry = tickerMap.get(isin);
      if (!entry) return;
      // NewConnect / Catalyst nie są notowane na Yahoo — brak eventów.
      if (entry.exchange === 'NC' || entry.exchange === 'CATALYST') return;
      if (opts.skipTickers?.has(entry.ticker)) return;

      // Brak historii providera w ogóle = brak zawyżonej ceny (pozycja forward-fill
      // po cenie tx) → pomijamy.
      const priceMap = historicalPrices.get(entry.ticker);
      if (!priceMap || priceMap.size === 0) return;
      let firstProviderDate: string | undefined;
      for (const d of priceMap.keys()) {
        if (firstProviderDate === undefined || d < firstProviderDate) firstProviderDate = d;
      }
      if (firstProviderDate === undefined) return;

      // UWAGA: nie ograniczamy się już do pozycji sprzed okna historii providera.
      // Pierwotnie stał tu warunek `first.date >= firstProviderDate → return`, oparty
      // na założeniu „skoro provider ma cenę na dacie zakupu, detekcja cenowa i tak
      // zadziała". To założenie jest FAŁSZYWE dla papierów zmiennych: detekcja
      // porównuje cenę transakcji z kursem ZAMKNIĘCIA, a przy tolerancji 5% wystarczy
      // kupno śróddzienne odbiegające od zamknięcia, żeby nic nie wykryła.
      //
      // Konkret (zgłoszenie 2026-07-20, EZRA): kupno 0,2719 przy zamknięciu 0,252
      // (skorygowane 10,08) daje rawRatio 0,02697 — 7,9% od 1/40, czyli poza
      // tolerancją. Heurystyka milczała, więc `resolveSplitEventDates` w ogóle nie
      // pytało Yahoo i realny reverse split 1:40 nigdy nie był stosowany.
      //
      // Yahoo jest autorytatywne dla splitów, a `fetchYahooSplitEvents` cache'uje
      // wynik na 12h, więc pytamy o każdy trzymany papier. Podwójne naliczenie jest
      // wykluczone: `skipTickers` wycina papiery złapane już heurystyką, `skipIsins`
      // te z zapisanymi splitami, a `adjustTransactionsForSplits` koryguje wyłącznie
      // transakcje sprzed daty splitu.

      const events = await fetchEvents(entry.ticker, first.date);
      for (const e of events) {
        // Ufamy Yahoo, ale ratio spoza skali splitu (np. 1,05 = dywidenda akcyjna / drobna
        // korekta) NIE może przeskalowywać ilości pozycji.
        if (!isPlausibleSplitRatio(e.ratio)) continue;
        results.push({
          ticker: entry.ticker,
          isin,
          date: e.date,
          ratio: e.ratio,
          txPrice: first.price > 0 ? first.price : 0,
          providerPrice: priceMap.get(firstProviderDate) ?? 0,
          source: 'auto',
        });
      }
    }),
  );
  return results;
}

/**
 * Lightweight split detection for open positions.
 *
 * Fetches one fresh historical price per ISIN directly from Yahoo (bypassing
 * the persistent cache), because after a split Yahoo retroactively adjusts all
 * historical prices but our cache still holds old pre-split values.
 *
 * Skips ISINs that already have saved splits.
 */
async function detectSplitsFromTransactions(
  transactions: Transaction[],
  tickerMap: Map<string, TickerMapEntry>,
  existingSplits: DetectedSplit[],
): Promise<DetectedSplit[]> {
  const detected: DetectedSplit[] = [];

  // ISINs that already have splits don't need re-detection
  const isinsWithSplits = new Set(existingSplits.map((s) => s.isin));

  // Skip closed positions (net quantity = 0) — both buy and sell used the same
  // price scale, so "correcting" them creates false positives (e.g. AVGO bought
  // and sold post-split, but Yahoo retroactively adjusts historical prices).
  const netQty = new Map<string, number>();
  for (const tx of transactions) {
    const qty = netQty.get(tx.isin) ?? 0;
    netQty.set(tx.isin, qty + (tx.side === 'K' ? tx.quantity : -tx.quantity));
  }

  // Find earliest transaction per ISIN (same currency only, open positions only)
  const earliestTx = new Map<string, Transaction>();
  for (const tx of transactions) {
    const entry = tickerMap.get(tx.isin);
    if (!entry || tx.currency !== entry.currency) continue;
    if (isinsWithSplits.has(tx.isin)) continue;
    // Obligacje nie mają splitów; Yahoo nie zna Catalyst (fetch zwróciłby null,
    // ale jawny guard oszczędza requesty i wyklucza fałszywe wykrycia).
    if (tx.category === 'bond') continue;
    // Only detect splits for open positions
    const net = netQty.get(tx.isin) ?? 0;
    if (net <= 0) continue;
    const existing = earliestTx.get(tx.isin);
    if (!existing || tx.date < existing.date) {
      earliestTx.set(tx.isin, tx);
    }
  }

  // Fetch one fresh price per ISIN in parallel, bypassing cache
  const checks = [...earliestTx.entries()].map(async ([isin, tx]) => {
    const entry = tickerMap.get(isin);
    if (!entry) return;
    const dateKey = tx.date.split('T')[0];
    try {
      // Use cache-bypassing fetch — critical for split detection because
      // persistent cache holds pre-split prices until manually invalidated
      let freshPrice: number | null = null;
      if (entry.exchange !== 'NC') {
        freshPrice = await fetchYahooHistoryDirect(entry.ticker, dateKey);
      } else {
        // NC: Stooq doesn't cache the same way, less of an issue
        const data = await fetchStooqHistory(entry.ticker, dateKey);
        const match = data.find((d) => d.date === dateKey);
        freshPrice = match?.close ?? null;
      }

      if (!freshPrice || freshPrice <= 0) return;

      const rawRatio = tx.price / freshPrice;
      if (isPlausibleSplitRatio(rawRatio)) {
        detected.push({
          ticker: entry.ticker,
          isin,
          // Data transakcji = dolne ograniczenie; realny ex-date nadaje
          // resolveSplitEventDates poniżej (Yahoo split events). Data "dzisiaj"
          // korygowałaby też zakupy zrobione już PO splicie (10× zawyżenie).
          date: dateKey,
          ratio: snapToKnownRatio(rawRatio),
          txPrice: tx.price,
          providerPrice: freshPrice,
          source: 'auto',
        });
      }
    } catch {
      // Silently skip — detection will happen on dashboard visit
    }
  });

  await Promise.all(checks);
  return resolveSplitEventDates(detected, tickerMap);
}

// ============ Position Metrics (FIFO) ============

interface BuyLot {
  quantity: number;
  price: number; // price per share in transaction currency
  commission: number;
  date: string;
  currency: string; // transaction currency
}

interface PositionMetrics {
  shares: number;
  avgBuyPrice: number; // in transaction currency
  totalCommission: number;
  buyLots: BuyLot[];
  /** Otwarte loty krótkie (sprzedaż bez pokrycia — wystawione opcje). */
  shortLots: BuyLot[];
  /** Suma ilości w otwartych lotach krótkich (dodatnia). Pozycja netto-short: shares≈0, shortShares>0. */
  shortShares: number;
  buyCurrency: string;
  /** Total cost basis in PLN (for cross-currency P/L) */
  costBasisPln: number;
}

export function computePositionMetrics(transactions: Transaction[]): PositionMetrics {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const buyLots: BuyLot[] = [];
  const shortLots: BuyLot[] = []; // tracks open short positions
  let totalCommission = 0;

  for (const tx of sorted) {
    totalCommission += tx.commission;
    if (tx.side === 'K') {
      // If there are open short positions, this buy covers the short (FIFO)
      if (shortLots.length > 0) {
        let remaining = tx.quantity;
        while (remaining > 0 && shortLots.length > 0) {
          if (shortLots[0].quantity <= remaining) {
            remaining -= shortLots[0].quantity;
            shortLots.shift();
          } else {
            shortLots[0].quantity -= remaining;
            remaining = 0;
          }
        }
        // Any leftover after covering shorts becomes a regular buy lot
        if (remaining > 0) {
          buyLots.push({
            quantity: remaining,
            price: tx.price,
            commission: tx.commission * (remaining / tx.quantity),
            date: tx.date,
            currency: tx.currency,
          });
        }
      } else {
        buyLots.push({
          quantity: tx.quantity,
          price: tx.price,
          commission: tx.commission,
          date: tx.date,
          currency: tx.currency,
        });
      }
    } else {
      // FIFO sell — consume buy lots first
      let remaining = tx.quantity;
      while (remaining > 0 && buyLots.length > 0) {
        if (buyLots[0].quantity <= remaining) {
          remaining -= buyLots[0].quantity;
          buyLots.shift();
        } else {
          buyLots[0].quantity -= remaining;
          remaining = 0;
        }
      }
      // Any remaining sell quantity with no buy lots = short sell
      if (remaining > 0) {
        shortLots.push({
          quantity: remaining,
          price: tx.price,
          commission: tx.commission * (remaining / tx.quantity),
          date: tx.date,
          currency: tx.currency,
        });
      }
    }
  }

  const shares = buyLots.reduce((sum, lot) => sum + lot.quantity, 0);
  const shortShares = shortLots.reduce((sum, lot) => sum + lot.quantity, 0);
  const totalCost = buyLots.reduce((sum, lot) => sum + lot.quantity * lot.price, 0);
  const avgBuyPrice = shares > 0 ? totalCost / shares : 0;
  const buyCurrency = buyLots.length > 0 ? buyLots[0].currency : 'PLN';
  // costBasisPln: total cost in the transaction currency (which is PLN for PLN buys,
  // or needs FX conversion for USD/CAD buys — handled in computeOpenPositions)
  const costBasisPln = totalCost;

  return {
    shares,
    shortShares,
    avgBuyPrice,
    totalCommission,
    buyLots,
    shortLots,
    buyCurrency,
    costBasisPln,
  };
}

// ============ Open Positions ============

/**
 * Symbole do zbiorczego pobrania cen live (Yahoo v7) przed pętlą wyceny.
 *
 * Świadome wykluczenia:
 *  - NC i CATALYST — Yahoo ich nie kwotuje (biznesradar / stockwatch); wysłanie
 *    ich do batcha to tylko śmieci w odpowiedzi i szum w `missed`;
 *  - ISIN-y z zerową pozycją netto — pętla i tak je pomija, a przy długiej
 *    historii byłyby to setki zbędnych symboli.
 *
 * Instrumenty bazowe opcji dokładamy, bo przy braku notowania samej opcji
 * (typowe dla Eurexu) wycena schodzi na wartość wewnętrzną z kursu bazowego.
 * Netto-pozycja liczona jest tu zgrubnie (suma K−S), nie przez FIFO — to tylko
 * heurystyka doboru symboli: nadmiar nic nie kosztuje (ten sam request),
 * niedomiar spada na starą ścieżkę per-ticker.
 */
export function collectYahooLiveSymbols(
  byIsin: Map<string, Transaction[]>,
  tickerMap: Map<string, TickerMapEntry>,
  optionContracts?: Map<string, OptionContract>,
): string[] {
  const symbols = new Set<string>();
  for (const [isin, txs] of byIsin) {
    const net = txs.reduce((sum, tx) => sum + (tx.side === 'K' ? tx.quantity : -tx.quantity), 0);
    if (Math.abs(net) < EPSILON) continue;

    const entry = tickerMap.get(isin);
    if (!entry?.ticker) continue;
    if (entry.exchange === 'NC' || entry.exchange === 'CATALYST') continue;
    symbols.add(entry.ticker);

    if (txs[0]?.category === 'option') {
      const underlying =
        optionContracts?.get(isin)?.underlying ?? parseOccTicker(entry.ticker)?.underlying;
      if (underlying) symbols.add(underlying);
    }
  }
  return [...symbols];
}

export async function computeOpenPositions(
  transactions: Transaction[],
  tickerMap: Map<string, TickerMapEntry>,
  splits: DetectedSplit[] = [],
  fxRatesOverride?: Record<string, number>,
  opts?: {
    /**
     * Pomija sieciową (cache-bypass) detekcję splitów po cenach. Ustawiane przez
     * endpointy, które i tak nie persystują wykryć (/metrics, /dividends/upcoming)
     * oraz przez /positions poza dobowym oknem skanu — bez tego każdy request
     * dashboardu odpalał ~1 niecache'owany strzał do Yahoo per otwarta pozycja.
     */
    skipSplitDetection?: boolean;
    /** Metadane kontraktów opcyjnych (mnożnik, expiry) — z getOptionContractsMap(pid). */
    optionContracts?: Map<string, OptionContract>;
    /**
     * Ceny rozliczenia (intrinsic) opcji po terminie — z resolveOptionExpirySettlements.
     * Gdy pominięte, funkcja rozwiązuje je sama (są cache'owane). Wstrzykiwane przez callery,
     * które i tak liczą je raz dla wielu obliczeń (spójnie z computeClosedTrades).
     */
    optionSettlementPrices?: Map<string, number>;
    /**
     * Dzień odniesienia (YYYY-MM-DD) dla wygaśnięcia opcji (expiryPassed + auto-domknięcie).
     * Domyślnie „dziś". Golden/testy point-in-time podają datę wyciągu, żeby odtworzyć jego
     * sekcję Open Positions deterministycznie.
     */
    asOf?: string;
  },
  spinOffs: AppliedSpinOff[] = [],
): Promise<{ positions: Position[]; totalValuePln: number; detectedSplits: DetectedSplit[] }> {
  // Guard C: znane spin-offy odrzucają detekcje splitów będące ich artefaktem
  // (spadek kursu rodzica po ex wygląda jak reverse split; sprzedaż dziecka bez
  // syntetycznego zakupu w surowym strumieniu wygląda jak mismatch ilości).
  const spinOffGuard: SpinOffGuardEvent[] = [...spinOffs, ...SPIN_OFF_MAP];

  // Lightweight split detection: for each ISIN, fetch the provider price on the
  // earliest transaction date and compare. This catches splits even if the user
  // hasn't visited the dashboard yet (which runs the full history-based detection).
  const priceSplits = filterDetectedSplitsForSpinOffs(
    opts?.skipSplitDetection
      ? []
      : await detectSplitsFromTransactions(transactions, tickerMap, splits),
    spinOffGuard,
    'price',
  );

  // Additional detection: sell quantity exceeding accumulated buys
  const qtySplits = filterDetectedSplitsForSpinOffs(
    detectSplitFromQuantityMismatch(transactions),
    spinOffGuard,
    'quantity',
  );
  const qtySplitsAsDetected: DetectedSplit[] = qtySplits
    .filter((qs) => !splits.some((s) => s.isin === qs.isin)) // skip already known
    .map((qs) => {
      const entry = tickerMap.get(qs.isin);
      return {
        ticker: entry?.ticker ?? qs.isin,
        isin: qs.isin,
        date: qs.date,
        ratio: qs.ratio,
        txPrice: 0,
        providerPrice: 0,
        source: 'auto' as const,
      };
    });

  const allSplits = mergeDetectedSplits(splits, [...priceSplits, ...qtySplitsAsDetected]);

  // Adjust transactions for stock splits (quantity/price correction),
  // then apply spin-offs (child injection + parent basis reduction)
  const adjustedTxs = applySpinOffs(
    adjustTransactionsForSplits(transactions, allSplits),
    spinOffs,
    allSplits,
  );

  // Auto-domknięcie opcji po terminie (bez wiersza zamykającego z brokera) — syntetyczne
  // zamknięcie po wartości wewnętrznej w dniu wygaśnięcia, żeby nie wisiały jako otwarte.
  const optionContracts = opts?.optionContracts;
  const today = opts?.asOf ?? new Date().toISOString().slice(0, 10);
  let expiredTxs = adjustedTxs;
  if (optionContracts) {
    const settlementPrices =
      opts?.optionSettlementPrices ??
      (await resolveOptionExpirySettlements(adjustedTxs, optionContracts, today));
    expiredTxs = expireOptions(adjustedTxs, optionContracts, today, settlementPrices);
  }

  // Group by ISIN
  const byIsin = new Map<string, Transaction[]>();
  for (const tx of expiredTxs) {
    const arr = byIsin.get(tx.isin) || [];
    arr.push(tx);
    byIsin.set(tx.isin, arr);
  }

  // Get FX rates — collect all currencies from ticker map and transactions
  const liveCurrencies = new Set<string>();
  // (zbierane niżej; prime cen live czeka na komplet walut, patrz primeYahooQuotes)
  for (const entry of tickerMap.values()) {
    if (entry.currency) {
      const u = entry.currency.toUpperCase();
      liveCurrencies.add(u === 'GBX' || u === 'GBP' ? 'GBP' : u);
    }
  }
  for (const tx of transactions) {
    const u = tx.currency.toUpperCase();
    liveCurrencies.add(u === 'GBX' ? 'GBP' : u);
  }
  liveCurrencies.delete('PLN');

  // ── Prime cen live jednym batchem (Yahoo v7) ──────────────────────────────
  // Pętla wyceny poniżej jest sekwencyjna, więc na zimnym cache robiła N
  // szeregowych round-tripów do Yahoo. Jedno żądanie zbiorcze wypełnia ten sam
  // klucz cache'u, z którego czyta fetchYahooPrice — pętla trafia w cache i nie
  // rusza sieci. Symbole nieobsłużone przez batch spadają na starą ścieżkę v8
  // automatycznie (miss w cache), więc tutaj nie trzeba nic z nimi robić.
  //
  // Pary walutowe dokładamy do TEGO SAMEGO żądania (i tylko wtedy, gdy caller
  // nie wstrzyknął gotowych kursów) — inaczej fetchFxRate poniżej zrobiłby
  // osobny strzał po każdą walutę.
  await primeYahooQuotes([
    ...collectYahooLiveSymbols(byIsin, tickerMap, opts?.optionContracts),
    ...(fxRatesOverride ? [] : [...liveCurrencies].map((cur) => `${cur}PLN=X`)),
  ]);

  const fxRates: Record<string, number> = { PLN: 1 };
  const defaultFx = DEFAULT_FX_PLN;
  if (fxRatesOverride) {
    // Caller (np. /metrics endpoint) pre-fetchuje FX raz dla wszystkich obliczeń
    // (positions + cash + fxImpact), żeby zapewnić spójność wartości na ekranie.
    for (const cur of liveCurrencies) {
      fxRates[cur] = fxRatesOverride[cur] ?? defaultFx[cur] ?? 1;
    }
    if ('GBP' in fxRates) fxRates['GBp'] = fxRates['GBP'];
  } else {
    await Promise.all(
      [...liveCurrencies].map(async (cur) => {
        const rate = await fetchFxRate(`${cur}PLN`);
        fxRates[cur] = rate || defaultFx[cur] || 1;
        // Also store GBp → GBP alias so ticker map entries with 'GBp' currency work
        if (cur === 'GBP') fxRates['GBp'] = fxRates[cur];
      }),
    );
  }

  const positions: Position[] = [];
  let totalValuePln = 0;

  for (const [isin, txs] of byIsin) {
    const metrics = computePositionMetrics(txs);
    // Pozycja netto-short (wystawione opcje: sprzedaż bez pokrycia, jeszcze nie odkupione/
    // wygasłe): shares≈0, shortShares>0. Prezentujemy ją z ujemną ilością i ujemną wartością
    // (zobowiązanie odkupu); kosztem bazowym jest otrzymana premia (ujemny costBasis).
    const isShort = metrics.shares < EPSILON && metrics.shortShares > EPSILON;
    if (metrics.shares < EPSILON && !isShort) continue;
    const effLots = isShort ? metrics.shortLots : metrics.buyLots;
    const effShares = isShort ? -metrics.shortShares : metrics.shares;
    const optionContract =
      txs[0]?.category === 'option' ? opts?.optionContracts?.get(isin) : undefined;

    const entry = tickerMap.get(isin);
    if (!entry) {
      // No ticker_map entry — use transaction data as fallback
      const lastTx = [...txs].sort((a, b) => b.date.localeCompare(a.date))[0];
      if (!lastTx) continue;
      // Create a synthetic entry from transaction data
      const fallbackEntry = {
        name: lastTx.paperName,
        ticker: lastTx.paperName,
        exchange: 'OTHER' as const,
        currency: lastTx.currency || 'PLN',
        priceSource: 'stooq' as const,
        sector: undefined,
      };
      // Use last transaction price as current price
      const fallbackPrice = lastTx.price;
      const fxKey = fallbackEntry.currency.toUpperCase();
      const fxNativeToPln = fxRates[fxKey] || 1;
      const category = txs[0]?.category || 'stock';
      // Obligacje: kurs w % nominału — wartości w walucie przez mnożnik nominal/100;
      // opcje: mnożnik kontraktu (premia per akcja). avgBuyPrice/currentPrice zostają
      // w skali notowania.
      const instMult = instrumentPriceMultiplier(
        category,
        fallbackEntry.ticker,
        txs,
        isin,
        opts?.optionContracts,
      );
      const currentValueNative = effShares * fallbackPrice * instMult;
      const currentValuePln = currentValueNative * fxNativeToPln;
      let costBasisPln = 0;
      for (const lot of effLots) {
        const lotFx = fxRates[lot.currency] || 1;
        costBasisPln += lot.quantity * lot.price * instMult * lotFx;
      }
      if (isShort) costBasisPln = -costBasisPln; // otrzymana premia = ujemny koszt bazowy
      const profitLossPln = currentValuePln - costBasisPln;
      const profitLossPct =
        Math.abs(costBasisPln) > 0 ? (profitLossPln / Math.abs(costBasisPln)) * 100 : 0;
      const avgBuyPriceNative =
        Math.abs(effShares) > 0
          ? Math.abs(costBasisPln) / instMult / fxNativeToPln / Math.abs(effShares)
          : 0;
      const costBasisNative = effShares * avgBuyPriceNative * instMult;
      const profitLossNative = currentValueNative - costBasisNative;
      totalValuePln += currentValuePln;
      positions.push({
        paperName: fallbackEntry.name,
        isin,
        ticker: fallbackEntry.ticker,
        shares: effShares,
        avgBuyPrice: avgBuyPriceNative,
        totalCommission: metrics.totalCommission,
        currentPrice: fallbackPrice,
        currentValue: currentValueNative,
        currentValuePln,
        profitLoss: profitLossNative,
        profitLossPln,
        profitLossPct,
        currency: fallbackEntry.currency,
        weight: 0,
        exchange: fallbackEntry.exchange,
        dailyChangePct: null,
        category,
        priceManual: true,
        optionMeta: optionContract
          ? {
              underlying: optionContract.underlying,
              expiry: optionContract.expiry,
              strike: optionContract.strike,
              optionType: optionContract.optionType,
              multiplier: optionContract.multiplier,
            }
          : undefined,
        expiryPassed: optionContract ? optionContract.expiry < today : undefined,
        buyLots: effLots.map((lot) => ({
          date: lot.date,
          quantity: lot.quantity,
          price: lot.price,
          commission: lot.commission,
          currency: lot.currency,
        })),
      });
      continue;
    }

    // Fetch current price (in the paper's native currency)
    let currentPrice: number | null = null;
    let previousClose: number | null = null;
    let priceManual = false;
    /** Kiedy pobrano cenę, gdy pochodzi ze store'u — UI pokazuje „kurs z …". */
    let priceAsOf: string | undefined;
    if (entry.exchange === 'NC') {
      // NC: biznesradar główne źródło (Stooq live CSV padł ~03.2026), Stooq zapas —
      // ta sama kolejność co /api/prices/live. Yahoo nie listuje NC.
      currentPrice =
        (await fetchBiznesradarPrice(entry.ticker)) ?? (await fetchStooqPrice(entry.ticker));
      previousClose = await fetchStooqPreviousClose(entry.ticker);
    } else if (entry.exchange === 'CATALYST') {
      // Catalyst: stockwatch (zbiorcze tabele sektorowe, kurs w % nominału,
      // kurs odniesienia = previousClose), Stooq zapas — biznesradar nie
      // kwotuje obligacji (404), Yahoo też nie.
      const sw = await fetchStockwatchBondPrice(entry.ticker);
      currentPrice = sw?.price ?? (await fetchStooqPrice(entry.ticker));
      previousClose = sw?.referencePrice ?? (await fetchStooqPreviousClose(entry.ticker));
    } else {
      // GPW (.WA) + foreign: Yahoo (to preserve Stooq daily quota)
      const yp = await fetchYahooPrice(entry.ticker);
      currentPrice = yp?.price || null;
      previousClose = yp?.previousClose ?? null;
      // GPW: zapas biznesradar przy chybieniu Yahoo (rate limit/awaria) — tylko .WA.
      // previousClose zostaje z Yahoo: biznesradar nie daje poprzedniego zamknięcia,
      // więc zmiana dzienna będzie null zamiast wartości z mieszanych źródeł.
      if (currentPrice === null && (entry.exchange === 'GPW' || entry.ticker.endsWith('.WA'))) {
        currentPrice = await fetchBiznesradarPrice(entry.ticker);
      }
    }

    // Fallback: if live price unavailable, use last transaction price.
    // Dla OPCJI martwa premia tx potrafi grubo mylić (zwłaszcza short głęboko-ITM,
    // gdzie zobowiązanie znika z wyceny) — próbujemy najpierw wartości wewnętrznej
    // z LIVE kursu instrumentu bazowego (spójnie z wyceną historyczną).
    if (currentPrice === null && txs[0]?.category === 'option') {
      const parsed = optionContract
        ? {
            underlying: optionContract.underlying,
            strike: optionContract.strike,
            optionType: optionContract.optionType,
          }
        : parseOccTicker(entry.ticker);
      if (parsed) {
        const yp = await fetchYahooPrice(parsed.underlying);
        if (yp?.price) {
          currentPrice = optionIntrinsicValue(parsed.optionType, yp.price, parsed.strike);
          priceManual = true;
        }
      }
    }
    // Przedostatnia deska: ostatnia cena, jaką realnie widzieliśmy z rynku
    // (przeżywa restart procesu i odcięcie źródła). Znacznie bliżej prawdy niż
    // cena sprzed miesięcy z transakcji — ale tylko dopóki jest świeża, patrz
    // limit wieku w live-quote-store.
    if (currentPrice === null) {
      const stored = getLiveQuoteStore().get(entry.ticker);
      if (stored) {
        currentPrice = stored.price;
        previousClose = stored.previousClose;
        priceManual = true;
        priceAsOf = stored.fetchedAt;
      }
    }
    if (currentPrice === null) {
      const lastTx = [...txs].sort((a, b) => b.date.localeCompare(a.date))[0];
      currentPrice = lastTx?.price || 0;
      priceManual = true;
    }

    // Daily change % — tylko dla realnej ceny live. Po fallbacku (priceManual)
    // currentPrice = ostatnia cena tx, a previousClose bywa ze Stooq — różnica
    // tych dwóch źródeł nie jest żadną „zmianą dzienną".
    const dailyChangePct =
      !priceManual && currentPrice != null && previousClose != null && previousClose > 0
        ? ((currentPrice - previousClose) / previousClose) * 100
        : null;

    let priceInNative = currentPrice || 0;
    // Yahoo returns London-listed prices in GBX (pence) — convert to GBP
    const entCurUpper = entry.currency.toUpperCase();
    if ((entCurUpper === 'GBP' || entCurUpper === 'GBX') && entry.ticker.endsWith('.L')) {
      priceInNative = priceInNative / 100;
    }
    const fxKey = entCurUpper === 'GBX' ? 'GBP' : entCurUpper;
    const fxNativeToPln = fxRates[fxKey] || fxRates[entry.currency] || 1;

    // Determine category from the first transaction
    const category = txs[0]?.category || 'stock';
    // Obligacje: kurs w % nominału — wartości w walucie przez mnożnik nominal/100;
    // opcje: mnożnik kontraktu (premia per akcja). avgBuyPrice/currentPrice zostają
    // w skali notowania (spójna z kwotowaniem Catalyst/Stooq/OPRA).
    const instMult = instrumentPriceMultiplier(
      category,
      entry.ticker,
      txs,
      isin,
      opts?.optionContracts,
    );
    // Obligacja po terminie wykupu a pozycja otwarta → najpewniej brakuje operacji
    // wykupu w plikach (pozycja "wisi" po ostatnim kursie). UI pokaże ostrzeżenie.
    const maturityPassed =
      category === 'bond'
        ? (() => {
            const maturity = findBondByTicker(entry.ticker)?.maturityDate;
            return !!maturity && maturity < new Date().toISOString().slice(0, 10);
          })()
        : undefined;

    const currentValueNative = effShares * priceInNative * instMult;
    const currentValuePln = currentValueNative * fxNativeToPln;

    // Cost basis in PLN: convert each buy lot individually using its own currency.
    // This correctly handles mixed-currency purchases (e.g. NVO bought in PLN and USD).
    // Dla pozycji short: loty otwarcia to sprzedaże — otrzymana premia = ujemny koszt bazowy.
    let costBasisPln = 0;
    for (const lot of effLots) {
      const lotFx = fxRates[lot.currency] || 1;
      costBasisPln += lot.quantity * lot.price * instMult * lotFx;
    }
    if (isShort) costBasisPln = -costBasisPln;

    // P/L in PLN (the account currency)
    const profitLossPln = currentValuePln - costBasisPln;
    const profitLossPct =
      Math.abs(costBasisPln) > 0 ? (profitLossPln / Math.abs(costBasisPln)) * 100 : 0;

    // For display: avgBuyPrice in the paper's native currency
    // Derived from PLN cost basis to correctly handle mixed-currency lots
    const avgBuyPriceNative =
      Math.abs(effShares) > 0
        ? Math.abs(costBasisPln) / instMult / fxNativeToPln / Math.abs(effShares)
        : 0;

    // P/L in native currency (for display alongside position's currency)
    const costBasisNative = effShares * avgBuyPriceNative * instMult;
    const profitLossNative = currentValueNative - costBasisNative;

    totalValuePln += currentValuePln;

    positions.push({
      paperName: entry.name,
      isin,
      ticker: entry.ticker,
      shares: effShares,
      avgBuyPrice: avgBuyPriceNative,
      totalCommission: metrics.totalCommission,
      currentPrice: priceInNative,
      currentValue: currentValueNative,
      currentValuePln,
      profitLoss: profitLossNative,
      profitLossPln,
      profitLossPct,
      currency: entry.currency,
      weight: 0, // computed after total is known
      exchange: entry.exchange,
      sector: entry.sector,
      supersector: entry.supersector,
      country: entry.country,
      dailyChangePct,
      category,
      priceManual: priceManual || undefined,
      priceAsOf,
      maturityPassed,
      optionMeta: optionContract
        ? {
            underlying: optionContract.underlying,
            expiry: optionContract.expiry,
            strike: optionContract.strike,
            optionType: optionContract.optionType,
            multiplier: optionContract.multiplier,
          }
        : undefined,
      expiryPassed: optionContract ? optionContract.expiry < today : undefined,
      buyLots: effLots.map((lot) => {
        // Convert lot price to the paper's native currency for consistent display
        const lotFx = fxRates[lot.currency] || 1;
        const priceInNativeCurrency =
          lot.currency === entry.currency ? lot.price : (lot.price * lotFx) / fxNativeToPln;
        return {
          quantity: lot.quantity,
          price: priceInNativeCurrency,
          commission: lot.commission,
          date: lot.date,
          currency: entry.currency,
        };
      }),
    });
  }

  // Compute weights
  for (const pos of positions) {
    pos.weight = totalValuePln > 0 ? (pos.currentValuePln / totalValuePln) * 100 : 0;
  }

  // Sort by value descending
  positions.sort((a, b) => b.currentValuePln - a.currentValuePln);

  return { positions, totalValuePln, detectedSplits: allSplits };
}

// ============ Closed Trades (FIFO) ============

/** Epsilon for floating-point comparison in FIFO matching (prevents ghost lots from fractional shares) */
const EPSILON = 1e-9;

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeClosedTrades(
  transactions: Transaction[],
  tickerMap: Map<string, TickerMapEntry>,
  operations?: CashOperation[],
  splits: DetectedSplit[] = [],
  spinOffs: AppliedSpinOff[] = [],
  optionContracts?: Map<string, OptionContract>,
  /** Ceny rozliczenia (intrinsic) opcji po terminie — z resolveOptionExpirySettlements; brak → 0. */
  optionSettlementPrices?: Map<string, number>,
): ClosedTrade[] {
  // Adjust transactions for stock splits (quantity/price correction),
  // then apply spin-offs — sprzedaż dziecka musi FIFO-wać z wstrzykniętym kosztem
  const adjustedTxs = applySpinOffs(
    adjustTransactionsForSplits(transactions, splits),
    spinOffs,
    splits,
  );

  // Auto-domknięcie opcji po terminie — syntetyczny round-trip z realnym P/L (jak w
  // computeOpenPositions). Guard w expireOptions pilnuje, by realny Ep/Ex/A nie dublował się.
  const withExpiry = optionContracts
    ? expireOptions(
        adjustedTxs,
        optionContracts,
        new Date().toISOString().slice(0, 10),
        optionSettlementPrices,
      )
    : adjustedTxs;

  // Group transactions by ISIN (or ISIN + positionId for CFD to prevent mixing overlapping positions)
  const byGroup = new Map<string, Transaction[]>();
  for (const tx of withExpiry) {
    const groupKey = tx.cfdPositionId ? `${tx.isin}|cfd|${tx.cfdPositionId}` : tx.isin;
    const arr = byGroup.get(groupKey) || [];
    arr.push(tx);
    byGroup.set(groupKey, arr);
  }

  const closedTrades: ClosedTrade[] = [];
  // tradeGroupId round-tripów, które na koniec przetwarzania grupy zostały otwarte (qty ≠ 0).
  const openGroupIds = new Set<string>();

  // Kurs rozliczenia brokera z nogi transakcji — nadaje się do przeliczeń na PLN
  // tylko gdy rozliczenie było w PLN (fxRate = PLN za 1 jednostkę waluty notowania;
  // np. DEGIRO na koncie EUR ma kurs EUR-per-quote — bezużyteczny tutaj).
  // convertClosedTradesToPln preferuje te kursy nad dzienne kursy rynkowe.
  const legFxToPln = (tx: Transaction): number | undefined =>
    tx.fxRate &&
    tx.fxRate > 0 &&
    (tx.paymentCurrency ?? tx.currency).toUpperCase() === 'PLN' &&
    tx.currency.toUpperCase() !== 'PLN'
      ? tx.fxRate
      : undefined;

  for (const [groupKey, txs] of byGroup) {
    const isin = txs[0].isin; // clean ISIN for display/lookup
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const buyQueue: Array<{
      quantity: number;
      price: number;
      commission: number;
      date: string;
      /** Waluta notowania nogi kupna — trade z inną walutą nogi sprzedaży (migracja
       *  delistingowa, np. PROVIDENT: kupno GPW/PLN → squeeze-out LSE/GBP) dostaje
       *  buyCurrency i jest przeliczany per noga w convertClosedTradesToPln. */
      currency: string;
      /** Kurs brokera → PLN nogi kupna (patrz legFxToPln). */
      fxToPln?: number;
    }> = [];
    const shortQueue: Array<{
      quantity: number;
      price: number;
      commission: number;
      date: string;
      sellTx: Transaction;
    }> = [];
    const entry = tickerMap.get(isin);
    // Obligacje: kursy w % nominału — P/L w walucie wymaga mnożnika nominal/100.
    // Opcje: mnożnik kontraktu (premia per akcja, standard 100).
    const bondMult = instrumentPriceMultiplier(
      txs[0]?.category,
      entry?.ticker ?? txs[0]?.paperName,
      txs,
      isin,
      optionContracts,
    );
    // Round-trip (epizod) — licznik rośnie za każdym razem, gdy otwieramy pozycję od zera.
    let episodeSeq = 0;

    for (const tx of sorted) {
      // Wejście w transakcję z pustymi kolejkami = początek nowego round-tripu (flat→…).
      if (buyQueue.length === 0 && shortQueue.length === 0) episodeSeq++;
      const tradeGroupId = `${groupKey}#${episodeSeq}`;
      if (tx.side === 'K') {
        // If there are open short positions, this buy covers them (FIFO)
        if (shortQueue.length > 0) {
          let remaining = tx.quantity;
          const commissionPerShare = tx.commission / tx.quantity;

          while (remaining > EPSILON && shortQueue.length > 0) {
            const shortLot = shortQueue[0];
            const matched = Math.min(remaining, shortLot.quantity);
            if (matched < EPSILON) {
              shortQueue.shift();
              continue;
            }

            const shortDate = new Date(shortLot.date);
            const coverDate = new Date(tx.date);
            const holdingDays = Math.floor(
              (coverDate.getTime() - shortDate.getTime()) / (1000 * 60 * 60 * 24),
            );

            const sellComm = shortLot.commission * (matched / shortLot.quantity);
            const coverComm = matched * commissionPerShare;

            // Proportional swap/rollover from cover transaction (CFD shorts)
            const lotSwap = tx.swap ? roundTo2(tx.swap * (matched / tx.quantity)) : 0;
            const lotRollover = tx.rollover ? roundTo2(tx.rollover * (matched / tx.quantity)) : 0;
            const tradeFees: ClosedTradeFee[] = [];
            if (lotSwap > 0)
              tradeFees.push({
                type: 'swap',
                amount: lotSwap,
                description: `swap: ${tx.paperName}`,
              });
            if (lotRollover > 0)
              tradeFees.push({
                type: 'rollover',
                amount: lotRollover,
                description: `rollover: ${tx.paperName}`,
              });
            const feesTotal = lotSwap + lotRollover;

            // Short P/L: use XTB gross profit when available (includes contract multiplier + FX)
            const grossProfitPortion =
              tx.cfdGrossProfit !== undefined
                ? roundTo2(tx.cfdGrossProfit * (matched / tx.quantity))
                : (matched * shortLot.price - matched * tx.price) * bondMult;
            const pl = grossProfitPortion - sellComm - coverComm - feesTotal;
            // Percentage: derive notional value from gross profit + price change for CFD
            let plPct: number;
            let costBasis: number;
            if (tx.cfdGrossProfit !== undefined) {
              const priceChange =
                shortLot.price > 0 ? (shortLot.price - tx.price) / shortLot.price : 0;
              const notional =
                Math.abs(priceChange) > 1e-6 ? Math.abs(grossProfitPortion / priceChange) : 0;
              plPct = notional > 0 ? (pl / notional) * 100 : 0;
              costBasis = notional > 0 ? notional : matched * shortLot.price * bondMult + sellComm;
            } else {
              const coverValue = matched * tx.price * bondMult;
              plPct = coverValue > 0 ? (pl / coverValue) * 100 : 0;
              // Kapitał zaangażowany = wartość otwarcia shorta + prowizja otwarcia
              costBasis = matched * shortLot.price * bondMult + sellComm;
            }

            closedTrades.push({
              tradeGroupId,
              paperName: entry?.name || tx.paperName,
              isin,
              ticker: entry?.ticker || isin,
              quantity: matched,
              buyDate: shortLot.date, // short sell date
              buyPrice: shortLot.price, // short sell price
              buyCommission: sellComm,
              sellDate: tx.date, // cover date
              sellPrice: tx.price, // cover price
              sellCommission: coverComm,
              profitLoss: pl,
              profitLossPct: plPct,
              holdingDays,
              currency: tx.currency,
              // Short: noga otwarcia = sprzedaż; mieszane waluty nóg oznaczamy,
              // ale konwersja PLN świadomie ich nie przelicza (patrz fx-history).
              buyCurrency:
                shortLot.sellTx.currency !== tx.currency ? shortLot.sellTx.currency : undefined,
              sellTransactionId: shortLot.sellTx.id!,
              sellSource: shortLot.sellTx.source,
              category: tx.category,
              isShort: true,
              fees: tradeFees.length > 0 ? tradeFees : undefined,
              totalCost: sellComm + coverComm + feesTotal,
              costBasis,
              // Short: noga otwarcia = sprzedaż (shortLot), zamknięcia = odkup (tx).
              fxRateOpen: legFxToPln(shortLot.sellTx),
              fxRateClose: legFxToPln(tx),
            });

            if (shortLot.quantity <= remaining + EPSILON) {
              remaining = Math.max(0, remaining - shortLot.quantity);
              shortQueue.shift();
            } else {
              shortLot.quantity -= remaining;
              if (shortLot.quantity < EPSILON) shortQueue.shift();
              remaining = 0;
            }
          }
          // Any leftover after covering shorts becomes a regular buy lot
          if (remaining > EPSILON) {
            buyQueue.push({
              quantity: remaining,
              price: tx.price,
              commission: tx.commission * (remaining / tx.quantity),
              date: tx.date,
              currency: tx.currency,
              fxToPln: legFxToPln(tx),
            });
          }
        } else {
          buyQueue.push({
            quantity: tx.quantity,
            price: tx.price,
            commission: tx.commission,
            date: tx.date,
            currency: tx.currency,
            fxToPln: legFxToPln(tx),
          });
        }
      } else {
        // FIFO sell — consume buy lots first
        let remaining = tx.quantity;
        const commissionPerShare = tx.commission / tx.quantity;

        while (remaining > EPSILON && buyQueue.length > 0) {
          const lot = buyQueue[0];
          const matched = Math.min(remaining, lot.quantity);
          if (matched < EPSILON) {
            buyQueue.shift();
            continue;
          }

          const buyDate = new Date(lot.date);
          const sellDate = new Date(tx.date);
          const holdingDays = Math.floor(
            (sellDate.getTime() - buyDate.getTime()) / (1000 * 60 * 60 * 24),
          );

          const buyComm = lot.commission * (matched / lot.quantity);
          const sellComm = matched * commissionPerShare;

          // Proportional swap/rollover from sell transaction (CFD)
          const lotSwap = tx.swap ? roundTo2(tx.swap * (matched / tx.quantity)) : 0;
          const lotRollover = tx.rollover ? roundTo2(tx.rollover * (matched / tx.quantity)) : 0;
          const tradeFees: ClosedTradeFee[] = [];
          if (lotSwap > 0)
            tradeFees.push({ type: 'swap', amount: lotSwap, description: `swap: ${tx.paperName}` });
          if (lotRollover > 0)
            tradeFees.push({
              type: 'rollover',
              amount: lotRollover,
              description: `rollover: ${tx.paperName}`,
            });
          const feesTotal = lotSwap + lotRollover;

          // P/L: use XTB gross profit when available (CFD: includes contract multiplier + FX)
          // Przy MIESZANYCH walutach nóg (lot.currency ≠ tx.currency) ta różnica jest
          // placeholderem — convertClosedTradesToPln nadpisze pl/plPct wartością
          // przeliczoną per noga przez PLN (tożsamość pl+costBasis+prowizje+fees
          // nadal algebraicznie odtwarza tam wartość sprzedaży w walucie sprzedaży).
          const grossProfitPortion =
            tx.cfdGrossProfit !== undefined
              ? roundTo2(tx.cfdGrossProfit * (matched / tx.quantity))
              : (matched * tx.price - matched * lot.price) * bondMult;
          const pl = grossProfitPortion - buyComm - sellComm - feesTotal;
          // Percentage: derive notional value from gross profit + price change for CFD
          let plPct: number;
          let costBasis: number;
          if (tx.cfdGrossProfit !== undefined) {
            const priceChange = lot.price > 0 ? (tx.price - lot.price) / lot.price : 0;
            const notional =
              Math.abs(priceChange) > 1e-6 ? Math.abs(grossProfitPortion / priceChange) : 0;
            plPct = notional > 0 ? (pl / notional) * 100 : 0;
            costBasis = notional > 0 ? notional : matched * lot.price * bondMult + buyComm;
          } else {
            const buyValue = matched * lot.price * bondMult;
            plPct = buyValue > 0 ? (pl / buyValue) * 100 : 0;
            // Kapitał zaangażowany = wartość nabycia (z nominałem obligacji) + prowizja kupna
            costBasis = buyValue + buyComm;
          }

          closedTrades.push({
            tradeGroupId,
            paperName: entry?.name || tx.paperName,
            isin,
            ticker: entry?.ticker || isin,
            quantity: matched,
            buyDate: lot.date,
            buyPrice: lot.price,
            buyCommission: buyComm,
            sellDate: tx.date,
            sellPrice: tx.price,
            sellCommission: sellComm,
            profitLoss: pl,
            profitLossPct: plPct,
            holdingDays,
            currency: tx.currency,
            buyCurrency: lot.currency !== tx.currency ? lot.currency : undefined,
            sellTransactionId: tx.id!,
            sellSource: tx.source,
            category: tx.category,
            fees: tradeFees.length > 0 ? tradeFees : undefined,
            totalCost: buyComm + sellComm + feesTotal,
            costBasis,
            // Dokładne kursy rozliczenia brokera z nóg (jeśli znane) — preferowane
            // nad kurs dzienny w convertClosedTradesToPln.
            fxRateOpen: lot.fxToPln,
            fxRateClose: legFxToPln(tx),
          });

          if (lot.quantity <= remaining + EPSILON) {
            remaining = Math.max(0, remaining - lot.quantity);
            buyQueue.shift();
          } else {
            lot.quantity -= remaining;
            if (lot.quantity < EPSILON) buyQueue.shift();
            remaining = 0;
          }
        }
        // Any remaining sell quantity with no buy lots = short sell
        if (remaining > EPSILON) {
          shortQueue.push({
            quantity: remaining,
            price: tx.price,
            commission: tx.commission * (remaining / tx.quantity),
            date: tx.date,
            sellTx: tx,
          });
        }
      }
    }

    // Po przejściu wszystkich transakcji grupy: jeśli pozycja nie wróciła do zera,
    // ostatni round-trip jest wciąż otwarty (częściowo zrealizowany).
    if (buyQueue.length > 0 || shortQueue.length > 0) {
      openGroupIds.add(`${groupKey}#${episodeSeq}`);
    }
  }

  // ── Match fee operations to closed trades by ticker/isin + date range ──
  // Only operationType='fee' is matched here (e.g. DEGIRO exchange fees, Sec Fee).
  // CFD swap/rollover is embedded directly on the sell transaction (via Position ID).
  if (operations?.length) {
    const feeOps = operations.filter((op) => op.operationType === 'fee' && op.ticker);

    // Pass 1: sum total matching quantity per fee (for proportional split by quantity)
    const feeMatchQty = new Map<number, number>();
    for (let i = 0; i < feeOps.length; i++) {
      const fee = feeOps[i];
      const feeDate = fee.date.slice(0, 10);
      let totalQty = 0;
      for (const trade of closedTrades) {
        const tickerMatch = fee.ticker === trade.ticker || fee.ticker === trade.isin;
        if (
          tickerMatch &&
          feeDate >= trade.buyDate.slice(0, 10) &&
          feeDate <= trade.sellDate.slice(0, 10)
        ) {
          totalQty += trade.quantity;
        }
      }
      feeMatchQty.set(i, totalQty);
    }

    // Pass 2: assign proportional fee amounts (by quantity) to each trade
    for (const trade of closedTrades) {
      const buyDate = trade.buyDate.slice(0, 10);
      const sellDate = trade.sellDate.slice(0, 10);
      const matchedFees: ClosedTradeFee[] = [];

      for (let i = 0; i < feeOps.length; i++) {
        const fee = feeOps[i];
        const feeDate = fee.date.slice(0, 10);
        const tickerMatch = fee.ticker === trade.ticker || fee.ticker === trade.isin;
        if (tickerMatch && feeDate >= buyDate && feeDate <= sellDate) {
          const totalQty = feeMatchQty.get(i) || trade.quantity;
          const proportion = totalQty > 0 ? trade.quantity / totalQty : 1;
          matchedFees.push({
            type: fee.description.split(':')[0]?.trim() || 'fee',
            amount: roundTo2(Math.abs(fee.amount) * proportion),
            description: fee.description,
          });
        }
      }

      if (matchedFees.length) {
        // Merge with existing fees (swap/rollover from FIFO)
        trade.fees = [...(trade.fees || []), ...matchedFees];
      }
      const feesTotal = (trade.fees || []).reduce((s, f) => s + f.amount, 0);
      trade.totalCost = trade.buyCommission + trade.sellCommission + feesTotal;

      // Recalculate P/L if there are non-FIFO fees (matched here, not already in P/L)
      const extraFeesTotal = matchedFees.reduce((s, f) => s + f.amount, 0);
      if (extraFeesTotal > 0) {
        trade.profitLoss -= extraFeesTotal;
        const buyValue =
          trade.quantity * trade.buyPrice * bondPriceMultiplier(trade.category, trade.ticker, []);
        trade.profitLossPct = buyValue > 0 ? (trade.profitLoss / buyValue) * 100 : 0;
      }
    }
  }

  // Set totalCost for trades that didn't go through fee matching
  for (const trade of closedTrades) {
    if (trade.totalCost === undefined) {
      const feesTotal = (trade.fees || []).reduce((s, f) => s + f.amount, 0);
      trade.totalCost = trade.buyCommission + trade.sellCommission + feesTotal;
    }
  }

  // Oznacz nogi należące do wciąż otwartego round-tripu (pozycja częściowo zrealizowana).
  if (openGroupIds.size > 0) {
    for (const trade of closedTrades) {
      if (trade.tradeGroupId && openGroupIds.has(trade.tradeGroupId)) trade.tradeGroupOpen = true;
    }
  }

  // Sort by sell date descending
  closedTrades.sort((a, b) => b.sellDate.localeCompare(a.sellDate));
  return closedTrades;
}

// ============ Dividends ============

export function extractDividends(operations: CashOperation[]): DividendRecord[] {
  return operations
    .filter((op) => op.operationType === 'dividend')
    .map((op) => ({
      id: op.id!,
      date: op.date,
      ticker: op.ticker || extractTickerFromDescription(op.description),
      description: op.description,
      amount: op.amount,
      currency: op.currency,
      source: op.source,
      subkind: op.subkind === 'coupon' ? ('coupon' as const) : undefined,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function extractTickerFromDescription(desc: string): string {
  const match = desc.match(/dywidendy(?:\s+netto)?\s+(\w+)/i);
  return match ? match[1] : 'UNKNOWN';
}

/**
 * Calculate the number of shares held for a given ISIN at a specific date.
 * Processes K (buy) and S (sell) transactions chronologically up to and including the date.
 */
/**
 * Liczba akcji na zadaną datę.
 *
 * Domyślnie EXCLUSIVE (`t.date < date`) — semantyka ex-date: prawo do dywidendy
 * mają akcje posiadane PRZED dniem ex-date (kupno w dniu ex-date nie łapie się).
 * Dla pytań typu "ile mam dziś" (stan posiadania włącznie z transakcjami z `date`)
 * przekaż `includeDate = true`.
 */
export function getSharesAtDate(
  transactions: Transaction[],
  isin: string,
  date: string,
  includeDate = false,
): number {
  return transactions
    .filter((t) => t.isin === isin && (includeDate ? t.date <= date : t.date < date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .reduce((shares, t) => {
      return t.side === 'K' ? shares + t.quantity : shares - t.quantity;
    }, 0);
}

// ============ FX Exchange History ============

export function extractFxExchanges(operations: CashOperation[]): FxExchangeRecord[] {
  const fxOps = operations.filter((op) => op.operationType === 'fx_exchange');
  const records: FxExchangeRecord[] = [];

  // FX operations come in pairs: negative PLN + positive USD on same date
  const byDate = new Map<string, CashOperation[]>();
  for (const op of fxOps) {
    const key = op.date;
    const arr = byDate.get(key) || [];
    arr.push(op);
    byDate.set(key, arr);
  }

  for (const [date, ops] of byDate) {
    // Sort by id for deterministic pairing (paired inserts stay adjacent)
    ops.sort((a, b) => (a.id || 0) - (b.id || 0));

    // Parujemy nogę ujemną (from) z nogą dodatnią (to) w INNEJ walucie —
    // nie pozycyjnie (i, i+1), bo przeplecione wymiany albo nieparzysta liczba
    // nóg na jednej dacie po cichu rozjeżdżały pary. Preferujemy zgodny fxPair,
    // każdą nogę konsumujemy raz; nogi bez pary pomijamy (jak dotychczas).
    const fromLegs = ops.filter((op) => op.amount < 0);
    const toLegs = ops.filter((op) => op.amount > 0);
    const usedTo = new Set<number>();

    for (const fromOp of fromLegs) {
      let matchIdx = -1;
      if (fromOp.fxPair) {
        matchIdx = toLegs.findIndex(
          (to, i) =>
            !usedTo.has(i) && to.currency !== fromOp.currency && to.fxPair === fromOp.fxPair,
        );
      }
      if (matchIdx === -1) {
        matchIdx = toLegs.findIndex((to, i) => !usedTo.has(i) && to.currency !== fromOp.currency);
      }
      if (matchIdx === -1) continue; // noga bez pary — pomijamy po cichu
      usedTo.add(matchIdx);
      const toOp = toLegs[matchIdx];

      records.push({
        date,
        pair: fromOp.fxPair || `${fromOp.currency}/${toOp.currency}`,
        rate: fromOp.fxRate || Math.abs(fromOp.amount) / toOp.amount,
        amountFrom: Math.abs(fromOp.amount),
        currencyFrom: fromOp.currency,
        amountTo: toOp.amount,
        currencyTo: toOp.currency,
        fromOperationId: fromOp.id,
        toOperationId: toOp.id,
        source: fromOp.source,
      });
    }
  }

  return records.sort((a, b) => b.date.localeCompare(a.date));
}

// ============ XIRR Calculation ============

export function computeXirr(
  deposits: Array<{ date: string; amount: number }>,
  currentValue: number,
): number {
  const cashflows: Array<{ date: Date; amount: number }> = deposits.map((d) => ({
    date: new Date(d.date),
    amount: -d.amount, // deposits (positive) become outflows (negative), withdrawals (negative) become inflows (positive)
  }));

  // Terminal cashflow: current portfolio value (inflow)
  cashflows.push({ date: new Date(), amount: currentValue });

  // Newton-Raphson method for XIRR
  return newtonXirr(cashflows);
}

function newtonXirr(cashflows: Array<{ date: Date; amount: number }>, guess = 0.1): number {
  const daysFactor = 365.0;
  const d0 = cashflows[0].date.getTime();

  function npv(rate: number): number {
    return cashflows.reduce((sum, cf) => {
      const days = (cf.date.getTime() - d0) / (1000 * 60 * 60 * 24);
      return sum + cf.amount / Math.pow(1 + rate, days / daysFactor);
    }, 0);
  }

  function dnpv(rate: number): number {
    return cashflows.reduce((sum, cf) => {
      const days = (cf.date.getTime() - d0) / (1000 * 60 * 60 * 24);
      const t = days / daysFactor;
      return sum - (t * cf.amount) / Math.pow(1 + rate, t + 1);
    }, 0);
  }

  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate);
    const df = dnpv(rate);
    if (Math.abs(df) < 1e-12) break;
    let newRate = rate - f / df;
    // Clamp: rate ≤ −1 daje NaN w Math.pow(1+rate, t) dla ułamkowych t,
    // a rozbieżne iteracje potrafią uciec do absurdalnych wartości.
    if (newRate <= -0.999) newRate = -0.999;
    if (newRate > 10) newRate = 10;
    if (!Number.isFinite(newRate)) return 0;
    if (Math.abs(newRate - rate) < 1e-9) {
      return newRate;
    }
    rate = newRate;
  }

  // Brak konwergencji / NaN → 0 zamiast śmieciowej wartości (NaN nie rzuca,
  // więc try/catch callera by go nie złapał — serializowałby się do null).
  return Number.isFinite(rate) ? rate : 0;
}

// ============ Portfolio History ============

/** Detect dominant base currency of a portfolio from deposit/withdrawal operations.
 *  Pojedyncza waluta → ta; mixed → 'PLN' fallback. Używane przez endpointy
 *  routes i client do decyzji "w jakiej walucie pokazać wartości".  */
export function detectBaseCurrency(operations: CashOperation[]): string {
  const curs = new Set<string>();
  for (const op of operations) {
    if (op.operationType === 'deposit' || op.operationType === 'withdrawal') {
      curs.add((op.currency || 'PLN').toUpperCase());
    }
  }
  return curs.size === 1 ? [...curs][0] : 'PLN';
}

/** Konwertuje op.fxRate do jednolitej konwencji "PLN per 1 X" (direct PLN quote).
 *
 *  Działa TYLKO dla par zawierających PLN ('PLN/USD', 'USD/PLN', 'EUR/PLN', …).
 *  Zwraca null dla cross-rate par ('USD/EUR', 'EUR/GBP', …) — tam op.fxRate
 *  nie jest kursem vs PLN, więc caller musi użyć historical PLN rate
 *  przekazany przez `historicalPlnRates` do computeFxImpact.
 *
 *  Konwencje w istniejących danych:
 *  - Bossa/DEGIRO PLN-involved: fxRate = PLN per X (rate > 1 dla USD/EUR/GBP/CHF)
 *    Przykład: "Wymiana waluty PLN/USD 3.5713" → 3.5713 PLN za 1 USD
 *  - XTB PLN-involved: fxRate = X per PLN (rate < 1 dla tych samych walut)
 *    Przykład: "Exchange rate:0.280763" → 0.280763 USD za 1 PLN
 *  - Cross-rate (DEGIRO USD↔EUR): fxRate = np. USD per EUR (rate ~1.1),
 *    NIE vs PLN → trzeba historical PLN rate.
 */
function plnPerXFromOp(op: CashOperation): number | null {
  if (!op.fxRate || op.fxRate <= 0) return null;
  const pair = op.fxPair?.toUpperCase();
  if (!pair || !pair.includes('PLN')) return null; // cross-rate — caller użyje historical
  if (op.source === 'xtb') return 1 / op.fxRate;
  return op.fxRate; // bossa, degiro, mbank, manual
}

/** Zdarzenie księgi walutowej — znormalizowany przepływ przekraczający granicę
 *  PLN↔X (lub granicę portfela), zbudowany z CashOperation albo ImpliedFxFlow. */
type FxLedgerEvent = {
  /** YYYY-MM-DD — klucz sortowania chronologicznego. */
  dateKey: string;
  /** Kwota natywna ze znakiem: > 0 wpływ do ekspozycji, < 0 rozchód. */
  amount: number;
  /** Kurs PLN per 1 X dla tego zdarzenia; null = nieznany (księgowanie
   *  neutralne po bieżącej średniej / rozchód bez wyniku zrealizowanego). */
  plnPerX: number | null;
};

/** Oblicza "wpływ walut" — różnicę między dzisiejszym kursem PLN a średnim
 *  kursem nabycia walut obcych AKTUALNIE trzymanych w portfelu, plus wynik
 *  ZREALIZOWANY na rozchodach.
 *
 *  Księga walutowa (średnia krocząca / moving-average inventory) per waluta X:
 *  wszystkie przepływy przekraczające granicę PLN↔X przetwarzane chronologicznie.
 *  - Wpływ z kursem: saldo += ilość, koszt += ilość × kurs (zmienia średnią).
 *  - Wpływ bez kursu (np. dywidenda bez danych historycznych): księgowany po
 *    bieżącej średniej — utrzymuje saldo, nie zniekształca średniej. Przy pustej
 *    księdze pomijany (nie ma czym wycenić).
 *  - Rozchód: zdejmuje min(ilość, saldo) po bieżącej średniej (średnia bez zmian);
 *    przy znanym kursie rozchodu dokłada `ilość × (kurs − średnia)` do realizedPln.
 *    Nadwyżka ponad saldo (luki w danych) jest ignorowana — księga nie schodzi
 *    poniżej zera.
 *  Ten model naprawia dawne zniekształcenie: dożywotnia średnia WSZYSTKICH nabyć
 *  (bez rozchodów) mieszała kursy walut dawno wymienionych z powrotem na PLN
 *  do średniej obecnie trzymanego salda.
 *
 *  Źródła zdarzeń:
 *  - operations: KAŻDY typ operacji w walucie X ≠ PLN (fx_exchange obie nogi,
 *    deposit/withdrawal, dividend, fee, odsetki, …) poza corporate_action_pending
 *    (nie wchodzi do cashflow). Kurs: plnPerXFromOp (fxPair z PLN) →
 *    historicalPlnRates[data][X] → null.
 *  - impliedFlows (z route): przepływy wynikające z transakcji rozliczanych
 *    w innej walucie niż kwotowanie (Bossa Zagranica w PLN, XTB/DEGIRO
 *    z paymentCurrency). `pln` dokładne gdy znane, inaczej historical.
 *  Transakcje rozliczane natywnie (cash X ↔ akcje X) NIE są zdarzeniami księgi —
 *  nie przekraczają granicy walutowej (ekspozycja = cash + akcje łącznie).
 *
 *  Matematyka per waluta (na końcu księgi):
 *    avg_pln_per_x = koszt_pozostały / saldo_pozostałe   (null gdy saldo 0)
 *    impact_pln = exposure_x × (today − avg)             (niezrealizowany)
 *    impact_pct = (today / avg − 1) × 100
 *    realized_pln = Σ rozchody × (kurs_rozchodu − średnia_w_momencie)
 *
 *  Zwraca `null` gdy brak obcych walut w ekspozycji (portfel czysto PLN-owy)
 *  lub żadna nie ma dzisiejszego kursu. Waluty w pełni opuszczone (ekspozycja 0)
 *  nie mają wpisu — ich zrealizowany wynik nie jest raportowany (backlog). */
export function computeFxImpact(
  operations: CashOperation[],
  foreignExposures: Map<string, number>, // currency → native exposure (cash + stocks)
  todayFxRatesToPln: Map<string, number>, // currency → PLN per X
  totalPortfolioValuePln: number, // wartość CAŁEGO portfela w PLN
  /** Historyczne kursy PLN per X: date (YYYY-MM-DD) → currency → kurs.
   *  Caller (route) pre-fetchuje Yahoo history dla dat wszystkich zdarzeń
   *  bez bezpośredniego kursu vs PLN (cross-rate fx_exchange, dywidendy,
   *  wypłaty, nogi implied X↔Y, …) — proxy "ile PLN kosztowałaby ta waluta
   *  na rynku tego dnia". */
  historicalPlnRates: Map<string, Map<string, number>> = new Map(),
  /** Pre-computed exposurePln per waluta (z tej samej mapy FX co totalPortfolioValuePln).
   *  Gdy podane, nadpisuje liczone wewnętrznie `exposureNative × todayFx` — gwarantuje że
   *  Σ exposurePln + część PLN = totalPortfolioValuePln (matematycznie). */
  exposurePlnByCurrency?: Map<string, number>,
  /** Przepływy walutowe wynikające z transakcji (patrz ImpliedFxFlow w shared).
   *  Scalane chronologicznie ze zdarzeniami z `operations`. */
  impliedFlows?: ImpliedFxFlow[],
): FxImpact | null {
  const breakdown: FxImpactCurrencyEntry[] = [];

  for (const [currency, exposureNative] of foreignExposures) {
    if (currency === 'PLN') continue;
    if (exposureNative <= 0) continue;

    const todayPlnPerCurrency = todayFxRatesToPln.get(currency) ?? 0;
    if (todayPlnPerCurrency <= 0) continue;

    const curKey = currency.toUpperCase();
    const events: FxLedgerEvent[] = [];

    for (const op of operations) {
      // Klucze foreignExposures są znormalizowane do GBP — operacja wpisana
      // ręcznie jako GBX (pensy) musi trafić do tego samego kubełka.
      const opCur = op.currency?.toUpperCase() === 'GBX' ? 'GBP' : op.currency?.toUpperCase();
      if (opCur !== curKey) continue;
      // corporate_action_pending nie wchodzi do cashflow portfela — pomijamy.
      if (op.operationType === 'corporate_action_pending') continue;
      if (!Number.isFinite(op.amount) || op.amount === 0) continue;

      // Dwa źródła kursu PLN per X:
      //   1. Direct (fxPair zawiera PLN) — plnPerXFromOp rozpoznaje Bossa/DEGIRO/XTB conv.
      //   2. Historical (cross-rate fx, dywidendy, wypłaty, opłaty bez kursu) —
      //      kurs Yahoo z dnia operacji przekazany przez caller.
      const dateKey = op.date.split('T')[0];
      const plnPerX = plnPerXFromOp(op) ?? historicalPlnRates.get(dateKey)?.get(curKey) ?? null;
      events.push({ dateKey, amount: op.amount, plnPerX: plnPerX && plnPerX > 0 ? plnPerX : null });
    }

    if (impliedFlows) {
      for (const flow of impliedFlows) {
        if (flow.currency.toUpperCase() !== curKey) continue;
        if (!Number.isFinite(flow.amountNative) || flow.amountNative <= 0) continue;
        const dateKey = flow.date.split('T')[0];
        const rate =
          flow.pln !== undefined && flow.pln > 0
            ? flow.pln / flow.amountNative
            : (historicalPlnRates.get(dateKey)?.get(curKey) ?? null);
        events.push({
          dateKey,
          amount: flow.kind === 'buy' ? flow.amountNative : -flow.amountNative,
          plnPerX: rate && rate > 0 ? rate : null,
        });
      }
    }

    // Chronologicznie; w obrębie dnia wpływy przed rozchodami (wymiana + wypłata
    // tego samego dnia nie powinna sztucznie ścinać salda).
    events.sort((a, b) =>
      a.dateKey !== b.dateKey ? (a.dateKey < b.dateKey ? -1 : 1) : Math.sign(b.amount - a.amount),
    );

    let balance = 0; // natywne saldo księgi (waluta "wewnątrz" portfela)
    let costPln = 0; // koszt PLN pozostałego salda
    let realizedPln = 0;
    let totalAcquiredNative = 0;
    for (const ev of events) {
      const qty = Math.abs(ev.amount);
      if (ev.amount > 0) {
        if (ev.plnPerX !== null) {
          balance += qty;
          costPln += qty * ev.plnPerX;
          totalAcquiredNative += qty;
        } else if (balance > 0) {
          // Wpływ bez kursu — po bieżącej średniej (saldo rośnie, avg bez zmian).
          costPln += qty * (costPln / balance);
          balance += qty;
          totalAcquiredNative += qty;
        }
        // Pusta księga + brak kursu → zdarzenie niewycenialne, pomijamy.
      } else {
        if (balance <= 0) continue;
        const avg = costPln / balance;
        const disposed = Math.min(qty, balance);
        if (ev.plnPerX !== null) realizedPln += disposed * (ev.plnPerX - avg);
        balance -= disposed;
        costPln -= disposed * avg;
        if (balance < 1e-9) {
          balance = 0;
          costPln = 0;
        }
      }
    }

    // Acquisition-dependent fields — gdy księga pusta (brak wycenialnych nabyć
    // albo wszystko rozchodowane), ekspozycja jest pokazywana ale impact jest
    // nieznany (avg=null, impact=0).
    let avgPlnPerCurrency: number | null = null;
    let impactPln = 0;
    let impactPct = 0;
    if (balance > 1e-9 && costPln > 0) {
      avgPlnPerCurrency = costPln / balance;
      impactPln = exposureNative * (todayPlnPerCurrency - avgPlnPerCurrency);
      impactPct = (todayPlnPerCurrency / avgPlnPerCurrency - 1) * 100;
    }

    const exposurePln =
      exposurePlnByCurrency?.get(currency) ?? exposureNative * todayPlnPerCurrency;
    const exposurePctOfPortfolio =
      totalPortfolioValuePln > 0 ? (exposurePln / totalPortfolioValuePln) * 100 : 0;

    breakdown.push({
      currency,
      exposureNative,
      exposurePln,
      exposurePctOfPortfolio,
      avgPlnPerCurrency,
      todayPlnPerCurrency,
      impactPln,
      impactPct,
      totalAcquiredNative,
      realizedPln,
    });
  }

  if (breakdown.length === 0) return null;

  const foreignExposurePln = breakdown.reduce((s, e) => s + e.exposurePln, 0);
  const fxImpactPln = breakdown.reduce((s, e) => s + e.impactPln, 0);
  const fxRealizedPln = breakdown.reduce((s, e) => s + e.realizedPln, 0);
  // Main: wpływ na cały portfel (intuicyjne, małe dla portfeli z małą walutową częścią)
  const fxImpactPct = totalPortfolioValuePln > 0 ? (fxImpactPln / totalPortfolioValuePln) * 100 : 0;
  // Secondary: wpływ na część zagraniczną (większe, pokazuje "ile ruszył walutowy kawałek")
  const fxImpactPctOfForeign =
    foreignExposurePln > 0 ? (fxImpactPln / foreignExposurePln) * 100 : 0;
  const foreignExposurePctOfPortfolio =
    totalPortfolioValuePln > 0 ? (foreignExposurePln / totalPortfolioValuePln) * 100 : 0;

  return {
    fxImpactPct,
    fxImpactPctOfForeign,
    fxImpactPln,
    fxRealizedPln,
    foreignExposurePln,
    foreignExposurePctOfPortfolio,
    totalPortfolioValuePln,
    breakdown,
  };
}

/** Mapa ticker (Yahoo + Stooq, uppercase) → waluta, zbudowana raz z BENCHMARKS
 *  config (shared/constants) — jedno źródło prawdy zamiast hardcoded heurystyki. */
const BENCHMARK_CURRENCY_BY_TICKER: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const bench of Object.values(BENCHMARKS) as Array<{
    currency: string;
    yahooTicker?: string;
    stooqTicker?: string;
  }>) {
    if (bench.yahooTicker) map.set(bench.yahooTicker.toUpperCase(), bench.currency);
    if (bench.stooqTicker) map.set(bench.stooqTicker.toUpperCase(), bench.currency);
  }
  return map;
})();

/** Benchmark currency lookup — Yahoo nie zawsze dostarcza przy fetchu, a dla
 *  Stooq benchmarków nie mamy metadanych. Źródłem prawdy jest pole `currency`
 *  w BENCHMARKS config; heurystyka per ticker zostaje wyłącznie jako fallback
 *  dla tickerów spoza configu. */
function benchmarkCurrencyFromTicker(ticker: string): string {
  if (!ticker) return 'PLN';
  const t = ticker.toUpperCase();
  const fromConfig = BENCHMARK_CURRENCY_BY_TICKER.get(t);
  if (fromConfig) return fromConfig;
  // Fallback dla nieznanych tickerów (np. custom benchmark w przyszłości)
  if (t.endsWith('.WA') || t === 'WIG' || t === 'WIG20' || t === 'MWIG40' || t === 'SWIG80')
    return 'PLN';
  // ^GSPC, ^IXIC, ^DJI etc. — domyślnie USD (nasze obecne benchmark'i zagraniczne)
  return 'USD';
}

export async function computePortfolioHistory(
  transactions: Transaction[],
  operations: CashOperation[],
  tickerMap: Map<string, TickerMapEntry>,
  benchmarkTicker: string,
  benchmarkSource: 'yahoo' | 'stooq' | 'none',
  startDate?: string,
  endDate?: string,
  splits: DetectedSplit[] = [],
  /** Waluta bazowa portfela — wszystkie wartości w history.portfolioValue,
   *  totalDeposited, returnPct, twrPct, benchmark itp. są liczone w tej walucie.
   *  Dla portfeli PLN: 'PLN' (default, zachowuje backward-compat).
   *  Dla portfeli walutowych (np. XTB USD sub-konto): 'USD' → MWR/TWR liczone
   *  w USD, bez FX noise z wahań USD/PLN. */
  baseCurrency: string = 'PLN',
  spinOffs: AppliedSpinOff[] = [],
  optionContracts?: Map<string, OptionContract>,
): Promise<{
  history: PortfolioHistoryPoint[];
  metrics: PortfolioMetrics;
  detectedSplits: DetectedSplit[];
  /** Per-day snapshot of FX rates (currency → baseCurrency multiplier).
   *  Dla baseCurrency='PLN' (domyślnie) zawartość to standardowe cur → PLN rates.
   *  Dla baseCurrency='USD' to cur → USD rates (w szczególności PLN → USD jest
   *  1/USDPLN). Wyjście eksponowane dla downstream consumers (computeCashFlow
   *  i inne) którzy potrzebują konwertować wartości bez re-fetchu. */
  dailyFxRates: Map<string, Map<string, number>>;
  /** Instrumenty wycenione bez notowań providera (seria z cen transakcji) —
   *  metadane do banera „wycena częściowo przybliżona" na dashboardzie. */
  unpricedInstruments: UnpricedInstrument[];
}> {
  const baseCur = baseCurrency.toUpperCase();
  // Determine date range
  const allDates = [
    ...operations.map((o) => o.date.split('T')[0]),
    ...transactions.map((t) => t.date.split('T')[0]),
  ].sort();

  const start = startDate || allDates[0] || '2021-12-01';
  const end = endDate || new Date().toISOString().split('T')[0];

  // Generate all dates (use UTC to avoid DST duplicate issues)
  const dates: string[] = [];
  const d = new Date(start + 'T12:00:00Z');
  const dEnd = new Date(end + 'T12:00:00Z');
  while (d <= dEnd) {
    dates.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 1);
  }

  // Build daily deposits and withdrawals per currency. Conversion to PLN
  // happens in the main loop using that day's FX rate — only PLN-normalized
  // values are used for MWR/TWR/benchmark DCA, so totalValue (in PLN) and
  // totalDeposited (in PLN) are on the same scale.
  const dailyDepositByCur = new Map<string, Map<string, number>>();
  const dailyWithdrawalByCur = new Map<string, Map<string, number>>();
  for (const op of operations) {
    const date = op.date.split('T')[0];
    const cur = (op.currency || 'PLN').toUpperCase();
    const target =
      op.operationType === 'deposit' && op.amount > 0
        ? dailyDepositByCur
        : op.operationType === 'withdrawal'
          ? dailyWithdrawalByCur
          : null;
    if (!target) continue;
    let map = target.get(date);
    if (!map) {
      map = new Map();
      target.set(date, map);
    }
    map.set(cur, (map.get(cur) || 0) + Math.abs(op.amount));
  }

  // Keep the flat "has any deposit/withdrawal on this day" view for lastActivityDate below.
  const dailyDeposit = new Map<string, number>();
  const dailyWithdrawal = new Map<string, number>();
  for (const [date, curMap] of dailyDepositByCur) {
    let s = 0;
    for (const v of curMap.values()) s += v;
    dailyDeposit.set(date, s);
  }
  for (const [date, curMap] of dailyWithdrawalByCur) {
    let s = 0;
    for (const v of curMap.values()) s += v;
    dailyWithdrawal.set(date, s);
  }

  // Build daily cash flow per currency (generic — handles any currency)
  const dailyCashFlowByCurrency = new Map<string, Map<string, number>>();

  function getCashFlowMap(currency: string): Map<string, number> {
    const upper = currency.toUpperCase() || 'PLN';
    let map = dailyCashFlowByCurrency.get(upper);
    if (!map) {
      map = new Map<string, number>();
      dailyCashFlowByCurrency.set(upper, map);
    }
    return map;
  }

  for (const op of operations) {
    const date = op.date.split('T')[0];
    // `corporate_action_pending` — zdarzenie niedomknięte (np. nieznane wezwanie skupu
    // bez tender-offers-map). Cash z CSV fizycznie wpłynął na konto brokerskie, ALE
    // pozycja akcyjna nie została jeszcze zmniejszona (brak synthetic SELL). Gdybyśmy
    // zaliczyli tu ten cash do bilansu, portfel byłby zawyżony: market value ghost-shares
    // + cash z ich sprzedaży jednocześnie. Dlatego pomijamy — user musi domknąć przez
    // endpoint /corporate-actions/:id/resolve (tworzy synthetic SELL, cash wtedy wchodzi
    // do bilansu normalnie jako różnica total-commission w transakcji).
    if (op.operationType === 'corporate_action_pending') continue;
    const map = getCashFlowMap(op.currency);
    map.set(date, (map.get(date) || 0) + op.amount);
  }

  // Transaction cash impacts — księgowane PO fetchu historii FX (pętla niżej, za
  // await Promise.all), bo rozliczenie w paymentCurrency bez kursu brokera wymaga
  // dziennego kursu historycznego.

  // Get unique ISINs that were ever held (ISINs don't change with split adjustment)
  const allIsins = new Set<string>();
  for (const tx of transactions) allIsins.add(tx.isin);
  // Dzieci spin-offów nie mają realnych transakcji — bez dopisania tu ich ISIN-ów
  // wycena dzienna nie dostałaby cen historycznych (forward-fill z ceny kosztowej).
  for (const so of spinOffs) {
    if (so.status === 'applied' && allIsins.has(so.parentIsin)) allIsins.add(so.childIsin);
  }

  // ── Syntetyczne wpisy dla papierów BEZ ticker_map (delisted/nierozpoznane) ──
  // Pozycja bez wpisu była dotąd TWARDO pomijana w wycenie dziennej (`if (!entry)
  // continue` niżej) — kontrybucja 0 przy zdjętej gotówce za kupno → wykres startował
  // głęboko pod kreską i skakał przy sprzedaży. Zmierzone na pełnym imporcie ING
  // 2017→2026 (BRIJU/GETBACK — delisted; żadne źródło nie ma ich historii:
  // biznesradar i Yahoo → 404, Stooq historyczny martwy). Wpis in-memory (BEZ zapisu
  // do DB — zamknięte pozycje celowo nie dostają stubów przy imporcie) wpuszcza
  // papier w istniejącą maszynerię wyceny z cen transakcji: kotwice tx-price,
  // interpolacja między transakcjami i forward-fill.
  const syntheticIsins = new Set<string>();
  {
    const augmented = new Map(tickerMap);
    const takenTickers = new Set<string>();
    for (const e of tickerMap.values()) takenTickers.add(e.ticker);
    for (const tx of [...transactions].sort((a, b) => a.date.localeCompare(b.date))) {
      if (augmented.has(tx.isin) || tx.price <= 0) continue;
      // Guard kolizji: paperName martwego papieru bywa RÓWNY tickerowi żywego
      // wpisu innego ISIN-u (recykling kodów GPW) — klucz serii musi być unikalny,
      // inaczej wycena podpięłaby się pod CUDZE notowania.
      const ticker = takenTickers.has(tx.paperName) ? `${tx.paperName}~${tx.isin}` : tx.paperName;
      takenTickers.add(ticker);
      augmented.set(tx.isin, {
        isin: tx.isin,
        ticker,
        name: tx.paperName,
        exchange: 'OTHER',
        currency: tx.currency,
        priceSource: 'yahoo',
      });
      syntheticIsins.add(tx.isin);
    }
    // Lokalna kopia — mapa wywołującego pozostaje nietknięta.
    tickerMap = augmented;
  }

  // Fetch historical prices for all tickers + FX
  const tickersToFetch: Array<{ isin: string; ticker: string; source: string; currency: string }> =
    [];
  for (const isin of allIsins) {
    // Syntetyki NIE idą do sieci: nie mają źródła (pusty strzał/404), a symbol
    // z gołego paperName mógłby trafić w CUDZY papier u providera.
    if (syntheticIsins.has(isin)) continue;
    const entry = tickerMap.get(isin);
    if (entry) {
      tickersToFetch.push({
        isin,
        ticker: entry.ticker,
        source: entry.priceSource,
        currency: entry.currency,
      });
    }
  }

  // ── Opcje: przygotowanie wyceny (premia rynkowa + floor intrinsic) ──
  // Historię premii OCC pobieramy jak każdy zagraniczny ticker (Yahoo v8 chart kwotuje
  // aktywne kontrakty; wygasłe → 404 → pusta seria). Kurs instrumentu BAZOWEGO jest
  // potrzebny do flooru intrinsic — bez niego martwa premia głęboko-ITM shorta zaniża
  // zobowiązanie (portfel zawyżony miesiącami). Parsujemy kontrakt (option_contracts lub
  // z OCC tickera); bazowy już tradowany osobno → reużycie jego serii bez dublowania
  // fetchu (root OCC = ticker Yahoo dla opcji US).
  interface HeldOption {
    occTicker: string;
    optionType: 'C' | 'P';
    strike: number;
    expiry: string;
    underlyingKey: string; // klucz w historicalPrices z serią kursu bazowego
  }
  const heldOptions: HeldOption[] = [];
  const optionUnderlyingsToFetch = new Set<string>();
  const alreadyFetchedTickers = new Set(tickersToFetch.map((t) => t.ticker));
  for (const isin of allIsins) {
    const entry = tickerMap.get(isin);
    if (!entry) continue;
    const contract = optionContracts?.get(isin);
    const parsed: ParsedOptionSymbol | null = contract
      ? {
          underlying: contract.underlying,
          strike: contract.strike,
          optionType: contract.optionType,
          expiry: contract.expiry,
        }
      : parseOccTicker(entry.ticker);
    if (!parsed) continue; // nie opcja
    heldOptions.push({
      occTicker: entry.ticker,
      optionType: parsed.optionType,
      strike: parsed.strike,
      expiry: parsed.expiry,
      underlyingKey: parsed.underlying,
    });
    if (!alreadyFetchedTickers.has(parsed.underlying)) {
      optionUnderlyingsToFetch.add(parsed.underlying);
    }
  }
  // Zdarzenia split instrumentów bazowych opcji (Yahoo, autorytatywne) — potrzebne,
  // bo kursy historyczne Yahoo są skorygowane o splity (np. OTLY 1:20, LCID 1:10), a
  // strike opcji jest w skali współczesnej. Pobieramy je NIEZALEŻNIE od tego, czy user
  // trzymał akcje bazowego (allSplits łapie tylko splity z pozycji akcyjnych).
  const optionUnderlyingSymbols = new Set(heldOptions.map((o) => o.underlyingKey));
  const underlyingSplitEvents = new Map<string, Array<{ date: string; ratio: number }>>();

  // Fetch all historical data
  const historicalPrices = new Map<string, Map<string, number>>(); // ticker -> date -> close

  // Fetch historical data — Yahoo-first for GPW, Stooq only for NewConnect
  const fetchPromises = tickersToFetch.map(async ({ ticker, source, isin }) => {
    const entry = tickerMap.get(isin);
    let data: Array<{ date: string; close: number }>;
    if (entry?.exchange === 'NC' || entry?.exchange === 'CATALYST') {
      // NewConnect + Catalyst: biznesradar główne źródło historii (Stooq historyczny
      // za challenge od ~07.2026), Stooq/cache jako zapas. Yahoo nie listuje NC ani
      // obligacji. Oba czytają ten sam klucz cache, więc zamrożone dane Stooqa są
      // reużyte, a biznesradar dokłada brakujące dni.
      data = await fetchBiznesradarHistory(ticker, start);
      if (data.length < 10) {
        const stooqData = await fetchStooqHistory(ticker, start);
        if (stooqData.length > data.length) data = stooqData;
      }
    } else if (ticker.endsWith('.WA')) {
      // GPW: Yahoo first, Stooq fallback (to preserve Stooq daily quota)
      data = await fetchYahooHistory(ticker, start, end);
      if (data.length < 10) {
        console.log(`Yahoo returned ${data.length} points for ${ticker}, falling back to Stooq`);
        const stooqData = await fetchStooqHistory(ticker, start);
        if (stooqData.length > data.length) data = stooqData;
      }
    } else {
      // Foreign: Yahoo
      data = await fetchYahooHistory(ticker, start, end);
    }
    const priceMap = new Map<string, number>();
    for (const d of data) priceMap.set(d.date, d.close);
    historicalPrices.set(ticker, priceMap);
  });

  // Collect all currencies from operations and transactions
  // Normalize GBX/GBp → GBP (Yahoo reports London prices in pence but FX pair is GBPPLN=X)
  function normalizeCurrency(c: string): string {
    const u = c.toUpperCase();
    return u === 'GBX' || u === 'GBP' ? 'GBP' : u;
  }
  const allCurrencies = new Set<string>();
  for (const op of operations) allCurrencies.add(normalizeCurrency(op.currency));
  for (const tx of transactions) {
    allCurrencies.add(normalizeCurrency(tx.currency));
    // Waluta rozliczenia — księgowanie cash flow po stronie payment wymaga pary FX
    // także wtedy, gdy żadna pozycja nie jest w niej kwotowana.
    if (tx.paymentCurrency) allCurrencies.add(normalizeCurrency(tx.paymentCurrency));
  }
  // Also include currencies from ticker map (stock prices in foreign currency)
  for (const entry of tickerMap.values()) {
    if (entry.currency) allCurrencies.add(normalizeCurrency(entry.currency));
  }
  allCurrencies.delete('PLN'); // PLN doesn't need FX rate

  // Fetch FX rates for all currencies
  for (const cur of allCurrencies) {
    const fxTicker = `${cur}PLN=X`;
    fetchPromises.push(
      (async () => {
        const data = await fetchYahooHistory(fxTicker, start, end);
        const priceMap = new Map<string, number>();
        for (const d of data) priceMap.set(d.date, d.close);
        historicalPrices.set(fxTicker, priceMap);
      })(),
    );
  }

  // Fetch benchmark (skip when disabled)
  if (benchmarkSource !== 'none') {
    fetchPromises.push(
      (async () => {
        let data: Array<{ date: string; close: number }>;
        if (benchmarkSource === 'stooq') {
          data = await fetchStooqHistory(benchmarkTicker, start);
        } else {
          data = await fetchYahooHistory(benchmarkTicker, start, end);
        }
        const priceMap = new Map<string, number>();
        for (const d of data) priceMap.set(d.date, d.close);
        historicalPrices.set(`benchmark_${benchmarkTicker}`, priceMap);
      })(),
    );
  }

  // Kursy instrumentów bazowych opcji (do wyceny intrinsic) — tylko te nietradowane
  // osobno (tradowane już są w tickersToFetch). Yahoo; brak notowań (np. Eurex) → pusta
  // seria i tor spada na dotychczasowe zachowanie (interpolacja premii).
  for (const sym of optionUnderlyingsToFetch) {
    fetchPromises.push(
      (async () => {
        const data = await fetchYahooHistory(sym, start, end);
        const priceMap = new Map<string, number>();
        for (const d of data) priceMap.set(d.date, d.close);
        historicalPrices.set(sym, priceMap);
      })(),
    );
  }
  // Zdarzenia split bazowych opcji (do sprowadzenia kursu Yahoo do skali strike'a).
  for (const sym of optionUnderlyingSymbols) {
    fetchPromises.push(
      (async () => {
        underlyingSplitEvents.set(sym, await fetchYahooSplitEvents(sym, start));
      })(),
    );
  }

  await Promise.all(fetchPromises);

  // Seed pustych serii syntetyków — pętle kotwic tx-price i interpolacji niżej
  // wymagają ISTNIEJĄCEJ mapy; punkty dosypią się z cen transakcji.
  for (const isin of syntheticIsins) {
    const t = tickerMap.get(isin)!.ticker;
    if (!historicalPrices.has(t)) historicalPrices.set(t, new Map());
  }

  // ── Pokrycie notowaniami — migawka PO fetchach, PRZED kotwicami z cen transakcji ──
  // Pusta seria w tym punkcie = instrument wyceniany wyłącznie z cen transakcji
  // (syntetyki oraz stuby delisted z martwym symbolem). Opcje wyłączone — mają
  // własny tor wyceny (premia/intrinsic), wygasłe kontrakty ZAWSZE mają pustą serię.
  const unpricedInstruments: UnpricedInstrument[] = [];
  {
    const unpricedIsins: string[] = [];
    for (const isin of allIsins) {
      const entry = tickerMap.get(isin);
      if (!entry) continue;
      if (isin.startsWith('OPT:')) continue;
      const serie = historicalPrices.get(entry.ticker);
      if (!serie || serie.size === 0) unpricedIsins.push(isin);
    }
    for (const isin of unpricedIsins) {
      const txs = transactions
        .filter((t) => t.isin === isin)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (txs.length === 0) continue; // np. dziecko spin-offu bez własnych transakcji
      const entry = tickerMap.get(isin)!;
      let net = 0;
      let lastHeld: string | null = null;
      for (const t of txs) {
        net += t.side === 'K' ? t.quantity : -t.quantity;
        lastHeld = Math.abs(net) < 0.001 ? t.date.slice(0, 10) : null;
      }
      unpricedInstruments.push({
        isin,
        name: entry.name || txs[0].paperName,
        firstHeld: txs[0].date.slice(0, 10),
        lastHeld,
        mode: 'tx-price-fallback',
      });
    }
    unpricedInstruments.sort((a, b) => a.firstHeld.localeCompare(b.firstHeld));
  }

  // ── Opcje: seria wyceny = premia rynkowa (forward-fill) z floorem intrinsic ──
  // Yahoo v8 chart MA historię premii aktywnych kontraktów OCC (seria rzadka — opcje
  // handlują nie codziennie); wygasłe kontrakty → 404 → pusta seria. Dla każdego dnia
  // bazowego: forward-fill ostatniej znanej premii + floor wartości wewnętrznej
  // (no-arbitrage: opcja nigdy nie jest warta mniej niż intrinsic). Premia dowozi wartość
  // czasową (OTM > 0 — bez tego zmiany premii w ogóle nie ruszały wyceny portfela),
  // intrinsic chroni przed nieaktualną premią głęboko-ITM (zobowiązanie shorta rośnie
  // z kursem bazowego, choć kontrakt nie handluje). Dni transakcji zostaną potem
  // doprecyzowane realną premią (nadpisanie cen tx niżej), a interpolacja premii sama
  // się pominie (opcje mają komplet punktów). Short (ujemne shares) → ujemne
  // zobowiązanie; mnożnik ×100 nakłada bondMultByIsin.
  //
  // KLUCZOWE: kursy historyczne Yahoo są SKORYGOWANE o splity (np. OTLY 1:20, LCID 1:10),
  // a strike opcji jest w skali WSPÓŁCZESNEJ (z dnia handlu). Sprowadzamy kurs bazowego do
  // skali strike'a mnożąc przez iloczyn ratio zdarzeń split PO danej dacie (real = yahoo ×
  // Πratio; reverse 1:20 ratio=0.05 → ×0.05; forward 4:1 ratio=4 → ×4). Premii OCC NIE
  // skalujemy — kontrakt jest kwotowany w skali swojego strike'a.
  // Premie z WŁASNYCH transakcji jako dodatkowe punkty serii — seria Yahoo bywa rzadka
  // (opcje handlują nie codziennie), a fill użytkownika to realna premia rynkowa z tego
  // dnia; bez seedu okres od otwarcia do pierwszego punktu Yahoo wyceniałby OTM na 0.
  // Wiersze przypisania/wykonania pomijamy (cena tam to strike, nie premia).
  const txPremiumsByOcc = new Map<string, Array<{ date: string; price: number }>>();
  if (heldOptions.length > 0) {
    const occSet = new Set(heldOptions.map((o) => o.occTicker));
    for (const tx of [...transactions].sort((a, b) => a.date.localeCompare(b.date))) {
      if (tx.category !== 'option' || tx.optionEvent || !(tx.price > 0)) continue;
      const occ = tickerMap.get(tx.isin)?.ticker;
      if (!occ || !occSet.has(occ)) continue;
      let arr = txPremiumsByOcc.get(occ);
      if (!arr) txPremiumsByOcc.set(occ, (arr = []));
      arr.push({ date: tx.date.split('T')[0], price: tx.price });
    }
  }

  for (const opt of heldOptions) {
    const underlyingSeries = historicalPrices.get(opt.underlyingKey);
    if (!underlyingSeries || underlyingSeries.size === 0) continue; // brak kursu bazowego
    const events = underlyingSplitEvents.get(opt.underlyingKey) ?? [];
    const premiumSeries = historicalPrices.get(opt.occTicker) ?? new Map<string, number>();
    const txPoints = txPremiumsByOcc.get(opt.occTicker) ?? [];
    const merged = new Map<string, number>();
    let lastPremium = 0; // serie fetcherów są rosnące po dacie → prosty forward-fill
    let txIdx = 0;
    for (const [date, yahooPrice] of underlyingSeries) {
      if (date > opt.expiry) continue; // po wygaśnięciu kontrakt bezwartościowy
      let scale = 1;
      for (const e of events) if (e.date > date) scale *= e.ratio;
      const intrinsic = optionIntrinsicValue(opt.optionType, yahooPrice * scale, opt.strike);
      while (txIdx < txPoints.length && txPoints[txIdx].date <= date) {
        lastPremium = txPoints[txIdx].price;
        txIdx++;
      }
      const premium = premiumSeries.get(date);
      if (premium !== undefined && premium > 0) lastPremium = premium; // Yahoo close > premia tx z tego dnia
      merged.set(date, Math.max(intrinsic, lastPremium));
    }
    historicalPrices.set(opt.occTicker, merged);
  }

  // ── Transaction cash impacts — księgowane w walucie ROZLICZENIA ──
  // Historycznie total szedł zawsze w tx.currency (walucie notowania), co dla kupna
  // zagranicznego z konta PLN tworzyło fantomowe ujemne saldo quote (np. −3795 USD),
  // a wpłacony PLN zostawał nietknięty — rewaluacja fantomu dziennym kursem
  // przekłamywała ekspozycję FX portfela. Reguły:
  //   payment == quote           → jak dotąd: ±total w tx.currency,
  //   fxRate transakcji (>0)     → ±total×fxRate w paymentCurrency (kurs brokera,
  //                                konwencja payment-per-quote),
  //   inaczej                    → ±total×(quotePLN/paymentPLN) po dziennym kursie
  //                                z pobranej historii (forward-fill ≤ data) — m.in.
  //                                mBank (payment=PLN bez kursu w CSV),
  //   brak kursów w historii     → fallback do starego zachowania (quote currency).
  // Pętla działa na RAW transactions (syntetyczne dzieci spin-offów nie dotykają cash).
  const fxPlnAt = (cur: string, date: string): number | null => {
    if (cur === 'PLN') return 1;
    const map = historicalPrices.get(`${cur}PLN=X`);
    if (!map || map.size === 0) return null;
    const exact = map.get(date);
    if (exact !== undefined) return exact;
    let best: string | null = null;
    for (const d of map.keys()) {
      if (d <= date && (best === null || d > best)) best = d;
    }
    return best !== null ? (map.get(best) ?? null) : null;
  };
  for (const tx of transactions) {
    const date = tx.date.split('T')[0];
    const sign = tx.side === 'K' ? -1 : 1;
    const quoteCcy = normalizeCurrency(tx.currency);
    const payCcy = normalizeCurrency(tx.paymentCurrency || tx.currency);
    let bookCcy = tx.currency;
    let amount = tx.total;
    if (payCcy !== quoteCcy) {
      if (tx.fxRate && tx.fxRate > 0) {
        bookCcy = payCcy;
        amount = roundTo2(tx.total * tx.fxRate);
      } else {
        const quotePln = fxPlnAt(quoteCcy, date);
        const payPln = fxPlnAt(payCcy, date);
        if (quotePln !== null && payPln !== null && payPln > 0) {
          bookCcy = payCcy;
          amount = roundTo2((tx.total * quotePln) / payPln);
        }
      }
    }
    const map = getCashFlowMap(bookCcy);
    map.set(date, (map.get(date) || 0) + sign * amount);
  }

  // Detect stock splits by comparing transaction prices with provider prices.
  // Merge with any previously saved/manual splits passed in.
  // Detekcję pomijamy dla ISIN-ów z zapisanymi splitami (realne daty z bazy
  // mają pierwszeństwo), a heurystycznym wykryciom nadajemy realne daty z Yahoo.
  const savedSplitIsins = new Set(splits.map((s) => s.isin));
  // Guard C: filtr PRZED resolveSplitEventDates — spadek kursu rodzica po spin-offie
  // (albo ułamkowy "split" publikowany przez Yahoo dla spin-offu) nie może wejść
  // jako fałszywy reverse split; oszczędza też zbędny strzał o eventy do Yahoo.
  const historySpinOffGuard: SpinOffGuardEvent[] = [...spinOffs, ...SPIN_OFF_MAP];
  const heuristicSplits = filterDetectedSplitsForSpinOffs(
    detectSplits(transactions, historicalPrices, tickerMap).filter(
      (s) => !savedSplitIsins.has(s.isin),
    ),
    historySpinOffGuard,
    'price',
  );
  const newlyDetected = await resolveSplitEventDates(heuristicSplits, tickerMap);
  // Uzupełnienie detekcji cenowej: spółek z transakcjami sprzed startu historii providera
  // nie da się złapać porównaniem cen (brak ceny na dacie tx), a Yahoo zwraca ceny
  // skorygowane o późniejszy reverse-split → skok wyceny na granicy okna. Dociągamy
  // zdarzenia split z Yahoo wprost dla tych pozycji (patrz fetchSplitsForHeldTickers).
  const preWindowSplits = filterDetectedSplitsForSpinOffs(
    await fetchSplitsForHeldTickers(transactions, tickerMap, historicalPrices, {
      skipIsins: savedSplitIsins,
      skipTickers: new Set(newlyDetected.map((s) => s.ticker)),
    }),
    historySpinOffGuard,
    'price',
  );
  // Trzecie źródło: skok w SAMEJ serii providera. Łapie splity, których provider nie
  // zna i o które nie skorygował historii (P500.DE 100:1 z 2025-12-15 — Yahoo bez
  // zdarzenia i z surowym skokiem 1157,40 → 11,57). Detekcja transakcyjna jest tu
  // ślepa: obie strony porównania są w tej samej, starej skali.
  // Świadomie POMIJA resolveSplitEventDates — data ze skoku jest dokładną ex-datą,
  // a tamten fallback (data tx +1) tylko by ją zepsuł.
  const seriesSplits = filterDetectedSplitsForSpinOffs(
    detectSplitsFromPriceSeries(transactions, historicalPrices, tickerMap).filter(
      (s) => !savedSplitIsins.has(s.isin),
    ),
    historySpinOffGuard,
    'price',
  );

  const allSplits = mergeDetectedSplits(splits, [
    ...newlyDetected,
    ...preWindowSplits,
    ...seriesSplits,
  ]);

  // Dokończenie korekty za providera: jeśli seria wciąż zawiera surowy skok w dacie
  // splitu, sprowadzamy jej odcinek sprzed ex-date do skali po splicie. Bez tego
  // adjustTransactionsForSplits (ilość ×ratio) mnożyłoby się z ceną w starej skali
  // i wycena historyczna byłaby `ratio` razy za wysoka. Liczone z merged listy, więc
  // działa też dla splitów już utrwalonych w bazie.
  const normalized = normalizeUnadjustedProviderSeries(historicalPrices, allSplits);
  for (const s of normalized) {
    console.log(
      `Split ${s.ticker} ${s.ratio}:1 z ${s.date} — seria providera nieskorygowana, znormalizowano lokalnie`,
    );
  }

  // Adjust transactions for splits: convert pre-split transactions to post-split scale
  // (quantity * ratio, price / ratio). Provider prices are already split-adjusted, so
  // after this adjustment, everything is in the same (post-split) scale.
  // Then apply spin-offs (child injection + parent basis reduction) — cash-flow
  // loop above iterates RAW transactions, so the synthetic child never touches cash.
  const adjustedTxs = applySpinOffs(
    adjustTransactionsForSplits(transactions, allSplits),
    spinOffs,
    allSplits,
  );

  // Overwrite transaction date prices with adjusted tx prices (same currency only).
  // This ensures exact match on transaction dates even if provider data differs slightly.
  const sortedTxForScaling = [...adjustedTxs].sort((a, b) => a.date.localeCompare(b.date));
  for (const tx of sortedTxForScaling) {
    const entry = tickerMap.get(tx.isin);
    if (!entry) continue;
    // Normalize currencies for comparison (GBX/GBp/GBP are all equivalent)
    const txCurNorm = tx.currency.toUpperCase() === 'GBX' ? 'GBP' : tx.currency.toUpperCase();
    const entryCurNorm =
      entry.currency.toUpperCase() === 'GBX' ? 'GBP' : entry.currency.toUpperCase();
    if (txCurNorm !== entryCurNorm) continue;
    const dateKey = tx.date.split('T')[0];
    const priceMap = historicalPrices.get(entry.ticker);
    if (priceMap) {
      // Yahoo stores .L prices in GBX (pence) — convert adjusted GBP price back to GBX
      const priceForMap =
        txCurNorm === 'GBP' && entry.ticker.endsWith('.L') ? tx.price * 100 : tx.price;
      // Przypisanie/wykonanie opcji: akcje księgowane po strike (np. 230 przy rynku ~96) —
      // NIE nadpisujemy kursu rynkowego strike'iem, bo daje jednodniowy blip wyceny.
      // Fallback bez znacznika (dane sprzed backfillu / inne brokery): rażący rozjazd >30%
      // od istniejącej ceny rynkowej też traktujemy jak strike/złą cenę i zostawiamy rynek.
      const existing = priceMap.get(dateKey);
      const isAssignmentLike = tx.optionEvent === 'assignment' || tx.optionEvent === 'exercise';
      if (
        isAssignmentLike ||
        (existing !== undefined && existing > 0 && Math.abs(priceForMap / existing - 1) > 0.3)
      ) {
        continue;
      }
      priceMap.set(dateKey, priceForMap);
    }
  }

  // For tickers with no provider data (blacklisted or unavailable), interpolate
  // linearly between transaction prices so the chart doesn't have a flat line
  // followed by a sudden jump on sell date.
  for (const isin of allIsins) {
    const entry = tickerMap.get(isin);
    if (!entry) continue;
    const priceMap = historicalPrices.get(entry.ticker);
    if (!priceMap) continue;

    // Collect transaction price points for this ticker (same currency only, split-adjusted)
    const txPoints: Array<{ date: string; price: number }> = [];
    for (const tx of adjustedTxs) {
      if (tx.isin !== isin) continue;
      if (tx.currency !== entry.currency) continue;
      txPoints.push({ date: tx.date.split('T')[0], price: tx.price });
    }
    if (txPoints.length < 2) continue;

    // Check if there's meaningful provider data between first and last tx
    const sortedTx = txPoints.sort((a, b) => a.date.localeCompare(b.date));
    const firstDate = sortedTx[0].date;
    const lastDate = sortedTx[sortedTx.length - 1].date;
    let providerPointsInRange = 0;
    for (const [d] of priceMap) {
      if (d > firstDate && d < lastDate && !sortedTx.some((t) => t.date === d)) {
        providerPointsInRange++;
      }
    }

    // Only interpolate if provider has very few data points (< 10) between transactions
    if (providerPointsInRange >= 10) continue;

    // Interpolate between consecutive transaction price points
    for (let i = 0; i < sortedTx.length - 1; i++) {
      const from = sortedTx[i];
      const to = sortedTx[i + 1];
      const d1 = new Date(from.date + 'T12:00:00Z');
      const d2 = new Date(to.date + 'T12:00:00Z');
      const totalDays = (d2.getTime() - d1.getTime()) / 86400000;
      if (totalDays <= 1) continue;

      const cur = new Date(d1);
      cur.setUTCDate(cur.getUTCDate() + 1);
      while (cur < d2) {
        const dateStr = cur.toISOString().split('T')[0];
        const daysDone = (cur.getTime() - d1.getTime()) / 86400000;
        const ratio = daysDone / totalDays;
        const interpolated = from.price + (to.price - from.price) * ratio;
        priceMap.set(dateStr, interpolated);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
  }

  // Build daily holdings per ISIN (using split-adjusted quantities)
  const holdingsChanges = new Map<string, Map<string, number>>(); // date -> isin -> qty change
  for (const tx of adjustedTxs) {
    const date = tx.date.split('T')[0];
    const byDate = holdingsChanges.get(date) || new Map();
    const change = tx.side === 'K' ? tx.quantity : -tx.quantity;
    byDate.set(tx.isin, (byDate.get(tx.isin) || 0) + change);
    holdingsChanges.set(date, byDate);
  }

  // Helper to get price with forward-fill
  function getPrice(ticker: string, date: string, prevPrice: number): number {
    const priceMap = historicalPrices.get(ticker);
    if (!priceMap) return prevPrice;
    return priceMap.get(date) ?? prevPrice;
  }

  // Build fallback price map from transaction prices — used when historical
  // price data is missing on the purchase date (prevents stock value = 0).
  // Iterujemy PO DACIE (adjustedTxs nie jest sortowane — DB potrafi zwrócić sprzedaż
  // przed kupnem), żeby wziąć cenę NAJWCZEŚNIEJSZEJ transakcji, nie przypadkowej.
  const txPriceByTicker = new Map<string, number>();
  for (const tx of [...adjustedTxs].sort((a, b) => a.date.localeCompare(b.date))) {
    const entry = tickerMap.get(tx.isin);
    if (entry && tx.price > 0 && !txPriceByTicker.has(entry.ticker)) {
      txPriceByTicker.set(entry.ticker, tx.price);
    }
  }

  // Obligacje: kursy (tx i Stooq) w % nominału — mnożnik nominal/100 policzony raz
  // per ISIN przed pętlą dni (wycena dzienna = shares × price × mnożnik × fx).
  // Opcje: mnożnik kontraktu (shares bywa ujemne dla shortów — wycena dzienna
  // naturalnie daje wtedy ujemną wartość zobowiązania).
  const bondMultByIsin = new Map<string, number>();
  {
    const txsByIsin = new Map<string, Transaction[]>();
    for (const tx of adjustedTxs) {
      if (tx.category !== 'bond' && tx.category !== 'option') continue;
      const arr = txsByIsin.get(tx.isin) || [];
      arr.push(tx);
      txsByIsin.set(tx.isin, arr);
    }
    for (const [isin, txs] of txsByIsin) {
      const entry = tickerMap.get(isin);
      bondMultByIsin.set(
        isin,
        instrumentPriceMultiplier(
          txs[0]?.category,
          entry?.ticker ?? txs[0]?.paperName,
          txs,
          isin,
          optionContracts,
        ),
      );
    }
  }

  // Determine the last date of any activity (deposit, withdrawal, or transaction)
  const allActivityDates = [
    ...Array.from(dailyDeposit.keys()),
    ...Array.from(dailyWithdrawal.keys()),
    ...transactions.map((tx) => tx.date.split('T')[0]),
  ];
  const lastActivityDate = allActivityDates.length > 0 ? allActivityDates.sort().pop()! : end;

  // Waluta benchmarku — potrzebna dla konwersji do baseCurrency portfela.
  // Pochodzi z BENCHMARKS config (po stronie route) albo inferujemy z tickera.
  const benchCurrency = benchmarkCurrencyFromTicker(benchmarkTicker);

  // Compute daily values
  const history: PortfolioHistoryPoint[] = [];
  let firstActivitySeen = false;
  const cashByCurrency = new Map<string, number>(); // currency -> balance
  let investedCumulative = 0;
  let totalDeposited = 0; // sum of all deposits (always positive, for MWR base)
  let totalWithdrawn = 0; // sum of all withdrawals (always positive, for MWR)
  const holdings = new Map<string, number>(); // isin -> shares
  let benchShares = 0;
  let benchPriceAvailable = false; // true once we have real benchmark data
  let pendingBenchDeposit = 0; // deposits before benchmark data is available
  let benchTotalWithdrawn = 0; // benchmark's own withdrawn total (may differ from portfolio)

  // TWR tracking: chain daily sub-period returns
  let twrCumulative = 1; // product of (1 + daily return)
  let prevTotalValue = 0; // previous day's total value
  let prevBenchValue = 0;
  let peakTotalValue = 0; // highest portfolio value seen (for liquidation detection)
  let firstBenchPrice = 0; // first available benchmark price (for pure TWR calculation)

  // Track previous prices for forward-fill
  const prevPrices = new Map<string, number>();

  // Snapshot of per-day FX rates (used post-loop for XIRR / totalDividends
  // PLN conversion — avoids re-fetching). Map: date → currency → PLN rate.
  const dailyFxRates = new Map<string, Map<string, number>>();

  for (const date of dates) {
    // Update cash balances per currency
    for (const [cur, flowMap] of dailyCashFlowByCurrency) {
      const flow = flowMap.get(date) || 0;
      if (flow !== 0) {
        cashByCurrency.set(cur, (cashByCurrency.get(cur) || 0) + flow);
      }
    }

    // Update holdings
    const changes = holdingsChanges.get(date);
    if (changes) {
      for (const [isin, qty] of changes) {
        holdings.set(isin, (holdings.get(isin) || 0) + qty);
      }
    }

    // Track first portfolio activity — a deposit OR an opening trade. Bramkowanie tylko
    // na wpłatach ucinało wykres portfeli, w których pierwsza pozycja (kupno albo
    // przeniesienie papierów in-kind) wyprzedza pierwszą zaksięgowaną wpłatę gotówki
    // (#165): wcześniejsze dni wypadały z `history`, więc oś startowała za późno. Saldo
    // i pozycje aktualizujemy WYŻEJ (przed tym guardem), więc przesunięcie startu nie
    // zmienia stanu skumulowanego — wpływa tylko na to, które dni trafiają do serii.
    const hadActivityToday = dailyDepositByCur.has(date) || changes !== undefined;
    if (hadActivityToday) firstActivitySeen = true;

    // Skip leading days before the portfolio has any activity (no money/positions yet).
    if (!firstActivitySeen) continue;

    // Get FX rates for the day. Pierwszy krok: fetch wszystkie cur→PLN rates z
    // Yahoo (standardowa ścieżka). Potem konwertujemy via PLN do baseCurrency:
    //   fx(cur → baseCurrency) = fx(cur → PLN) / fx(baseCurrency → PLN)
    //
    // Dla baseCurrency='PLN': fxBaseToPln=1, fxRates jest standard cur→PLN.
    // Dla baseCurrency='USD': fxRates to cur→USD; np. PLN→USD = 1/USDPLN.

    const fxToPln = new Map<string, number>();
    fxToPln.set('PLN', 1);
    const currenciesToFetch = new Set<string>(allCurrencies);
    currenciesToFetch.delete('PLN');
    if (baseCur !== 'PLN') currenciesToFetch.add(baseCur); // zawsze potrzebujemy base→PLN
    if (benchCurrency !== 'PLN') currenciesToFetch.add(benchCurrency); // dla konwersji benchmark price
    for (const cur of currenciesToFetch) {
      const fxTicker = `${cur}PLN=X`;
      const rate = getPrice(fxTicker, date, prevPrices.get(fxTicker) || DEFAULT_FX_PLN[cur] || 1);
      prevPrices.set(fxTicker, rate);
      fxToPln.set(cur, rate);
    }
    const fxBaseToPln = fxToPln.get(baseCur) ?? 1;

    // fxRates: currency → baseCurrency multiplier (amt × fxRates.get(cur) daje wartość w baseCurrency)
    const fxRates = new Map<string, number>();
    for (const [cur, ratePln] of fxToPln) {
      fxRates.set(cur, ratePln / fxBaseToPln);
    }
    dailyFxRates.set(date, new Map(fxRates));

    // Convert today's deposits / withdrawals do baseCurrency. Zmiana nazw
    // lokalnych *Pln → *Base — wartości teraz są w walucie bazowej portfela
    // (dla PLN portfela: PLN, dla USD portfela: USD).
    let depositBase = 0;
    const depositByCur = dailyDepositByCur.get(date);
    if (depositByCur) {
      for (const [cur, amt] of depositByCur) {
        depositBase += amt * (fxRates.get(cur) ?? 1);
      }
    }
    let withdrawalBase = 0;
    const withdrawalByCur = dailyWithdrawalByCur.get(date);
    if (withdrawalByCur) {
      for (const [cur, amt] of withdrawalByCur) {
        withdrawalBase += amt * (fxRates.get(cur) ?? 1);
      }
    }
    investedCumulative += depositBase;
    investedCumulative -= withdrawalBase;
    totalDeposited += depositBase;
    totalWithdrawn += withdrawalBase;

    // Compute stock value in baseCurrency
    let stockValueBase = 0;

    for (const [isin, shares] of holdings) {
      // Pomijamy tylko pozycje PŁASKIE. Pozycje krótkie (shares < 0) MUSZĄ być wyceniane —
      // ich ujemna wartość to zobowiązanie odkupu, które równoważy gotówkę z krótkiej
      // sprzedaży. Wcześniejsze `shares < EPSILON` odrzucało shorty, więc wartość portfela
      // była zawyżona o przychód z krótkiej sprzedaży (skok na wykresie na początku).
      if (Math.abs(shares) < EPSILON) continue;
      const entry = tickerMap.get(isin);
      if (!entry) continue;

      // `??` (nie `||`): forward-fill MUSI przenosić poprzednią cenę = 0 (opcja OTM ma
      // wartość wewnętrzną 0). Z `||` zero było traktowane jak brak i podmieniane ceną
      // transakcji (np. w luki weekendowe) → widmowe skoki wyceny opcji.
      let price = getPrice(
        entry.ticker,
        date,
        prevPrices.get(entry.ticker) ?? txPriceByTicker.get(entry.ticker) ?? 0,
      );
      prevPrices.set(entry.ticker, price);

      // Yahoo returns London-listed prices in GBX (pence) — convert to GBP.
      // Syntetyk z walutą GBX: seria budowana z cen transakcji jest w pensach,
      // a ticker nie ma sufiksu .L — bez tej gałęzi kurs szedłby ×100 do fx GBP.
      const upperCur = entry.currency.toUpperCase();
      const isGbx = upperCur === 'GBP' || upperCur === 'GBX';
      if (
        isGbx &&
        (entry.ticker.endsWith('.L') || (syntheticIsins.has(isin) && upperCur === 'GBX'))
      ) {
        price = price / 100;
      }

      const fx = fxRates.get(upperCur === 'GBX' ? 'GBP' : upperCur) ?? 1;
      stockValueBase += shares * price * (bondMultByIsin.get(isin) ?? 1) * fx;
    }

    // Total cash in baseCurrency (convert all foreign currency balances)
    let totalCashBase = 0;
    for (const [cur, balance] of cashByCurrency) {
      const fx = fxRates.get(cur) ?? 1;
      totalCashBase += balance * fx;
    }

    const totalValue = stockValueBase + totalCashBase;

    // Benchmark DCA — konwertujemy cenę benchmarka z jego natywnej waluty do
    // baseCurrency portfela, żeby DCA kwot (depositBase) było porównywalne z
    // "ile jednostek benchmarku bym kupił". Dla PLN portfela z WIG: fx=1.
    // Dla USD portfela z S&P: fx=1. Dla USD portfela z WIG (rzadki): PLN→USD.
    const benchKey = `benchmark_${benchmarkTicker}`;
    const benchRawPrice = getPrice(benchKey, date, prevPrices.get(benchKey) || 0);
    const benchFx = fxRates.get(benchCurrency) ?? 1;
    const benchPriceBase = benchRawPrice * benchFx;
    if (!benchPriceAvailable && benchRawPrice > 0) {
      const benchPriceMap = historicalPrices.get(benchKey);
      if (benchPriceMap && benchPriceMap.has(date)) {
        benchPriceAvailable = true;
        firstBenchPrice = benchPriceBase;
      }
    }
    const benchPrice = benchPriceAvailable ? benchPriceBase : 0;
    prevPrices.set(benchKey, benchRawPrice);

    if (benchPrice > 0 && (depositBase > 0 || pendingBenchDeposit > 0)) {
      benchShares += (depositBase + pendingBenchDeposit) / benchPrice;
      pendingBenchDeposit = 0;
    } else if (depositBase > 0) {
      pendingBenchDeposit += depositBase;
    }
    // Sell benchmark shares for the same baseCurrency withdrawal amount.
    // Symuluje "gdybym wypłacił tyle samo cash z benchmarku". Jeśli benchmark
    // nie ma wystarczającej wartości, wypłacamy wszystko co ma.
    if (withdrawalBase > 0 && benchShares > 0 && benchPrice > 0) {
      const benchValueNow = benchShares * benchPrice;
      const actualBenchWithdraw = Math.min(withdrawalBase, benchValueNow);
      benchShares -= actualBenchWithdraw / benchPrice;
      benchTotalWithdrawn += actualBenchWithdraw;
    }
    const benchValue = benchShares * benchPrice;

    // MWR: use total deposited (not net) as the base for return calculation.
    // This avoids the formula breaking when withdrawals exceed deposits.
    const returnPct =
      totalDeposited > 0
        ? ((totalValue + totalWithdrawn - totalDeposited) / totalDeposited) * 100
        : 0;

    const benchReturnPct =
      totalDeposited > 0 && benchPriceAvailable
        ? ((benchValue + benchTotalWithdrawn - totalDeposited) / totalDeposited) * 100
        : 0;

    // TWR: łańcuch dziennych zwrotów sub-okresowych z przepływem na starcie dnia.
    //   dailyReturn = V_dziś / (V_wczoraj + netCashFlow_dziś) − 1
    // Formuła STANDARDOWA daje 0% dla czystej wpłaty/wypłaty (V_dziś = V_wczoraj + flow →
    // ratio 1), więc przepływy nie tworzą sztucznego zwrotu — bez Modified Dietz, który
    // przy dużej wypłacie dawał fałszywy zjazd (mianownik z wagą 0.5 vs V_dziś z pełnym flow).
    // Łańcuchujemy TYLKO gdy oba końce sub-okresu i mianownik są ZNACZĄCE (>5% szczytu):
    // przy wartości bliskiej zeru/ujemnej (portfel praktycznie zlikwidowany, np. po dużej
    // wypłacie z resztką lewarowanych pozycji) TWR jest matematycznie bez sensu i eksploduje,
    // więc go ZAMRAŻAMY na ostatniej sensownej wartości.
    const netCashFlow = depositBase - withdrawalBase;
    const twrDenominator = prevTotalValue + netCashFlow;
    const MEANINGFUL_VALUE = peakTotalValue * 0.05;
    if (
      prevTotalValue > MEANINGFUL_VALUE &&
      totalValue > MEANINGFUL_VALUE &&
      twrDenominator > MEANINGFUL_VALUE
    ) {
      twrCumulative *= totalValue / twrDenominator;
    } else if (totalValue > 0 && prevTotalValue === 0) {
      // First day with value — TWR starts at 1 (0%)
      twrCumulative = 1;
    }

    if (totalValue > peakTotalValue) peakTotalValue = totalValue;

    prevTotalValue = totalValue;
    prevBenchValue = benchValue;

    const twrPct = (twrCumulative - 1) * 100;
    // Benchmark TWR = pure price return (no cash flow influence).
    // TWR by definition eliminates the impact of cash flows, so benchmark TWR
    // is simply the percentage change in the benchmark price since inception.
    const benchmarkTwrPct =
      benchPriceAvailable && firstBenchPrice > 0 ? (benchPrice / firstBenchPrice - 1) * 100 : 0;

    history.push({
      date,
      portfolioValue: totalValue,
      returnPct,
      twrPct,
      benchmarkValue: benchValue,
      benchmarkReturnPct: benchReturnPct,
      benchmarkTwrPct,
      investedCumulative,
      cumulativeDepositsPln: totalDeposited,
      cumulativeWithdrawalsPln: totalWithdrawn,
    });

    // Stop generating history when portfolio is fully and permanently closed:
    // no holdings and on or past last activity date, or portfolio value near zero
    const hasHoldings = Array.from(holdings.values()).some((qty) => qty > 0);
    if (!hasHoldings && date >= lastActivityDate && history.length > 1) {
      break;
    }
  }

  // Compute metrics
  const lastPoint = history[history.length - 1];

  // Helper: konwertuj kwotę operacji do baseCurrency używając FX z daty operacji.
  // Fallback: domyślne rate PLN-based, skorygowane przez fxBaseToPln (dla baseCurrency='PLN' → 1).
  const defaultFxToPln = DEFAULT_FX_PLN;
  const defaultBaseToPln = baseCur === 'PLN' ? 1 : (defaultFxToPln[baseCur] ?? 1);
  const opAmountBase = (op: CashOperation): number => {
    const d = op.date.split('T')[0];
    const cur = (op.currency || 'PLN').toUpperCase();
    const fxFromMap = dailyFxRates.get(d)?.get(cur);
    if (fxFromMap !== undefined) return op.amount * fxFromMap;
    // Fallback: ratio of PLN-defaults (default_cur_pln / default_base_pln = default_cur_base)
    const defaultCurToPln = cur === 'PLN' ? 1 : (defaultFxToPln[cur] ?? 1);
    return op.amount * (defaultCurToPln / defaultBaseToPln);
  };

  // Include both deposits (positive) and withdrawals (negative) for XIRR,
  // converted to baseCurrency (totalValue też jest w base, więc spójne).
  const depositsList = operations
    .filter((op) => op.operationType === 'deposit' || op.operationType === 'withdrawal')
    .map((op) => ({ date: op.date, amount: opAmountBase(op) }));

  const totalDividends = operations
    .filter((op) => op.operationType === 'dividend')
    .reduce((sum, op) => sum + opAmountBase(op), 0);

  // Capital return (obniżenie nominału, korekta wykupu) — osobna metryka obok dywidend.
  // Trzymamy oddzielnie żeby UI mogło pokazać breakdown "Dywidendy X zł / Zwrot kapitału Y zł",
  // ale ekonomicznie obie pozycje są częścią realnego zwrotu z trzymania portfela.
  const totalCapitalReturn = operations
    .filter((op) => op.operationType === 'capital_return')
    .reduce((sum, op) => sum + opAmountBase(op), 0);

  let xirr = 0;
  try {
    xirr = computeXirr(depositsList, lastPoint?.portfolioValue || 0) * 100;
  } catch {
    xirr = 0;
  }

  const metrics: PortfolioMetrics = {
    currentValue: lastPoint?.portfolioValue || 0,
    totalInvested: lastPoint?.investedCumulative || 0,
    xirr,
    totalReturn: (lastPoint?.portfolioValue || 0) - (lastPoint?.investedCumulative || 0),
    totalReturnPct: lastPoint?.returnPct || 0,
    totalDividends,
    totalCapitalReturn,
  };

  return { history, metrics, detectedSplits: allSplits, dailyFxRates, unpricedInstruments };
}

// ============ Cash Flow History ============

/** Dzienna seria wykresu: portfolioValue (codzienny) + netCashFlow (carry-forward). */
export function computeCashFlowChartData(
  portfolioHistory: PortfolioHistoryPoint[],
  dailyFxRates?: Map<string, Map<string, number>>,
  baseCurrency: string = 'PLN',
): { date: string; portfolioValue: number; netCashFlow: number }[] {
  const baseUpper = baseCurrency.toUpperCase();
  const needsConversion = baseUpper !== 'PLN';
  const toBase = (valuePln: number, date: string): number => {
    if (!needsConversion) return valuePln;
    const fx = dailyFxRates?.get(date)?.get(baseUpper);
    if (!fx || fx <= 0) return valuePln;
    return valuePln / fx;
  };

  const all = portfolioHistory.map((p) => ({
    date: p.date,
    portfolioValue: toBase(p.portfolioValue, p.date),
    netCashFlow: toBase(p.cumulativeDepositsPln - p.cumulativeWithdrawalsPln, p.date),
  }));

  // Obcinamy początkowe punkty gdzie nic się nie dzieje (0/0)
  const firstActive = all.findIndex((p) => p.portfolioValue !== 0 || p.netCashFlow !== 0);
  return firstActive > 0 ? all.slice(firstActive) : all;
}

export function computeCashFlow(
  operations: CashOperation[],
  portfolioHistory: PortfolioHistoryPoint[],
  dailyFxRates?: Map<string, Map<string, number>>,
  baseCurrency: string = 'PLN',
): CashFlowRecord[] {
  // Build cash flow record for every date that has a deposit or withdrawal
  // (in any currency). Values come from history points which are already
  // PLN-normalized per-day using FX rates from computePortfolioHistory.
  //
  // For non-PLN portfolios (np. XTB USD sub-konto), konwertujemy PLN → base
  // używając per-day FX rate — wszystkie linie wykresu (portfolioValue,
  // netCashFlow) są wtedy w walucie portfela, a nie w PLN. Dla USD portfela
  // z depozytami tylko w USD: portfolioValue ≈ cash balance USD + stocks_USD,
  // a cumulativeDeposits ≈ raw sum of USD amounts.
  const cashOpDates = new Set<string>();
  for (const op of operations) {
    if (op.operationType === 'deposit' || op.operationType === 'withdrawal') {
      cashOpDates.add(op.date.split('T')[0]);
    }
  }

  const baseUpper = baseCurrency.toUpperCase();
  const needsConversion = baseUpper !== 'PLN';

  // Resolve PLN-denominated value → base currency for a given date.
  // baseFx = how many PLN per 1 base-cur. Value in base = value_pln / baseFx.
  const toBase = (valuePln: number, date: string): number => {
    if (!needsConversion) return valuePln;
    const fx = dailyFxRates?.get(date)?.get(baseUpper);
    if (!fx || fx <= 0) return valuePln; // fallback — leave in PLN (lepsze niż NaN)
    return valuePln / fx;
  };

  const records: CashFlowRecord[] = [];
  let prevCumDepositsPln = 0;
  let prevCumWithdrawalsPln = 0;

  for (const p of portfolioHistory) {
    const dCumPln = p.cumulativeDepositsPln;
    const wCumPln = p.cumulativeWithdrawalsPln;
    const changed = dCumPln !== prevCumDepositsPln || wCumPln !== prevCumWithdrawalsPln;
    if (!changed && !cashOpDates.has(p.date)) continue;

    const dCum = toBase(dCumPln, p.date);
    const wCum = toBase(wCumPln, p.date);
    const depositDeltaPln = Math.max(0, dCumPln - prevCumDepositsPln);
    const withdrawalDeltaPln = Math.max(0, wCumPln - prevCumWithdrawalsPln);

    records.push({
      date: p.date,
      depositAmount: toBase(depositDeltaPln, p.date),
      withdrawalAmount: toBase(withdrawalDeltaPln, p.date),
      cumulativeDeposits: dCum,
      cumulativeWithdrawals: wCum,
      netCashFlow: dCum - wCum,
      portfolioValue: toBase(p.portfolioValue, p.date),
    });

    prevCumDepositsPln = dCumPln;
    prevCumWithdrawalsPln = wCumPln;
  }

  return records;
}

// ============ Cash Balances per Currency ============

export function computeCashBalances(
  transactions: Transaction[],
  operations: CashOperation[],
): Record<string, number> {
  const balances: Record<string, number> = {};

  function add(currency: string, amount: number) {
    balances[currency] = (balances[currency] || 0) + amount;
  }

  // Operations: deposits, dividends, fees, fx_exchange, etc.
  for (const op of operations) {
    add(op.currency, op.amount);
  }

  // Transactions: buy = cash outflow, sell = cash inflow.
  // Rozliczenie w innej walucie ze znanym kursem brokera → księgujemy po stronie
  // paymentCurrency (spójnie z computePortfolioHistory). Bez fxRate (np. mBank)
  // zostaje waluta notowania — funkcja jest synchroniczna i nie ma dostępu do
  // dziennych kursów historycznych; rozbieżność wobec historii świadoma (follow-up:
  // przekazanie lookupu kursów).
  for (const tx of transactions) {
    const sign = tx.side === 'K' ? -1 : 1;
    const payCcy = (tx.paymentCurrency || tx.currency).toUpperCase();
    if (payCcy !== tx.currency.toUpperCase() && tx.fxRate && tx.fxRate > 0) {
      add(payCcy, sign * roundTo2(tx.total * tx.fxRate));
    } else {
      add(tx.currency, sign * tx.total);
    }
  }

  // Remove currencies with negligible balances (< 0.01)
  for (const [currency, balance] of Object.entries(balances)) {
    if (Math.abs(balance) < 0.01) {
      delete balances[currency];
    }
  }

  return balances;
}

// ============ FIFO Matching (Smart Delete support) ============

export interface FifoMatchEntry {
  counterpartyTxId: number;
  counterpartyDate: string;
  counterpartyPrice: number;
  counterpartyCurrency: string;
  quantity: number;
}

export interface FifoMatchedTransaction {
  txId: number;
  date: string;
  side: 'K' | 'S';
  quantity: number;
  price: number;
  currency: string;
  commission: number;
  source?: string;
  syntheticOrigin?: string;
  isCfd: boolean;
  matches: FifoMatchEntry[];
  matchedQty: number;
  residualQty: number;
  /** fully-matched: vollständig skonsumowana (K: wszystkie akcje sprzedane; S: wszystkie pokryte K)
   *  partial: częściowo (jakieś akcje dopasowane, jakieś nie)
   *  open: K bez żadnej matchującej S (otwarta pozycja)
   *  orphan: S bez żadnej matchującej K (oversold / short) */
  status: 'fully-matched' | 'partial' | 'open' | 'orphan';
}

export interface FifoMatching {
  isin: string;
  transactions: FifoMatchedTransaction[];
  /** Pozycja zawiera shortowe/CFD — smart-delete będzie wyłączony dla bezpieczeństwa. */
  hasComplexity: boolean;
  netOpenQty: number;
  totalBuys: number;
  totalSells: number;
}

/** Liczy FIFO-matching dla WSZYSTKICH transakcji danego ISIN.
 *  Dla każdej transakcji zwraca listę counterparty (K↔S), ilości dopasowane,
 *  residual oraz status. UI używa tego do:
 *    - pokazania pary K→S w dialogu smart-delete
 *    - warning gdy usunięcie stworzy orphan/oversold
 *    - wyliczenia proporcjonalnych edycji S po usunięciu K
 *
 *  Uproszczona wersja: obsługuje tylko long (K-first). Pozycje z shortami lub
 *  CFD dostają flagę `hasComplexity=true` → UI fallbackuje do multi-select
 *  bez auto-edycji (bezpieczniej niż zgadywać). */
export function computeFifoMatching(isin: string, allTransactions: Transaction[]): FifoMatching {
  const txs = allTransactions
    .filter((t) => t.isin === isin && t.id != null)
    .sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      if (d !== 0) return d;
      return (a.id ?? 0) - (b.id ?? 0);
    });

  const hasCfd = txs.some((t) => t.category === 'cfd' || !!t.cfdPositionId);

  interface State {
    entry: FifoMatchedTransaction;
    remaining: number;
  }
  const state = new Map<number, State>();
  for (const tx of txs) {
    state.set(tx.id!, {
      entry: {
        txId: tx.id!,
        date: tx.date,
        side: tx.side,
        quantity: tx.quantity,
        price: tx.price,
        currency: tx.currency,
        commission: tx.commission,
        source: tx.source,
        syntheticOrigin: tx.syntheticOrigin,
        isCfd: !!tx.cfdPositionId || tx.category === 'cfd',
        matches: [],
        matchedQty: 0,
        residualQty: tx.quantity,
        status: tx.side === 'K' ? 'open' : 'orphan',
      },
      remaining: tx.quantity,
    });
  }

  const buyQueue: Array<{ txId: number }> = [];
  let shortDetected = false;

  for (const tx of txs) {
    const self = state.get(tx.id!)!;

    if (tx.side === 'K') {
      buyQueue.push({ txId: tx.id! });
      continue;
    }

    // S — consume from buy queue FIFO
    while (self.remaining > EPSILON && buyQueue.length > 0) {
      const headRef = buyQueue[0];
      const head = state.get(headRef.txId)!;
      if (head.remaining < EPSILON) {
        buyQueue.shift();
        continue;
      }

      const matched = Math.min(self.remaining, head.remaining);

      self.entry.matches.push({
        counterpartyTxId: head.entry.txId,
        counterpartyDate: head.entry.date,
        counterpartyPrice: head.entry.price,
        counterpartyCurrency: head.entry.currency,
        quantity: matched,
      });
      head.entry.matches.push({
        counterpartyTxId: self.entry.txId,
        counterpartyDate: self.entry.date,
        counterpartyPrice: self.entry.price,
        counterpartyCurrency: self.entry.currency,
        quantity: matched,
      });

      self.entry.matchedQty += matched;
      head.entry.matchedQty += matched;
      self.remaining -= matched;
      head.remaining -= matched;
      if (head.remaining < EPSILON) buyQueue.shift();
    }

    if (self.remaining > EPSILON) shortDetected = true;
  }

  // Finalize statuses
  const finalList: FifoMatchedTransaction[] = [];
  for (const tx of txs) {
    const s = state.get(tx.id!)!;
    s.entry.residualQty = Math.max(0, s.entry.quantity - s.entry.matchedQty);
    if (s.entry.residualQty < EPSILON) {
      s.entry.status = 'fully-matched';
    } else if (s.entry.matchedQty > EPSILON) {
      s.entry.status = 'partial';
    } else {
      s.entry.status = s.entry.side === 'S' ? 'orphan' : 'open';
    }
    finalList.push(s.entry);
  }

  let totalBuys = 0;
  let totalSells = 0;
  for (const tx of txs) {
    if (tx.side === 'K') totalBuys += tx.quantity;
    else totalSells += tx.quantity;
  }

  return {
    isin,
    transactions: finalList,
    hasComplexity: hasCfd || shortDetected,
    netOpenQty: totalBuys - totalSells,
    totalBuys,
    totalSells,
  };
}

/** Smart-delete preview: liczy jak usunięcie danego `targetId` wpłynie na
 *  pozostałe transakcje pod FIFO. Zwraca listę proponowanych zmian:
 *   - deletes: ID do usunięcia całkowicie (w tym target)
 *   - edits: transakcje do edycji z nową ilością (kiedy target był częściowo
 *     matchowany i trzeba proporcjonalnie odjąć od counterparties)
 *
 *  Semantyka:
 *   - Usuwając K: dla każdego S który konsumował tego K proporcjonalnie, jeśli
 *     S nie ma innych K-matchy → S też idzie do delete, inaczej edycja qty.
 *     UWAGA: samo "odjęcie qty od S" jest nieprecyzyjne bo nie wiemy które
 *     akcje z S pochodziły z K. FIFO dicta order, więc jeśli target K był
 *     JEDYNYM źródłem dla fragmentu S → edycja zmniejsza qty S o matched qty.
 *   - Usuwając S: dla każdego K z którego S pobrał → K nie traci nic (K samo
 *     w sobie wraca do "otwarte"). Czyli prosty DELETE targetu.
 *
 *  Kiedy NIE można użyć smart-delete (zwracamy null, UI pokaże zwykły flow):
 *   - Pozycja ma hasComplexity (shorts/CFD)
 *   - Target to syntetyczna transakcja
 *   - Target to K częściowo matchowany przez wiele S (musielibyśmy edytować >1 S,
 *     co jest skomplikowane, edytowalne ale na razie nie wspierane automatycznie) */
export interface SmartDeletePlan {
  deletes: number[]; // tx IDs to delete
  edits: Array<{
    txId: number;
    newQuantity: number;
    originalQuantity: number;
  }>;
  warnings: string[];
  unsupported?: string; // jeśli nie da się, tu powód
}

export function computeSmartDeletePlan(
  targetId: number,
  allTransactions: Transaction[],
): SmartDeletePlan {
  const target = allTransactions.find((t) => t.id === targetId);
  if (!target) {
    return { deletes: [], edits: [], warnings: [], unsupported: 'Nie znaleziono transakcji.' };
  }
  if (target.syntheticOrigin) {
    return {
      deletes: [],
      edits: [],
      warnings: [],
      unsupported:
        'Transakcja auto-wygenerowana (wezwanie/skup) — usuń operację źródłową zamiast tej transakcji.',
    };
  }

  const matching = computeFifoMatching(target.isin, allTransactions);
  if (matching.hasComplexity) {
    return {
      deletes: [],
      edits: [],
      warnings: [],
      unsupported:
        'Pozycja zawiera CFD lub short — smart-delete niedostępny. Użyj ręcznego multi-select.',
    };
  }

  const entry = matching.transactions.find((t) => t.txId === targetId);
  if (!entry) {
    return {
      deletes: [],
      edits: [],
      warnings: [],
      unsupported: 'Transakcja nie jest w FIFO-matching.',
    };
  }

  const deletes: number[] = [targetId];
  const edits: Array<{ txId: number; newQuantity: number; originalQuantity: number }> = [];
  const warnings: string[] = [];

  if (entry.side === 'S') {
    // Usunięcie S nie wymaga zmian w K (K tylko "wraca" do open).
    // Jedyne co warto dodać: jeśli S był orphanem/oversold, silnik może był w split detection.
    if (entry.status === 'orphan') {
      warnings.push(
        'Ta sprzedaż była osierocona (oversold). Usunięcie jej jest czysto kosmetyczne.',
      );
    }
    return { deletes, edits, warnings };
  }

  // Usuwamy K
  if (entry.status === 'open') {
    // Niematchowany K — po prostu delete
    return { deletes, edits, warnings };
  }

  if (entry.status === 'fully-matched' || entry.status === 'partial') {
    // Musimy zaadresować S-ki które konsumowały tego K.
    // Strategia: dla każdego S-matcha, zmniejsz qty S o matched quantity.
    // Edge case: jeśli S po redukcji qty -> 0 ~ dodajemy do deletes zamiast edit.
    // Edge case: jeśli ten K jest JEDYNĄ K-counterparty dla jakiegoś S (S.matches.length==1),
    // i jednocześnie matched == S.quantity → S idzie do delete.
    for (const m of entry.matches) {
      const counterparty = matching.transactions.find((t) => t.txId === m.counterpartyTxId);
      if (!counterparty) continue;

      // Nowa qty dla S = oryginalna - matched z tym K
      const newQty = counterparty.quantity - m.quantity;

      if (newQty < EPSILON) {
        // Cała S wynikała z tego K → usuń S też
        deletes.push(counterparty.txId);
      } else {
        edits.push({
          txId: counterparty.txId,
          newQuantity: roundToQty(newQty),
          originalQuantity: counterparty.quantity,
        });
      }
    }

    if (entry.status === 'partial' && entry.residualQty > EPSILON) {
      warnings.push(
        `Ta transakcja K była częściowo otwarta (${roundToQty(entry.residualQty)} akcji niesprzedanych). Usunięcie jej zmniejszy otwartą pozycję.`,
      );
    }
  }

  return { deletes, edits, warnings };
}

function roundToQty(q: number): number {
  return Math.round(q * 10000) / 10000;
}
