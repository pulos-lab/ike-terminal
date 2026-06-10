import {
  BENCHMARKS,
  DEFAULT_FX_PLN,
  type BenchmarkKey,
  type DetectedSplit,
  type PortfolioHistoryResponse,
  type PortfolioPositionsResponse,
} from 'shared';
import { getAllTransactions } from '../db/transactions-repo.js';
import { getAllOperations, getMetadata, setMetadata } from '../db/operations-repo.js';
import { getTickerMap, getAllTickers, updateTickerSectors } from '../db/ticker-map-repo.js';
import { getSplits, upsertSplits } from '../db/splits-repo.js';
import { bumpPortfolioDataVersion } from '../db/data-version.js';
import { invalidateCachedPrices } from './history-cache.js';
import { fetchFxRate } from './yahoo-finance.js';
import { resolveSector } from './sector-resolver.js';
import {
  computeOpenPositions,
  computeCashBalances,
  detectBaseCurrency,
} from './portfolio-engine.js';
import { computePortfolioHistoryMemoized } from './history-memo.js';

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
    // `sector` z Yahoo GICS (po angielsku) nie jest już autorytatywny.
    const toUpdate = entries.filter((e) => !e.supersector);
    for (const entry of toUpdate) {
      try {
        const { supersector, subsector } = await resolveSector(entry);
        if (supersector || subsector) {
          updateTickerSectors(entry.isin, supersector, subsector, pid);
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
  );

  if (result.detectedSplits.length > 0) {
    persistNewSplits(pid, result.detectedSplits, savedSplits);
  }

  return { history: result.history, metrics: result.metrics, baseCurrency };
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

  // Sieciowa detekcja splitów (cache-bypass do Yahoo) odpala się raz na dobę
  // per portfel — wykrycia są persystowane, więc częstszy skan tylko mnoży
  // niecache'owane requesty (ryzyko rate-limitu) bez nowych informacji.
  const todayStr = new Date().toISOString().split('T')[0];
  const splitScanDue = getMetadata(pid, 'last_split_scan') !== todayStr;

  const {
    positions,
    totalValuePln: stocksValuePln,
    detectedSplits,
  } = await computeOpenPositions(transactions, tickerMap, savedSplits, undefined, {
    skipSplitDetection: !splitScanDue,
  });
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
    .filter(([, balance]) => balance > 0.01) // only positive cash
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

  const baseCurrency = detectBaseCurrency(operations);

  return {
    positions,
    cashPositions,
    totalValuePln,
    stocksValuePln,
    cashValuePln,
    recentSplits,
    baseCurrency,
  };
}
