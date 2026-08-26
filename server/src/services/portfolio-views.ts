import {
  BENCHMARKS,
  DEFAULT_FX_PLN,
  type BenchmarkKey,
  type DetectedSplit,
  type AppliedSpinOff,
  type PortfolioHistoryResponse,
  type PortfolioPositionsResponse,
} from 'shared';
import { getAllTransactions } from '../db/transactions-repo.js';
import { getAllOperations, getMetadata, setMetadata } from '../db/operations-repo.js';
import {
  getTickerMap,
  getAllTickers,
  updateTickerSectors,
  updateTickerCountry,
  getUnresolvedTickerIsins,
} from '../db/ticker-map-repo.js';
import { getSplits, upsertSplits } from '../db/splits-repo.js';
import { getOptionContractsMap } from '../db/option-contracts-repo.js';
import { getSpinOffs } from '../db/spin-offs-repo.js';
import { bumpPortfolioDataVersion } from '../db/data-version.js';
import { invalidateCachedPrices } from './history-cache.js';
import { fetchFxRate } from './yahoo-finance.js';
import { summarizeQuoteFreshness } from './yahoo-quotes.js';
import { riskFreeRate } from './risk-free-rate.js';
import { resolveSector } from './sector-resolver.js';
import {
  computeOpenPositions,
  computeCashBalances,
  detectBaseCurrency,
} from './portfolio-engine.js';
import { computePortfolioHistoryMemoized } from './history-memo.js';
import { applyPendingSpinOffs, getPendingRatioSpinOffs } from './spin-offs-applier.js';
import { resolveUnknownIsins } from './isin-resolver.js';
import { getEarningsCalendarService } from './earnings/earnings-calendar.js';

/**
 * Widoki portfela (historia zwrotów, otwarte pozycje) wyciągnięte z handlerów
 * routes/portfolio.ts, żeby publiczne endpointy share mogły reużyć identyczną
 * logikę (łącznie z memoizacją i persystencją splitów) bez duplikacji.
 * Side-effecty są idempotentne i wewnętrznie rate-limitowane (backfill sektorów
 * i re-resolucja debiutowych stubów max raz/6h per portfel, skan splitów raz na
 * dobę) — bezpieczne też przy ruchu anonimowym.
 */

/**
 * Ile dni wisi wyjaśnienie spin-offu przy pozycji. Badge jest komunikatem
 * jednorazowym ("skąd wzięły się te akcje / dlaczego spadł koszt nabycia") —
 * po dwóch tygodniach od zobaczenia zmiany nie niesie już informacji, a wisi
 * przy pozycji jako stały ⚠ i rozmywa sygnał realnych ostrzeżeń.
 */
export const SPIN_OFF_BADGE_WINDOW_DAYS = 14;

/** Load saved splits from DB and convert to DetectedSplit format for the engine. */
export function loadSplitsForEngine(pid: string): DetectedSplit[] {
  return getSplits(pid).map((s) => ({
    ticker: s.ticker,
    isin: s.isin,
    date: s.splitDate,
    ratio: s.ratio,
    txPrice: 0,
    providerPrice: 0,
    source: s.source,
  }));
}

/** Load spin-offs from DB for the engine. Repo zwraca kształt silnika wprost;
 *  wiersze nie-'applied' filtruje sama transformacja (guard splitów potrzebuje
 *  też tombstone'ów, więc lista jest pełna). */
export function loadSpinOffsForEngine(pid: string): AppliedSpinOff[] {
  return getSpinOffs(pid);
}

/**
 * Spin-offy do badge'a "skąd wzięła się ta pozycja". Okno liczone od ex-date LUB
 * od ZASTOSOWANIA: zdarzenie dodane do mapy po miesiącach (Syn2bio: ex
 * 2026-04-02, wpis w mapie 2026-07-08) aplikuje się długo po ex — pozycja
 * dziecka pojawia się użytkownikowi dopiero przy aplikacji i wtedy badge musi
 * być widoczny. Eksport dla testów; `now` wstrzykiwane wyłącznie testowo.
 */
export function selectRecentSpinOffs(
  spinOffs: AppliedSpinOff[],
  now: Date = new Date(),
): Array<{
  parentIsin: string;
  parentTicker: string;
  childIsin: string;
  childTicker: string;
  exDate: string;
  ratio: number;
  allocationPct: number;
}> {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - SPIN_OFF_BADGE_WINDOW_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return spinOffs
    .filter(
      (s) =>
        s.status === 'applied' &&
        (s.exDate >= cutoffStr || (s.appliedAt ?? '').slice(0, 10) >= cutoffStr),
    )
    .map((s) => ({
      parentIsin: s.parentIsin,
      parentTicker: s.parentTicker,
      childIsin: s.childIsin,
      childTicker: s.childTicker,
      exDate: s.exDate,
      ratio: s.ratio,
      allocationPct: s.allocationPct,
    }));
}

/** Czysta decyzja throttlingu dla lazy passów w tle (backfill sektorów,
 *  re-resolucja stubów) — wydzielona, żeby dała się deterministycznie
 *  przetestować bez sieci. Odpalamy pass tylko gdy JEST co robić (`hasWork`),
 *  nic nie leci w tle (`inFlight`) i minął interwał od ostatniej próby. */
export function shouldRunLazyPass(
  hasWork: boolean,
  lastAttemptMs: number | undefined,
  inFlight: boolean,
  nowMs: number,
  retryMs: number,
): boolean {
  if (!hasWork || inFlight) return false;
  if (lastAttemptMs !== undefined && nowMs - lastAttemptMs < retryMs) return false;
  return true;
}

/** Throttle backfillu sektorów/kraju: max raz na `SECTOR_BACKFILL_RETRY_MS` per
 *  portfel, z guardem in-flight. CZASOWY (nie „raz per proces") — świeży debiut,
 *  którego Yahoo nie miał jeszcze w profilu przy pierwszej próbie, dostaje kolejne
 *  szanse w tym samym procesie, zamiast tkwić w koszyku „Inne" do restartu. Yahoo
 *  assetProfile cache'uje wyniki 7 dni, więc powtórki są tanie; throttle chroni
 *  przed rate-limitem i zbędnym I/O. Nic do zrobienia (wszystko sklasyfikowane) →
 *  `toUpdate` puste → brak próby, throttle nietknięty. */
const sectorBackfillAttemptAt = new Map<string, number>();
const sectorBackfillInFlight = new Set<string>();
export const SECTOR_BACKFILL_RETRY_MS = 6 * 60 * 60 * 1000; // 6h

async function lazyBackfillSectors(pid: string): Promise<void> {
  const entries = getAllTickers(pid);
  // Backfill gdy brak supersektora — po zmianie taksonomii (stockwatch) stary
  // `sector` z Yahoo GICS (po angielsku) nie jest już autorytatywny — lub gdy
  // brak kraju siedziby (pole `country` dodane później niż sektory).
  // Opcje (pseudo-ISIN OPT:...) nie mają sektora — pomijamy zbędne strzały do Yahoo.
  const toUpdate = entries.filter(
    (e) => (!e.supersector || !e.country) && !e.isin.startsWith('OPT:'),
  );
  if (
    !shouldRunLazyPass(
      toUpdate.length > 0,
      sectorBackfillAttemptAt.get(pid),
      sectorBackfillInFlight.has(pid),
      Date.now(),
      SECTOR_BACKFILL_RETRY_MS,
    )
  ) {
    return;
  }
  sectorBackfillAttemptAt.set(pid, Date.now());
  sectorBackfillInFlight.add(pid);
  try {
    for (const entry of toUpdate) {
      try {
        const { supersector, subsector, country } = await resolveSector(entry);
        // Sektory tylko gdy brakowało — nie nadpisujemy ręcznie przypisanych.
        if (!entry.supersector && (supersector || subsector)) {
          updateTickerSectors(entry.isin, supersector, subsector, pid);
        }
        if (!entry.country && country) {
          updateTickerCountry(entry.isin, country, pid);
        }
      } catch {
        // ignore — pojedynczy fail nie blokuje reszty
      }
    }
  } catch {
    // Najlepszy effort, nie blokujemy ruchu user'a
    sectorBackfillAttemptAt.delete(pid); // pozwól na wcześniejszy retry po błędzie
  } finally {
    sectorBackfillInFlight.delete(pid);
  }
}

/** Lazy re-resolucja nierozpoznanych tickerów w tle.
 *
 * Gdy import nie mógł rozpoznać ISIN-u (świeży debiut, nieznana notacja symbolu),
 * papier zostaje bez ceny. Ten pass ponawia rozpoznanie w tle przy ładowaniu
 * pozycji — bez ręcznego re-importu — więc pozycja sama się goi, gdy źródło
 * zacznie ją listować albo gdy dołożymy alias symbolu. `resolveUnknownIsins`
 * traktuje brak wpisu i stuby jak nierozwiązane i nadpisuje je prawdziwym
 * tickerem przy sukcesie (kotwica stubów nie chroni).
 *
 * ZAKRES: `getUnresolvedTickerIsins` bierze OBIE klasy — brak wpisu ORAZ stub.
 * Wcześniej pass patrzył wyłącznie na stuby, a te zapisuje tylko ścieżka CSV;
 * import XTB/IBKR (`importCombinedFiles`) nie zostawia po nierozpoznanym papierze
 * żadnego wpisu, więc pozycje z tych brokerów nie goiły się nigdy.
 *
 * Rate-limit: max raz na `STUB_RESOLVE_RETRY_MS` per portfel, z guardem in-flight
 * przeciw równoległym przebiegom. W przeciwieństwie do backfillu sektorów jest
 * CZASOWY, nie „raz per proces" — debiut nierozpoznany przy pierwszej próbie
 * dostaje kolejne szanse w tym samym procesie serwera. */
const stubResolveAttemptAt = new Map<string, number>();
const stubResolveInFlight = new Set<string>();
export const STUB_RESOLVE_RETRY_MS = 6 * 60 * 60 * 1000; // 6h

/** Decyzja throttlingu dla re-resolucji stubów — cienki wrapper na
 *  `shouldRunLazyPass` z interwałem stubów. */
export function shouldResolveStubs(
  hasStubs: boolean,
  lastAttemptMs: number | undefined,
  inFlight: boolean,
  nowMs: number,
): boolean {
  return shouldRunLazyPass(hasStubs, lastAttemptMs, inFlight, nowMs, STUB_RESOLVE_RETRY_MS);
}

async function lazyResolveProvisionalStubs(pid: string): Promise<void> {
  // Nie tylko stuby: także ISIN-y BEZ wpisu w ticker_map. Stub zapisuje wyłącznie
  // ścieżka CSV, więc papier z XTB/IBKR nierozpoznany przy imporcie nie zostawiał
  // żadnej kotwicy i nie leczył się NIGDY (zgłoszenie GOOGC.US — 7,5 szt. bez ceny
  // od lutego 2025). Zbiór liczony jednym zapytaniem, bez wczytywania transakcji.
  const pendingIsins = getUnresolvedTickerIsins(pid);
  if (
    !shouldResolveStubs(
      pendingIsins.size > 0,
      stubResolveAttemptAt.get(pid),
      stubResolveInFlight.has(pid),
      Date.now(),
    )
  ) {
    return;
  }
  stubResolveAttemptAt.set(pid, Date.now());
  stubResolveInFlight.add(pid);
  try {
    // Rozpoznajemy na podstawie PRAWDZIWYCH transakcji (poprawny paperName /
    // waluta / kategoria), nie pól stuba (te mają zaszyte GPW/PLN).
    const pendingTxs = getAllTransactions(pid).filter((t) => pendingIsins.has(t.isin));
    if (pendingTxs.length > 0) {
      const { resolved } = await resolveUnknownIsins(pendingTxs, pid);
      if (resolved.length > 0) {
        console.log(`Lazy resolve: zagojono ${resolved.length} nierozpoznanych tickerów (${pid})`);
      }
    }
  } catch {
    // best effort — po błędzie pozwól na wcześniejszy retry niż pełny interwał
    stubResolveAttemptAt.delete(pid);
  } finally {
    stubResolveInFlight.delete(pid);
  }
}

/** Persist newly detected splits + invalidate caches. Wspólne dla obu widoków.
 *  Wołający decyduje KIEDY (guardy różnią się między widokami — zachowane 1:1
 *  z oryginalnych handlerów); tu tylko wspólne ciało. */
function persistNewSplits(pid: string, detected: DetectedSplit[], saved: DetectedSplit[]): void {
  const newSplits = detected.filter(
    (ds) => !saved.some((ss) => ss.isin === ds.isin && ss.date === ds.date),
  );
  upsertSplits(
    pid,
    detected.map((s) => ({
      isin: s.isin,
      ticker: s.ticker,
      splitDate: s.date,
      ratio: s.ratio,
      source: s.source,
    })),
  );
  // Invalidate stale pre-split prices so dashboard re-fetches from Yahoo
  for (const s of newSplits) {
    invalidateCachedPrices(s.ticker);
  }
  // Nowe splity zmieniają korektę transakcji → unieważnij memo historii.
  // Bump tylko dla FAKTYCZNIE nowych wykryć (upsert leci też dla już
  // zapisanych splitów — bump wtedy zabiłby cache).
  if (newSplits.length > 0) bumpPortfolioDataVersion(pid);
}

/**
 * Kurs waluty bazowej portfela → PLN per dzień, wyciągnięty ze snapshotu FX silnika.
 *
 * `dailyFxRates` trzyma mnożniki `waluta → waluta BAZOWA` (silnik liczy w bazie, nie
 * w PLN — patrz `computePortfolioHistory`), czyli `fxRates.get(cur) = ratePln(cur) / fxBaseToPln`.
 * Stąd wpis dla PLN to `1 / fxBaseToPln`, a szukany kurs base→PLN to jego odwrotność.
 *
 * Dni bez sensownego wpisu (0/ujemny/brak) po prostu wypadają — konsument (klient)
 * forward-fillem bierze ostatni znany kurs, co jest bezpieczniejsze niż zapisanie 1
 * i ciche potraktowanie waluty obcej jak złotówek.
 */
export function buildBaseToPlnMap(
  dailyFxRates: Map<string, Map<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [date, rates] of dailyFxRates) {
    const plnToBase = rates.get('PLN');
    if (plnToBase && plnToBase > 0) out[date] = 1 / plnToBase;
  }
  return out;
}

/** Historia zwrotów vs benchmark — ciało dawnego POST /api/portfolio/history. */
export async function buildHistoryView(
  pid: string,
  benchmarkKey: BenchmarkKey,
): Promise<PortfolioHistoryResponse> {
  const benchConfig = BENCHMARKS[benchmarkKey];

  const transactions = getAllTransactions(pid);
  const operations = getAllOperations(pid);
  const tickerMap = getTickerMap(pid);

  const benchTicker =
    benchConfig.source === 'none'
      ? ''
      : benchConfig.source === 'stooq'
        ? (benchConfig as any).stooqTicker
        : (benchConfig as any).yahooTicker;

  const savedSplits = loadSplitsForEngine(pid);

  // Auto-aplikacja zaległych spin-offów PRZED liczeniem — bump wersji wewnątrz
  // appliera odświeża klucz memo jeszcze w tym samym requeście, a wynik od razu
  // zawiera pozycję dziecka. Guard detekcji splitów widzi świeże wiersze.
  await applyPendingSpinOffs(pid, transactions, tickerMap, savedSplits);
  const spinOffs = loadSpinOffsForEngine(pid);

  const baseCurrency = detectBaseCurrency(operations);

  // Always compute full history – client filters & rebases by date range.
  // Memo (history-memo.ts): jeden page load dashboardu woła /history,
  // /cash-flow i /metrics — bez memo każdy z nich liczył pełną historię
  // od zera. Klucz zawiera dataVersion, więc zapisy unieważniają cache.
  const result = await computePortfolioHistoryMemoized(
    pid,
    transactions,
    operations,
    tickerMap,
    benchTicker,
    benchConfig.source,
    savedSplits,
    baseCurrency,
    undefined,
    spinOffs,
    getOptionContractsMap(pid),
  );

  if (result.detectedSplits.length > 0) {
    persistNewSplits(pid, result.detectedSplits, savedSplits);
  }

  // Roczna stopa wolna od ryzyka dla statystyk klienta (Sharpe/Sortino/alfa) —
  // UST ~1Y z tej samej krzywej co wycena opcji (Yahoo cache'owane w pamięci,
  // wewnętrzny fallback na stałą gdy sieć padnie); przybliżenie dla PLN.
  const riskFreeRatePct = (await riskFreeRate(1)) * 100;

  // Kursy base→PLN tylko dla portfeli walutowych — klient potrzebuje ich, żeby scalić
  // taki portfel z PLN-owym w portfel łączony. Dla baseCurrency='PLN' kurs to stałe 1,
  // więc pole zostaje nieobecne i payload dashboardu nie rośnie ani o bajt.
  const baseToPlnByDate =
    baseCurrency === 'PLN' ? undefined : buildBaseToPlnMap(result.dailyFxRates);

  return {
    history: result.history,
    metrics: result.metrics,
    baseCurrency,
    riskFreeRatePct,
    ...(baseToPlnByDate ? { baseToPlnByDate } : {}),
  };
}

/** Otwarte pozycje + cash — ciało dawnego GET /api/portfolio/positions. */
export async function buildPositionsView(pid: string): Promise<PortfolioPositionsResponse> {
  const transactions = getAllTransactions(pid);
  const operations = getAllOperations(pid);
  const tickerMap = getTickerMap(pid);
  const savedSplits = loadSplitsForEngine(pid);

  // Fire-and-forget: lazy backfill brakujących sektorów w tle (raz per proces
  // per portfel). Nie blokuje response — user zobaczy nowe sektory po kolejnym
  // odświeżeniu widoku.
  void lazyBackfillSectors(pid);

  // Fire-and-forget: ponów rozpoznanie debiutowych stubów (max raz/6h per portfel).
  // Świeży debiut, którego źródło jeszcze nie listowało w chwili importu, goi się
  // sam po kolejnym odświeżeniu — bez ręcznego re-importu pliku.
  void lazyResolveProvisionalStubs(pid);

  // Auto-aplikacja zaległych spin-offów PRZED liczeniem pozycji — response
  // z tego samego requestu pokazuje już pozycję dziecka. Awaitowane celowo.
  await applyPendingSpinOffs(pid, transactions, tickerMap, savedSplits);
  const spinOffs = loadSpinOffsForEngine(pid);

  // Sieciowa detekcja splitów (cache-bypass do Yahoo) odpala się raz na dobę
  // per portfel — wykrycia są persystowane, więc częstszy skan tylko mnoży
  // niecache'owane requesty (ryzyko rate-limitu) bez nowych informacji.
  const todayStr = new Date().toISOString().split('T')[0];
  const splitScanDue = getMetadata(pid, 'last_split_scan') !== todayStr;

  const {
    positions,
    totalValuePln: stocksValuePln,
    detectedSplits,
  } = await computeOpenPositions(
    transactions,
    tickerMap,
    savedSplits,
    undefined,
    { skipSplitDetection: !splitScanDue, optionContracts: getOptionContractsMap(pid) },
    spinOffs,
  );
  if (splitScanDue) {
    setMetadata(pid, 'last_split_scan', todayStr);
  }

  if (detectedSplits.length > savedSplits.length) {
    persistNewSplits(pid, detectedSplits, savedSplits);
  }

  // Compute cash balances per currency — kursy pobierane dla KAŻDEJ waluty
  // obecnej w saldach (nie tylko USD/CAD/EUR), fallback do DEFAULT_FX_PLN
  const balances = computeCashBalances(transactions, operations);
  const fxRates: Record<string, number> = { PLN: 1 };
  await Promise.all(
    Object.keys(balances)
      .map((cur) => cur.toUpperCase())
      .filter((cur) => cur !== 'PLN')
      .map(async (cur) => {
        const rate = await fetchFxRate(`${cur}PLN`);
        fxRates[cur] = rate || DEFAULT_FX_PLN[cur] || 1;
      }),
  );

  let cashValuePln = 0;
  const cashPositions = Object.entries(balances)
    // Ujemne saldo = kredyt margin (np. IBKR) — musi być widoczne i pomniejszać total
    .filter(([, balance]) => Math.abs(balance) > 0.01)
    .map(([currency, balance]) => {
      const rate = fxRates[currency.toUpperCase()] ?? 1;
      const valuePln = balance * rate;
      cashValuePln += valuePln;
      return { currency, balance, valuePln, weight: 0 };
    });

  const totalValuePln = stocksValuePln + cashValuePln;

  // Recompute weights including cash
  for (const pos of positions) {
    pos.weight = totalValuePln > 0 ? (pos.currentValuePln / totalValuePln) * 100 : 0;
  }
  for (const cp of cashPositions) {
    cp.weight = totalValuePln > 0 ? (cp.valuePln / totalValuePln) * 100 : 0;
  }

  // Recent splits (within last 7 days) for UI notification
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];
  const recentSplits = detectedSplits
    .filter((s) => s.date >= weekAgoStr)
    .map((s) => ({ isin: s.isin, ticker: s.ticker, date: s.date, ratio: s.ratio }));

  const recentSpinOffs = selectRecentSpinOffs(spinOffs);

  const baseCurrency = detectBaseCurrency(operations);

  // Świeżość notowań, na których policzono ten widok — czysty odczyt z cache'u
  // (wszystko, co miało być pobrane, jest już na miejscu). Stąd klient bierze
  // tempo odpytywania, zamiast pytać co 15 min niezależnie od stanu rynku.
  const freshness = summarizeQuoteFreshness(positions.map((p) => p.ticker));

  return {
    positions,
    cashPositions,
    totalValuePln,
    stocksValuePln,
    cashValuePln,
    recentSplits,
    recentSpinOffs,
    // Wykryte, ale czekające na ratio z SEC (czysty odczyt z DB — refresh
    // tabeli zdarzeń wykonał się już w applierze powyżej)
    pendingRatioSpinOffs: getPendingRatioSpinOffs(pid, tickerMap),
    // Nadchodzące publikacje wyników — czysty odczyt z kalendarza (bez sieci).
    // Ta funkcja obsługuje też widok publiczny, więc nie może na nic czekać;
    // odświeżanie źródeł chodzi z timerów w index.ts.
    upcomingEarnings: getEarningsCalendarService().getUpcomingForPositions(positions),
    baseCurrency,
    quotes: {
      asOf: freshness.asOf,
      nextRefreshAt: new Date(Date.now() + freshness.ttlSeconds * 1000).toISOString(),
      marketOpen: freshness.marketOpen,
    },
  };
}
