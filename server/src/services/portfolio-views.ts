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
  isProvisionalStub,
} from '../db/ticker-map-repo.js';
import { getSplits, upsertSplits } from '../db/splits-repo.js';
import { getOptionContractsMap } from '../db/option-contracts-repo.js';
import { getSpinOffs } from '../db/spin-offs-repo.js';
import { bumpPortfolioDataVersion } from '../db/data-version.js';
import { invalidateCachedPrices } from './history-cache.js';
import { fetchFxRate } from './yahoo-finance.js';
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

/**
 * Widoki portfela (historia zwrotów, otwarte pozycje) wyciągnięte z handlerów
 * routes/portfolio.ts, żeby publiczne endpointy share mogły reużyć identyczną
 * logikę (łącznie z memoizacją i persystencją splitów) bez duplikacji.
 * Side-effecty są idempotentne i wewnętrznie rate-limitowane (backfill sektorów
 * raz per proces, skan splitów raz na dobę) — bezpieczne też przy ruchu anonimowym.
 */

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
 * Spin-offy do badge'a "skąd wzięła się ta pozycja" (30 dni — rzadsze niż
 * splity, wyjaśnienie powinno wisieć dłużej). Okno liczone od ex-date LUB od
 * ZASTOSOWANIA: zdarzenie dodane do mapy po miesiącach (Syn2bio: ex 2026-04-02,
 * wpis w mapie 2026-07-08) aplikuje się długo po ex — pozycja dziecka pojawia
 * się użytkownikowi dopiero przy aplikacji i wtedy badge musi być widoczny.
 * Eksport dla testów; `now` wstrzykiwane wyłącznie testowo.
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
  const monthAgo = new Date(now);
  monthAgo.setDate(monthAgo.getDate() - 30);
  const monthAgoStr = monthAgo.toISOString().split('T')[0];
  return spinOffs
    .filter(
      (s) =>
        s.status === 'applied' &&
        (s.exDate >= monthAgoStr || (s.appliedAt ?? '').slice(0, 10) >= monthAgoStr),
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

/** In-memory flag: per-portfolio dedupe dla lazy-sector-backfill.
 *  Uruchamiamy backfill tylko raz per proces na portfel — wystarczy żeby
 *  nadrobić brakujące sektory po upgradzie kodu. Yahoo assetProfile i tak
 *  cache'uje wyniki 7 dni, więc powtórne uruchomienia są tanie, ale dedupe
 *  oszczędza I/O i chroni przed rate-limitem. */
const sectorsBackfilledForPortfolio = new Set<string>();

async function lazyBackfillSectors(pid: string): Promise<void> {
  if (sectorsBackfilledForPortfolio.has(pid)) return;
  sectorsBackfilledForPortfolio.add(pid);
  try {
    const entries = getAllTickers(pid);
    // Backfill gdy brak supersektora — po zmianie taksonomii (stockwatch) stary
    // `sector` z Yahoo GICS (po angielsku) nie jest już autorytatywny — lub gdy
    // brak kraju siedziby (pole `country` dodane później niż sektory).
    // Opcje (pseudo-ISIN OPT:...) nie mają sektora — pomijamy zbędne strzały do Yahoo.
    const toUpdate = entries.filter(
      (e) => (!e.supersector || !e.country) && !e.isin.startsWith('OPT:'),
    );
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
    sectorsBackfilledForPortfolio.delete(pid); // pozwól na retry przy następnym requeście
  }
}

/** Lazy re-resolucja debiutowych stubów w tle.
 *
 * Gdy import nie mógł jeszcze rozpoznać ISIN-u świeżo zadebiutowanej spółki
 * (brak w Yahoo/BiznesRadar/Stooq), zapisuje prowizoryczny stub (patrz
 * `isProvisionalStub`). Ten pass ponawia rozpoznanie w tle przy ładowaniu
 * pozycji — bez ręcznego re-importu — więc debiut sam się goi, gdy źródło
 * zacznie go listować. `resolveUnknownIsins` traktuje stuby jak nierozwiązane i
 * nadpisuje je prawdziwym tickerem przy sukcesie (kotwica ich nie chroni).
 *
 * Rate-limit: max raz na `STUB_RESOLVE_RETRY_MS` per portfel, z guardem in-flight
 * przeciw równoległym przebiegom. W przeciwieństwie do backfillu sektorów jest
 * CZASOWY, nie „raz per proces" — debiut nierozpoznany przy pierwszej próbie
 * dostaje kolejne szanse w tym samym procesie serwera. */
const stubResolveAttemptAt = new Map<string, number>();
const stubResolveInFlight = new Set<string>();
export const STUB_RESOLVE_RETRY_MS = 6 * 60 * 60 * 1000; // 6h

/** Czysta decyzja throttlingu — wydzielona, żeby dała się deterministycznie
 *  przetestować bez sieci. */
export function shouldResolveStubs(
  hasStubs: boolean,
  lastAttemptMs: number | undefined,
  inFlight: boolean,
  nowMs: number,
): boolean {
  if (!hasStubs || inFlight) return false;
  if (lastAttemptMs !== undefined && nowMs - lastAttemptMs < STUB_RESOLVE_RETRY_MS) return false;
  return true;
}

async function lazyResolveProvisionalStubs(pid: string): Promise<void> {
  const stubs = getAllTickers(pid).filter((e) => isProvisionalStub(e));
  if (
    !shouldResolveStubs(
      stubs.length > 0,
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
    const stubIsins = new Set(stubs.map((s) => s.isin));
    // Rozpoznajemy na podstawie PRAWDZIWYCH transakcji (poprawny paperName /
    // waluta / kategoria), nie pól stuba (te mają zaszyte GPW/PLN).
    const stubTxs = getAllTransactions(pid).filter((t) => stubIsins.has(t.isin));
    if (stubTxs.length > 0) {
      const { resolved } = await resolveUnknownIsins(stubTxs, pid);
      if (resolved.length > 0) {
        console.log(`Lazy stub resolve: zagojono ${resolved.length} debiutowych tickerów (${pid})`);
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

  return { history: result.history, metrics: result.metrics, baseCurrency, riskFreeRatePct };
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
    pendingRatioSpinOffs: getPendingRatioSpinOffs(tickerMap),
    baseCurrency,
  };
}
