import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { getDb } from '../db/connection.js';
import {
  getAllTransactions,
  getTransactionById,
  insertTransaction,
  updateTransaction,
  deleteTransaction,
  deleteTransactions,
  getTransactionsByIds,
  insertTransactionsWithDedup,
} from '../db/transactions-repo.js';
import {
  getAllOperations,
  getOperationsByType,
  getOperationsByTypes,
  insertOperation,
  insertOperations,
  updateOperation,
  deleteOperation,
  getOperationById,
  getMetadata,
  setMetadata,
} from '../db/operations-repo.js';
import {
  getTickerMap,
  getTickerBySymbol,
  upsertTickerMapEntry,
  getAllTickers,
  updateTickerSectors,
} from '../db/ticker-map-repo.js';
import { resolveSector } from '../services/sector-resolver.js';
import { getSplits, upsertSplits, deleteSplit as deleteSplitFromDb } from '../db/splits-repo.js';
import type {
  DividendInput,
  DepositInput,
  Transaction,
  TransactionInput,
  TickerMapEntry,
  FxExchangeInput,
  StockSplitInput,
  DetectedSplit,
  UpcomingDividend,
} from 'shared';
import { DEFAULT_FX_PLN } from 'shared';
import { invalidateCachedPrices } from '../services/history-cache.js';
import {
  fetchYahooPrice,
  fetchFxRate,
  fetchDividendCalendar,
  fetchYahooHistory,
} from '../services/yahoo-finance.js';
import {
  computeOpenPositions,
  computeClosedTrades,
  extractDividends,
  extractFxExchanges,
  computeCashFlow,
  computeCashFlowChartData,
  computeXirr,
  computeCashBalances,
  detectBaseCurrency,
  computeFxImpact,
  computeFifoMatching,
  computeSmartDeletePlan,
} from '../services/portfolio-engine.js';
import { BENCHMARKS, type BenchmarkKey } from 'shared';
import { computePortfolioHistoryMemoized } from '../services/history-memo.js';
import { bumpPortfolioDataVersion } from '../db/data-version.js';
import { searchTickers, fetchYahooTickerName } from '../services/ticker-search.js';
import { scanDividends } from '../services/dividend-scanner.js';

const router = Router();

/** Load saved splits from DB and convert to DetectedSplit format for the engine. */
function loadSplitsForEngine(pid: string): DetectedSplit[] {
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

// GET /api/portfolio/positions
router.get(
  '/positions',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
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

    // Persist any newly detected splits and invalidate stale price cache
    if (detectedSplits.length > savedSplits.length) {
      const newSplits = detectedSplits.filter(
        (ds) => !savedSplits.some((ss) => ss.isin === ds.isin && ss.date === ds.date),
      );
      upsertSplits(
        pid,
        detectedSplits.map((s) => ({
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
      // Bump tylko dla FAKTYCZNIE nowych wykryć (upsertSplits leci też dla już
      // zapisanych splitów przy każdym requeście — bump wtedy zabiłby cache).
      if (newSplits.length > 0) bumpPortfolioDataVersion(pid);
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

    res.json({
      positions,
      cashPositions,
      totalValuePln,
      stocksValuePln,
      cashValuePln,
      recentSplits,
      baseCurrency,
    });
  }),
);

// GET /api/portfolio/closed-trades
router.get(
  '/closed-trades',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
    const transactions = getAllTransactions(pid);
    const tickerMap = getTickerMap(pid);
    const operations = getAllOperations(pid);
    const savedSplits = loadSplitsForEngine(pid);
    const trades = computeClosedTrades(transactions, tickerMap, operations, savedSplits);
    res.json({ trades });
  }),
);

// GET /api/portfolio/dividends
router.get(
  '/dividends',
  asyncHandler(async (req, res) => {
    const operations = getAllOperations(req.portfolioId);
    const dividends = extractDividends(operations);
    const totalPln = dividends
      .filter((d) => d.currency === 'PLN')
      .reduce((s, d) => s + d.amount, 0);
    const totalUsd = dividends
      .filter((d) => d.currency === 'USD')
      .reduce((s, d) => s + d.amount, 0);
    res.json({ dividends, totalPln, totalUsd });
  }),
);

// POST /api/portfolio/dividends
router.post(
  '/dividends',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const { date, ticker, amount, currency } = req.body as DividendInput;
    if (!date || !ticker || !amount || !currency) {
      return res.status(400).json({ error: 'Wymagane pola: date, ticker, amount, currency' });
    }
    const id = insertOperation(
      {
        date,
        operationType: 'dividend',
        description: `Wypłata dywidendy ${ticker.toUpperCase()}`,
        amount,
        currency,
        ticker: ticker.toUpperCase(),
        source: 'manual',
      },
      pid,
    );
    res.json({ id });
  }),
);

// PUT /api/portfolio/dividends/:id
// Editable sources: 'manual' and 'auto-yahoo' only. Broker imports stay locked
// (CSV/XLSX is the source of truth). Editing an auto-yahoo entry flips its source
// to 'manual' as the "edited" marker — the rich original description is preserved.
router.put(
  '/dividends/:id',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getOperationById(id, pid);
    if (!existing || existing.operationType !== 'dividend') {
      return res.status(404).json({ error: 'Dywidenda nie znaleziona' });
    }
    if (existing.source !== 'manual' && existing.source !== 'auto-yahoo') {
      return res.status(403).json({ error: 'Importy z brokerów są nieedytowalne' });
    }
    const { date, ticker, amount, currency, description } = req.body as DividendInput;
    const newTicker = ticker?.toUpperCase() || existing.ticker;
    const tickerChanged = newTicker !== existing.ticker;
    const newDescription =
      description !== undefined
        ? description
        : tickerChanged
          ? `Wypłata dywidendy ${newTicker}`
          : existing.description;
    const updated = updateOperation(
      id,
      {
        date: date || existing.date,
        amount: amount ?? existing.amount,
        currency: currency || existing.currency,
        ticker: newTicker,
        description: newDescription,
        source: existing.source === 'auto-yahoo' ? 'manual' : existing.source,
      },
      pid,
    );
    if (!updated) {
      return res.status(500).json({ error: 'Nie udało się zaktualizować' });
    }
    res.json({ success: true });
  }),
);

// DELETE /api/portfolio/dividends/:id
// Same source whitelist as PUT — broker imports are protected.
router.delete(
  '/dividends/:id',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getOperationById(id, pid);
    if (!existing || existing.operationType !== 'dividend') {
      return res.status(404).json({ error: 'Dywidenda nie znaleziona' });
    }
    if (existing.source !== 'manual' && existing.source !== 'auto-yahoo') {
      return res.status(403).json({ error: 'Importy z brokerów są nieedytowalne' });
    }
    const deleted = deleteOperation(id, pid);
    if (!deleted) {
      return res.status(500).json({ error: 'Nie udało się usunąć' });
    }
    res.json({ success: true });
  }),
);

// POST /api/portfolio/dividends/scan — trigger manual dividend scan
router.post(
  '/dividends/scan',
  asyncHandler(async (req, res) => {
    const result = await scanDividends(req.portfolioId);
    res.json(result);
  }),
);

// GET /api/portfolio/dividends/upcoming — upcoming dividends from v10 calendar
router.get(
  '/dividends/upcoming',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
    const transactions = getAllTransactions(pid);
    const tickerMap = getTickerMap(pid);
    const splits = loadSplitsForEngine(pid);
    // skipSplitDetection: ten endpoint nie persystuje wykrytych splitów —
    // detekcję robi (i zapisuje) /positions w swoim dobowym oknie skanu.
    const { positions } = await computeOpenPositions(transactions, tickerMap, splits, undefined, {
      skipSplitDetection: true,
    });

    const today = new Date().toISOString().split('T')[0];
    const upcoming: UpcomingDividend[] = [];

    for (const pos of positions) {
      if (pos.shares <= 0) continue;
      if (pos.exchange === 'NC') continue;

      try {
        const cal = await fetchDividendCalendar(pos.ticker);
        if (!cal?.exDividendDate) continue;

        // Include if ex-date is upcoming OR payment is still pending
        const isUpcoming = cal.exDividendDate >= today;
        const isPendingPayment =
          cal.paymentDate && cal.paymentDate >= today && cal.exDividendDate < today;

        if (!isUpcoming && !isPendingPayment) continue;

        // Estimate per-share amount from annual rate and frequency
        // Most stocks pay quarterly (4x/year), some semi-annual (2x), some annual (1x)
        const annualRate = cal.dividendRate ?? 0;
        // Heuristic: use rate/2 for semi-annual, rate/4 for quarterly
        // Without frequency info, approximate as the latest single payment
        const perShare = annualRate > 0 ? annualRate / 2 : null;

        upcoming.push({
          ticker: pos.ticker,
          name: pos.paperName,
          exDividendDate: cal.exDividendDate,
          paymentDate: cal.paymentDate,
          estimatedAmount: perShare ? Math.round(perShare * pos.shares * 100) / 100 : 0,
          currency: pos.currency,
          shares: pos.shares,
          dividendPerShare: perShare,
          dividendYield: cal.dividendYield,
        });
      } catch (err) {
        // Skip ticker on error
      }
    }

    upcoming.sort((a, b) => a.exDividendDate.localeCompare(b.exDividendDate));
    res.json({ upcoming });
  }),
);

// GET /api/portfolio/fees — returns fee operations (interest, payment charges, etc.)
// Zachowane dla backward compat (panel CostsPage zostanie usunięty, ale endpoint jest
// taniutki do utrzymania i mógłby być konsumowany przez przyszłe integracje).
router.get(
  '/fees',
  asyncHandler((req, res) => {
    const fees = getOperationsByType('fee', req.portfolioId)
      .map((op) => ({
        id: op.id,
        date: op.date,
        amount: op.amount,
        currency: op.currency,
        description: op.description,
        source: op.source,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    const total = fees.reduce((s, f) => s + f.amount, 0);
    res.json({ fees, total });
  }),
);

// GET /api/portfolio/additional-costs — ujednolicony endpoint dla sekcji "Dodatkowe koszty"
// w panelu "Korekty i koszty". Zwraca wszystkie operacje nie-kapitałowe / nie-dywidendowe /
// nie-wpłatowe: fee, trade_fee, commission_refund, other. Każda kategoria ma osobne totals,
// a frontend pokazuje je w jednej tabeli z badge'ami per kategoria.
//
// Dlaczego to istnieje: przed P18 commission_refund (90 wpisów w portfelu sda, +800 PLN) oraz
// trade_fee (XTB swap/rollover) nie miały żadnego widoku w UI — były w DB ale niewidoczne.
// Ten endpoint zamyka tę lukę. Engine dalej traktuje je tak samo (wchodzą w cash balance,
// nie w MWR).
router.get(
  '/additional-costs',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const operations = getOperationsByTypes(['fee', 'trade_fee', 'commission_refund', 'other'], pid)
      .map((op) => ({
        id: op.id,
        date: op.date,
        category: op.operationType as 'fee' | 'trade_fee' | 'commission_refund' | 'other',
        subkind: op.subkind,
        ticker: op.ticker,
        amount: op.amount,
        currency: op.currency,
        description: op.description,
        source: op.source,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    const totals = { fees: 0, commissionRefunds: 0, tradeFees: 0, other: 0, grandTotal: 0 };
    for (const o of operations) {
      totals.grandTotal += o.amount;
      switch (o.category) {
        case 'fee':
          totals.fees += o.amount;
          break;
        case 'commission_refund':
          totals.commissionRefunds += o.amount;
          break;
        case 'trade_fee':
          totals.tradeFees += o.amount;
          break;
        case 'other':
          totals.other += o.amount;
          break;
      }
    }

    // Base currency = jedyna waluta wpłat/wypłat lub PLN fallback. UI używa tego do
    // wyświetlenia sum na kaflach w odpowiedniej walucie (XTB USD sub-account → USD, nie PLN).
    const baseCurrency = detectBaseCurrency(getAllOperations(pid));

    res.json({ operations, totals, baseCurrency });
  }),
);

// POST /api/portfolio/additional-costs — ręczne dodanie operacji do panelu
// "Pozostałe przepływy". Source='manual' żeby odróżnić od importowanych.
//
// UI-level kategoria "Odsetki" jest mapowana na operation_type='other' + subkind='interest'
// (tak samo jak zrobi to parser XTB w follow-up dla rzeczywistych "Free funds interest").
// Dzięki temu silnik traktuje odsetki jak inne `other` (cash balance tak, MWR nie), a UI
// odróżnia je po subkind żeby pokazać zielony badge.
router.post(
  '/additional-costs',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const { date, category, amount, currency, description, subkind } = req.body as {
      date?: string;
      category?: 'fee' | 'trade_fee' | 'commission_refund' | 'other';
      amount?: number;
      currency?: string;
      description?: string;
      subkind?: string;
    };

    if (!date) return res.status(400).json({ error: 'Wymagane pole: date' });
    if (!category || !['fee', 'trade_fee', 'commission_refund', 'other'].includes(category)) {
      return res
        .status(400)
        .json({ error: 'category musi być jednym z: fee, trade_fee, commission_refund, other' });
    }
    if (typeof amount !== 'number' || !isFinite(amount) || amount === 0) {
      return res
        .status(400)
        .json({ error: 'amount musi być liczbą różną od 0 (dodatnia = wpływ, ujemna = wypływ)' });
    }
    // Tylko wartości subkind używane w "Pozostałych przepływach" — `interest` dla odsetek
    // na other (inne dozwolone subkindy są zarezerwowane dla capital_return / pending).
    const allowedSubkinds = ['interest'];
    const effectiveSubkind = subkind && allowedSubkinds.includes(subkind) ? subkind : undefined;

    const cur = (currency || 'PLN').toUpperCase();
    const desc = description?.trim() || labelForCategory(category, effectiveSubkind);

    const id = insertOperation(
      {
        date,
        operationType: category,
        description: desc,
        amount,
        currency: cur,
        source: 'manual',
        subkind: effectiveSubkind as 'interest' | undefined,
      },
      pid,
    );

    res.json({ id });
  }),
);

// DELETE /api/portfolio/additional-costs/:id — usuń ręcznie dodaną operację.
// Blokujemy kasowanie operacji z importu (source != 'manual') żeby user nie sprzątał
// rekordów pochodzących z CSV — do tego celu powinien usunąć cały import.
router.delete(
  '/additional-costs/:id',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getOperationById(id, pid);
    if (!existing) return res.status(404).json({ error: 'Operacja nie znaleziona' });

    const allowedTypes = ['fee', 'trade_fee', 'commission_refund', 'other'];
    if (!allowedTypes.includes(existing.operationType)) {
      return res
        .status(400)
        .json({ error: 'Nie można usunąć: to nie jest operacja z Pozostałych przepływów' });
    }
    if (existing.source !== 'manual') {
      return res
        .status(403)
        .json({ error: 'Nie można usunąć operacji z importu — usuń cały import żeby ją skasować' });
    }

    const deleted = deleteOperation(id, pid);
    if (!deleted) return res.status(500).json({ error: 'Nie udało się usunąć' });
    res.json({ success: true });
  }),
);

// Helper — domyślny opis gdy user nie wpisał własnego (dla ręcznie dodawanej operacji).
function labelForCategory(
  cat: 'fee' | 'trade_fee' | 'commission_refund' | 'other',
  subkind?: string,
): string {
  if (cat === 'fee') return 'Opłata';
  if (cat === 'commission_refund') return 'Zwrot prowizji';
  if (cat === 'trade_fee') return 'Podatek transakcyjny';
  if (cat === 'other' && subkind === 'interest') return 'Odsetki od wolnych środków';
  return 'Inne';
}

// GET /api/portfolio/deposits — returns deposits + withdrawals
router.get(
  '/deposits',
  asyncHandler((req, res) => {
    const deposits = getOperationsByTypes(['deposit', 'withdrawal'], req.portfolioId)
      .map((op) => ({
        id: op.id,
        date: op.date,
        amount: op.amount,
        currency: op.currency,
        description: op.description,
        source: op.source,
        type: op.operationType as 'deposit' | 'withdrawal',
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    const total = deposits.reduce((s, d) => s + d.amount, 0);
    res.json({ deposits, total });
  }),
);

// POST /api/portfolio/deposits
router.post(
  '/deposits',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const { date, amount, type } = req.body as DepositInput & { type?: 'deposit' | 'withdrawal' };
    if (!date || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Wymagane pola: date, amount (> 0)' });
    }
    const isWithdrawal = type === 'withdrawal';
    const id = insertOperation(
      {
        date,
        operationType: isWithdrawal ? 'withdrawal' : 'deposit',
        description: isWithdrawal ? 'Wypłata' : 'Wpłata',
        amount: isWithdrawal ? -amount : amount,
        currency: 'PLN',
        source: 'manual',
      },
      pid,
    );
    res.json({ id });
  }),
);

// PUT /api/portfolio/deposits/:id
router.put(
  '/deposits/:id',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getOperationById(id, pid);
    if (
      !existing ||
      (existing.operationType !== 'deposit' && existing.operationType !== 'withdrawal')
    ) {
      return res.status(404).json({ error: 'Operacja nie znaleziona' });
    }
    const { date, amount } = req.body as Partial<DepositInput>;
    const updates: any = {};
    if (date) updates.date = date;
    if (amount !== undefined && amount > 0) {
      updates.amount = existing.operationType === 'withdrawal' ? -amount : amount;
    }
    const updated = updateOperation(id, updates, pid);
    if (!updated) {
      return res.status(500).json({ error: 'Nie udało się zaktualizować' });
    }
    res.json({ success: true });
  }),
);

// DELETE /api/portfolio/deposits/:id
router.delete(
  '/deposits/:id',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getOperationById(id, pid);
    if (
      !existing ||
      (existing.operationType !== 'deposit' && existing.operationType !== 'withdrawal')
    ) {
      return res.status(404).json({ error: 'Operacja nie znaleziona' });
    }
    const deleted = deleteOperation(id, pid);
    if (!deleted) {
      return res.status(500).json({ error: 'Nie udało się usunąć' });
    }
    res.json({ success: true });
  }),
);

// ─── Corporate actions (capital_return + corporate_action_pending) ───────────
// P17: zdarzenia korporacyjne — zwrot kapitału (obniżenie nominału, wyrównanie wykupu) oraz
// niedomknięte zdarzenia pending (nieznane wezwania skupu / wyrównania PW). Parser Bossy
// wstawia je automatycznie; tu tylko read + manual resolve pending → synthetic SELL.

// GET /api/portfolio/corporate-actions
router.get(
  '/corporate-actions',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const actions = getOperationsByTypes(['capital_return', 'corporate_action_pending'], pid)
      .map((op) => ({
        id: op.id,
        date: op.date,
        operationType: op.operationType as 'capital_return' | 'corporate_action_pending',
        subkind: op.subkind,
        ticker: op.ticker,
        amount: op.amount,
        currency: op.currency,
        description: op.description,
        source: op.source,
        status:
          op.operationType === 'capital_return'
            ? 'resolved'
            : ('pending' as 'resolved' | 'pending'),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    const totals = {
      capitalReturn: actions
        .filter((a) => a.operationType === 'capital_return')
        .reduce((s, a) => s + a.amount, 0),
      pendingCount: actions.filter((a) => a.operationType === 'corporate_action_pending').length,
    };
    const baseCurrency = detectBaseCurrency(getAllOperations(pid));
    res.json({ actions, totals, baseCurrency });
  }),
);

// POST /api/portfolio/corporate-actions/:id/resolve — domknij pending przez synthetic SELL
router.post(
  '/corporate-actions/:id/resolve',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getOperationById(id, pid);
    if (!existing || existing.operationType !== 'corporate_action_pending') {
      return res.status(404).json({ error: 'Zdarzenie pending nie znalezione' });
    }

    const { quantity, price, ticker, isin } = req.body as {
      quantity?: number;
      price?: number;
      ticker?: string;
      isin?: string;
    };
    if (!quantity || !price || quantity <= 0 || price <= 0) {
      return res.status(400).json({ error: 'Wymagane pola: quantity (>0), price (>0)' });
    }

    const targetTicker = ticker?.trim() || existing.ticker || '';
    if (!targetTicker) {
      return res
        .status(400)
        .json({ error: 'Brak tickera — dostarcz w body albo w operacji pending' });
    }

    // Znajdź ISIN z historii transakcji (po paperName = ticker z Bossa). User może też podać ręcznie.
    let targetIsin = isin?.trim() || '';
    if (!targetIsin) {
      const existingTx = getAllTransactions(pid).find((t) => t.paperName === targetTicker);
      if (existingTx) targetIsin = existingTx.isin;
    }
    if (!targetIsin) {
      return res.status(400).json({
        error: `Nie znaleziono ISIN dla tickera "${targetTicker}" w historii transakcji. Podaj ISIN ręcznie w body.`,
      });
    }

    // Synthetic SELL na dacie zdarzenia pending. Kwota brutto z operacji jest użyta jako `value`
    // i `total` (brak prowizji — user może potem edytować ręcznie jeśli trzeba).
    const syntheticSell = {
      date: existing.date,
      paperName: targetTicker,
      isin: targetIsin,
      quantity,
      side: 'S' as const,
      price,
      value: existing.amount,
      commission: 0,
      total: existing.amount,
      currency: existing.currency,
      paymentCurrency: 'PLN',
      source: 'bossa' as const,
      syntheticOrigin: `Domknięcie: ${existing.description} — ${quantity} szt @ ${price.toFixed(2)} ${existing.currency} (ręczne domknięcie przez user)`,
    };
    const insertResult = insertTransactionsWithDedup([syntheticSell], pid);

    // Usuwamy operację pending tylko gdy synthetic SELL faktycznie wszedł — inaczej
    // (dedupe = duplikat) cash inflow nie ma reprezentacji w transakcjach i usunięcie
    // operacji zgubiłoby go bezpowrotnie. Operacja zostaje, user widzi info o duplikacie.
    const operationDeleted = insertResult.inserted > 0;
    if (operationDeleted) {
      // Cash inflow jest teraz reprezentowany przez synthetic SELL
      // (przez transactionsCashFlow w engine).
      deleteOperation(id, pid);
    }

    res.json({
      success: true,
      transactionsInserted: insertResult.inserted,
      duplicates: insertResult.duplicates.length,
      operationDeleted,
    });
  }),
);

// DELETE /api/portfolio/corporate-actions/:id — ręczne usunięcie (np. omyłkowo zaimportowane)
router.delete(
  '/corporate-actions/:id',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getOperationById(id, pid);
    if (
      !existing ||
      (existing.operationType !== 'capital_return' &&
        existing.operationType !== 'corporate_action_pending')
    ) {
      return res.status(404).json({ error: 'Zdarzenie korporacyjne nie znalezione' });
    }
    const deleted = deleteOperation(id, pid);
    if (!deleted) return res.status(500).json({ error: 'Nie udało się usunąć' });
    res.json({ success: true });
  }),
);

// GET /api/portfolio/ticker-search
router.get(
  '/ticker-search',
  asyncHandler(async (req, res) => {
    const q = ((req.query.q as string) || '').trim().slice(0, 50);
    if (!q || q.length < 1) {
      return res.json([]);
    }
    const results = await searchTickers(q);
    res.json(results);
  }),
);

// GET /api/portfolio/ticker-info?symbol=X
// Lekki lookup waluty + nazwy pojedynczego tickera — używany przez AddTransactionDialog
// po debounce, gdy user wpisuje ticker bez wyboru z listy autocomplete. Yahoo chart API
// nie zwraca nazwy, search nie zwraca currency — wewnątrz robimy oba calls równolegle.
router.get(
  '/ticker-info',
  asyncHandler(async (req, res) => {
    const symbol = ((req.query.symbol as string) || '').trim().slice(0, 50);
    if (!symbol) return res.json({ currency: null, name: null });
    const pid = req.portfolioId;

    // 1) lokalny ticker_map — najszybciej, bez sieci
    const entry = getTickerBySymbol(symbol, pid);
    if (entry?.currency) return res.json({ currency: entry.currency, name: entry.name });

    const up = symbol.toUpperCase();
    const isPolishSuffix = up.endsWith('.WA') || up.endsWith('.NC');

    // 2) Yahoo: price (currency) + search (name) w parallel. Cache obu warstw poniżej.
    const [yahoo, name] = await Promise.all([
      fetchYahooPrice(symbol),
      fetchYahooTickerName(symbol),
    ]);
    const currency = yahoo?.currency || (isPolishSuffix ? 'PLN' : null);
    res.json({ currency, name: name || null });
  }),
);

// GET /api/portfolio/fx-history
router.get(
  '/fx-history',
  asyncHandler(async (req, res) => {
    const operations = getAllOperations(req.portfolioId);
    const exchanges = extractFxExchanges(operations);
    res.json({ exchanges });
  }),
);

// POST /api/portfolio/fx-exchanges
router.post(
  '/fx-exchanges',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const { date, currencyFrom, currencyTo, amountFrom, rate } = req.body as FxExchangeInput;

    if (!date || !currencyFrom || !currencyTo || !amountFrom || !rate) {
      return res.status(400).json({ error: 'Wymagane pola: data, waluty, kwota, kurs' });
    }
    if (currencyFrom === currencyTo) {
      return res.status(400).json({ error: 'Waluty muszą być różne' });
    }
    if (amountFrom <= 0 || rate <= 0) {
      return res.status(400).json({ error: 'Kwota i kurs muszą być dodatnie' });
    }

    const amountTo = Math.round((amountFrom / rate) * 100) / 100;
    const pair = `${currencyFrom}/${currencyTo}`;
    const description = `Wymiana waluty ${pair} ${rate}`;

    const count = insertOperations(
      [
        {
          date,
          operationType: 'fx_exchange',
          description,
          amount: -amountFrom,
          currency: currencyFrom,
          fxRate: rate,
          fxPair: pair,
          source: 'manual',
        },
        {
          date,
          operationType: 'fx_exchange',
          description,
          amount: amountTo,
          currency: currencyTo,
          fxRate: rate,
          fxPair: pair,
          source: 'manual',
        },
      ],
      pid,
    );

    res.json({ success: true, operationsCreated: count });
  }),
);

// DELETE /api/portfolio/fx-exchanges/:fromId/:toId
router.delete(
  '/fx-exchanges/:fromId/:toId',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const fromId = parseInt(req.params.fromId);
    const toId = parseInt(req.params.toId);

    if (isNaN(fromId) || isNaN(toId)) {
      return res.status(400).json({ error: 'Nieprawidłowe ID operacji' });
    }

    const fromOp = getOperationById(fromId, pid);
    const toOp = getOperationById(toId, pid);

    if (
      !fromOp ||
      !toOp ||
      fromOp.operationType !== 'fx_exchange' ||
      toOp.operationType !== 'fx_exchange'
    ) {
      return res.status(404).json({ error: 'Operacje wymiany nie znalezione' });
    }

    deleteOperation(fromId, pid);
    deleteOperation(toId, pid);

    res.json({ success: true });
  }),
);

// POST /api/portfolio/history
router.post(
  '/history',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
    const { benchmark = 'sp500', startDate, endDate } = req.body;
    const benchConfig = BENCHMARKS[benchmark as BenchmarkKey];
    if (!benchConfig) {
      return res.status(400).json({ error: 'Invalid benchmark' });
    }

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

    // Persist any newly detected splits and invalidate stale price cache
    if (result.detectedSplits.length > 0) {
      const newSplits = result.detectedSplits.filter(
        (ds) => !savedSplits.some((ss) => ss.isin === ds.isin && ss.date === ds.date),
      );
      upsertSplits(
        pid,
        result.detectedSplits.map((s) => ({
          isin: s.isin,
          ticker: s.ticker,
          splitDate: s.date,
          ratio: s.ratio,
          source: s.source,
        })),
      );
      for (const s of newSplits) {
        invalidateCachedPrices(s.ticker);
      }
      // Nowe splity → unieważnij memo (zwracany result już je uwzględnia,
      // ale wpisy z innymi benchmarkami / starszą wersją muszą się przeliczyć).
      if (newSplits.length > 0) bumpPortfolioDataVersion(pid);
    }

    res.json({ history: result.history, metrics: result.metrics, baseCurrency });
  }),
);

// GET /api/portfolio/cash-flow
router.get(
  '/cash-flow',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
    const operations = getAllOperations(pid);
    const transactions = getAllTransactions(pid);
    const tickerMap = getTickerMap(pid);
    const savedSplits = loadSplitsForEngine(pid);

    const baseCurrency = detectBaseCurrency(operations);

    // Engine liczy history w baseCurrency — cumulativeDepositsPln/Withdrawals w
    // history points to już wartości w walucie bazowej. computeCashFlow nie
    // potrzebuje dodatkowej konwersji — dailyFxRates i baseCurrency tylko dla
    // backward-compat sygnatury (identity transform w base currency).
    const { history, dailyFxRates } = await computePortfolioHistoryMemoized(
      pid,
      transactions,
      operations,
      tickerMap,
      '^GSPC',
      'yahoo', // default benchmark, doesn't matter for cash flow
      savedSplits,
      baseCurrency,
    );

    const cashFlow = computeCashFlow(operations, history, dailyFxRates, baseCurrency);
    const chartData = computeCashFlowChartData(history, dailyFxRates, baseCurrency);
    res.json({ cashFlow, chartData, baseCurrency });
  }),
);

// POST /api/portfolio/ticker-map/refresh-sectors
// Backfill pól sector + supersector dla wszystkich entries w ticker_map aktywnego portfela.
// Kolejność źródeł: GPW_SECTOR_MAP (stockwatch, offline) → CFD_TICKER_MAP (offline) →
// Yahoo fetchAssetProfile (GICS → mapGicsToStockwatch → PL). Bezpieczne — aktualizuje
// tylko entries bez supersektora (nie nadpisuje ręcznie przypisanych).
router.post(
  '/ticker-map/refresh-sectors',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
    const entries = getAllTickers(pid);
    const toUpdate = entries.filter((e) => !e.supersector);

    let updatedCount = 0;
    const failed: string[] = [];

    for (const entry of toUpdate) {
      try {
        const { supersector, subsector } = await resolveSector(entry);
        if (supersector || subsector) {
          updateTickerSectors(entry.isin, supersector, subsector, pid);
          updatedCount++;
        } else {
          failed.push(entry.ticker);
        }
      } catch {
        failed.push(entry.ticker);
      }
    }

    res.json({
      total: entries.length,
      needingUpdate: toUpdate.length,
      updated: updatedCount,
      failed,
    });
  }),
);

// GET /api/portfolio/metrics
router.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
    const transactions = getAllTransactions(pid);
    const operations = getAllOperations(pid);
    const tickerMap = getTickerMap(pid);
    const savedSplits = loadSplitsForEngine(pid);

    const baseCurrency = detectBaseCurrency(operations);

    // KROK 1: Zbierz wszystkie obce waluty z portfela (ticker_map + transactions + cash)
    // i pre-fetchuj kursy FX RAZ. Mapa jest źródłem prawdy dla wszystkich obliczeń
    // poniżej (positions, cash conversion, fxImpact) — eliminuje dryf między
    // niezależnymi fetchami z których wcześniej wynikała niespójność na ekranie
    // (np. "Część zagraniczna" > "Wartość portfela" przez różne snapshoty cache).
    const cashBalances = computeCashBalances(transactions, operations);
    const allForeignCurrencies = new Set<string>();
    for (const entry of tickerMap.values()) {
      if (entry.currency) {
        const u = entry.currency.toUpperCase();
        if (u !== 'PLN') allForeignCurrencies.add(u === 'GBX' ? 'GBP' : u);
      }
    }
    for (const tx of transactions) {
      const u = tx.currency.toUpperCase();
      if (u !== 'PLN') allForeignCurrencies.add(u === 'GBX' ? 'GBP' : u);
    }
    for (const cur of Object.keys(cashBalances)) {
      const u = cur.toUpperCase();
      if (u !== 'PLN') allForeignCurrencies.add(u === 'GBX' ? 'GBP' : u);
    }
    const fxRatesObj: Record<string, number> = { PLN: 1 };
    const todayFxRatesToPln = new Map<string, number>();
    todayFxRatesToPln.set('PLN', 1);
    await Promise.all(
      [...allForeignCurrencies].map(async (cur) => {
        const rate = (await fetchFxRate(`${cur}PLN`)) || 0;
        if (rate > 0) {
          fxRatesObj[cur] = rate;
          todayFxRatesToPln.set(cur, rate);
        }
      }),
    );

    // KROK 2: history (close-of-day, dla wykresu/XIRR) + positions (LIVE, dla wartości
    // pokazywanej na ekranie) lecą równolegle. Positions dostaje pre-fetched FX.
    const [{ metrics }, { positions, totalValuePln: stocksValuePln }] = await Promise.all([
      computePortfolioHistoryMemoized(
        pid,
        transactions,
        operations,
        tickerMap,
        '^GSPC',
        'yahoo', // benchmark ticker nie wpływa na metrics
        savedSplits,
        baseCurrency,
      ),
      // skipSplitDetection: /metrics ignoruje detectedSplits — sieciowy skan
      // robi (i zapisuje) wyłącznie /positions w dobowym oknie.
      computeOpenPositions(transactions, tickerMap, savedSplits, fxRatesObj, {
        skipSplitDetection: true,
      }),
    ]);

    // KROK 3: foreignExposures (NATIVE) i exposurePlnByCurrency (z tych samych
    // pozycji co stocksValuePln, plus cash × ten sam FX). Gwarantuje:
    //   Σ exposurePlnByCurrency + część PLN = totalPortfolioValuePln
    // (tj. tooltip "Część zagraniczna" matematycznie pasuje do "Wartość portfela").
    const foreignExposures = new Map<string, number>();
    const exposurePlnByCurrency = new Map<string, number>();
    for (const pos of positions) {
      const cur = (pos.currency || 'PLN').toUpperCase();
      if (cur === 'PLN') continue;
      const curKey = cur === 'GBX' ? 'GBP' : cur;
      const native = pos.currentValue ?? 0;
      foreignExposures.set(curKey, (foreignExposures.get(curKey) ?? 0) + native);
      exposurePlnByCurrency.set(
        curKey,
        (exposurePlnByCurrency.get(curKey) ?? 0) + (pos.currentValuePln ?? 0),
      );
    }
    for (const [cur, balance] of Object.entries(cashBalances)) {
      const upperCur = cur.toUpperCase();
      if (upperCur === 'PLN') continue;
      if (balance > 0) {
        const curKey = upperCur === 'GBX' ? 'GBP' : upperCur;
        foreignExposures.set(curKey, (foreignExposures.get(curKey) ?? 0) + balance);
        const cashPln = balance * (todayFxRatesToPln.get(curKey) || 0);
        exposurePlnByCurrency.set(curKey, (exposurePlnByCurrency.get(curKey) ?? 0) + cashPln);
      }
    }

    // totalPortfolioValuePln = stocks (LIVE intraday × wspólny FX) + cash (PLN + obce × wspólny FX).
    let cashValuePln = 0;
    for (const [cur, balance] of Object.entries(cashBalances)) {
      const upperCur = cur.toUpperCase();
      if (upperCur === 'PLN') cashValuePln += balance;
      else {
        const curKey = upperCur === 'GBX' ? 'GBP' : upperCur;
        cashValuePln += balance * (todayFxRatesToPln.get(curKey) || 0);
      }
    }
    const totalPortfolioValuePln = stocksValuePln + cashValuePln;

    // Historical PLN rates dla cross-rate fx_exchange (np. DEGIRO USD↔EUR, gdzie
    // op.fxRate nie jest kursem vs PLN). Skanujemy operations dla cross-rate
    // credit legs (amount > 0, fxPair bez 'PLN'), zbieramy (currency, date) sets,
    // fetchujemy zakres historii z Yahoo per waluta, budujemy mapę którą engine
    // użyje jako proxy ("ile PLN kosztowałoby kupno waluty na rynku tego dnia").
    const crossRateDatesByCurrency = new Map<string, Set<string>>();
    for (const op of operations) {
      if (op.operationType !== 'fx_exchange') continue;
      if (op.amount <= 0) continue;
      if (!op.fxPair || op.fxPair.toUpperCase().includes('PLN')) continue;
      const cur = (op.currency || '').toUpperCase();
      if (!cur || cur === 'PLN') continue;
      const dates = crossRateDatesByCurrency.get(cur) ?? new Set<string>();
      dates.add(op.date.split('T')[0]);
      crossRateDatesByCurrency.set(cur, dates);
    }

    const historicalCrossRates = new Map<string, Map<string, number>>();
    if (crossRateDatesByCurrency.size > 0) {
      await Promise.all(
        [...crossRateDatesByCurrency.entries()].map(async ([cur, dates]) => {
          const sortedDates = [...dates].sort();
          const start = sortedDates[0];
          const end = sortedDates[sortedDates.length - 1];
          try {
            const history = await fetchYahooHistory(`${cur}PLN=X`, start, end);
            const dateToRate = new Map<string, number>();
            for (const d of history) dateToRate.set(d.date, d.close);
            for (const date of dates) {
              let rate = dateToRate.get(date);
              // Weekend/holiday fallback — najbliższa wcześniejsza data
              if (!rate) {
                const earlier = [...dateToRate.keys()]
                  .filter((d) => d <= date)
                  .sort()
                  .pop();
                if (earlier) rate = dateToRate.get(earlier);
              }
              if (rate && rate > 0) {
                let dateMap = historicalCrossRates.get(date);
                if (!dateMap) {
                  dateMap = new Map();
                  historicalCrossRates.set(date, dateMap);
                }
                dateMap.set(cur, rate);
              }
            }
          } catch {
            // Brak historii → cross-rate ops dla tej waluty pomijane (null plnPerX)
          }
        }),
      );
    }

    // Implied FX acquisitions — dla zakupów zagranicznych akcji rozliczanych przez
    // brokera bezpośrednio w PLN, gdzie nie ma explicit fx_exchange w bazie (typowy
    // scenariusz Bossa Zagranica: kupno CSU.TO/CAD płacone z PLN, broker konwertuje
    // wewnętrznie i nie eksponuje kursu w pliku importu).
    //
    // Warunek: tx.side='K' AND tx.currency='PLN' AND ticker_map.currency != 'PLN'.
    // Dla każdej takiej transakcji fetchujemy Yahoo historical native close cenę
    // na dacie transakcji i wyliczamy implied rate jako proxy:
    //   acquiredNative = qty × native_price       // ile waluty obcej "weszło" do portfela
    //   plnPaid = tx.value                        // ile PLN zapłacono (bez prowizji)
    // Engine sumuje to z acquisition events z `operations` (akumulacja, nie zamiana).
    type ImpliedTxBucket = { nativeCcy: string; dates: Set<string>; txs: Transaction[] };
    const impliedTxsByTicker = new Map<string, ImpliedTxBucket>();
    for (const tx of transactions) {
      if (tx.side !== 'K') continue;
      const settleCcy = (tx.currency || '').toUpperCase();
      if (settleCcy !== 'PLN') continue; // cross-rate (np. DEGIRO USD↔EUR) obsługiwane przez historicalCrossRates
      const entry = tickerMap.get(tx.isin);
      const yahooTicker = entry?.ticker;
      if (!yahooTicker) continue;
      const rawNative = (entry?.currency || '').toUpperCase();
      if (!rawNative || rawNative === 'PLN') continue; // akcja kwotowana w PLN — żaden implied rate niepotrzebny
      const nativeCcy = rawNative === 'GBX' ? 'GBP' : rawNative;
      let bucket = impliedTxsByTicker.get(yahooTicker);
      if (!bucket) {
        bucket = { nativeCcy, dates: new Set<string>(), txs: [] };
        impliedTxsByTicker.set(yahooTicker, bucket);
      }
      bucket.dates.add(tx.date.split('T')[0]);
      bucket.txs.push(tx);
    }

    const impliedAcquisitions = new Map<string, { acquiredNative: number; plnPaid: number }>();
    if (impliedTxsByTicker.size > 0) {
      await Promise.all(
        [...impliedTxsByTicker.entries()].map(async ([ticker, bucket]) => {
          const sortedDates = [...bucket.dates].sort();
          const start = sortedDates[0];
          const end = sortedDates[sortedDates.length - 1];
          try {
            const history = await fetchYahooHistory(ticker, start, end);
            const dateToPrice = new Map<string, number>();
            for (const d of history) dateToPrice.set(d.date, d.close);
            for (const tx of bucket.txs) {
              const date = tx.date.split('T')[0];
              let nativePrice = dateToPrice.get(date);
              if (!nativePrice) {
                // Weekend/holiday fallback — najbliższa wcześniejsza data
                const earlier = [...dateToPrice.keys()]
                  .filter((d) => d <= date)
                  .sort()
                  .pop();
                if (earlier) nativePrice = dateToPrice.get(earlier);
              }
              if (!nativePrice || nativePrice <= 0) continue;
              const acquiredNative = tx.quantity * nativePrice;
              const plnPaid = tx.value;
              if (acquiredNative <= 0 || plnPaid <= 0) continue;
              const cur = bucket.nativeCcy;
              const existing = impliedAcquisitions.get(cur) ?? { acquiredNative: 0, plnPaid: 0 };
              existing.acquiredNative += acquiredNative;
              existing.plnPaid += plnPaid;
              impliedAcquisitions.set(cur, existing);
            }
          } catch {
            // Brak historii → implied dla tego tickera pomijany; waluta dostanie
            // avgPlnPerCurrency=null w breakdown jeśli nie ma żadnego innego acquisition event.
          }
        }),
      );
    }

    const fxImpact = computeFxImpact(
      operations,
      foreignExposures,
      todayFxRatesToPln,
      totalPortfolioValuePln,
      historicalCrossRates,
      exposurePlnByCurrency,
      impliedAcquisitions,
    );

    // KROK 4: ujednolicenie wartości na ekranie. currentValue = LIVE wycena (ta sama
    // co w panelu Portfel i tooltipie "Wpływ walut"), nie close-of-day z engine.
    // totalReturn / totalReturnPct przeliczone z tej samej liczby, żeby topbar był
    // matematycznie spójny (Wartość − Wpłaty = Zysk).
    // XIRR pozostaje z engine — bazuje na historii close (stabilna linia).
    // Dla portfeli nie-PLN engine liczy w baseCurrency; pomijamy override i zostawiamy
    // metrics.currentValue (totalPortfolioValuePln zawsze w PLN).
    const useLiveValue = baseCurrency === 'PLN';
    const currentValue = useLiveValue ? totalPortfolioValuePln : metrics.currentValue;
    const totalReturn = useLiveValue
      ? totalPortfolioValuePln - (metrics.totalInvested || 0)
      : metrics.totalReturn;
    const totalReturnPct =
      useLiveValue && metrics.totalInvested > 0
        ? (totalReturn / metrics.totalInvested) * 100
        : metrics.totalReturnPct;

    res.json({
      currentValue,
      totalInvested: metrics.totalInvested,
      xirr: metrics.xirr,
      totalReturn,
      totalReturnPct,
      totalDividends: metrics.totalDividends,
      baseCurrency,
      fxImpact,
    });
  }),
);

// GET /api/portfolio/transactions
router.get(
  '/transactions',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const transactions = getAllTransactions(pid);
    const tickerMap = getTickerMap(pid);
    const enriched = transactions.map((tx) => {
      const entry = tickerMap.get(tx.isin);
      // PR15 (revised): Bossa/mBank CSV zapisują `waluta` = PLN dla WSZYSTKICH trade'ów
      // IKE/IKZE (auto-FX po stronie brokera). Z CSV nie rozróżnimy GPW od zagranicznego
      // auto-konwertowanego trade'u. Dlatego quote currency bierzemy z ticker_map (autorytet
      // dla waluty notowania papieru na jego macierzystej giełdzie).
      //
      //   - FIG (US) → ticker_map.currency = USD → kwotowanie=USD, zakup=PLN → glyph ⇋
      //   - NFLX (US) → USD / PLN → glyph ⇋
      //   - CDR.WA (PL) → PLN / PLN → brak glyph
      //   - GRX.AX (AU ISIN, dual-listed GPW) → ticker_map.currency=AUD → kwotowanie=AUD,
      //     zakup=PLN → glyph. (Note: ticker_map data quality issue dla dual-listings —
      //     osobny problem do rozwiązania przez ręczny override ticker_map.)
      //
      // Dla DEGIRO/XTB parser zapisał już jawnie `currency` = quote i `paymentCurrency` = base
      // account. Ufamy parserowi, ticker_map tylko jako fallback.
      const isPolishBroker = tx.source === 'bossa' || tx.source === 'mbank';
      const quoteCurrency = isPolishBroker
        ? entry?.currency || tx.currency || 'PLN'
        : tx.currency || entry?.currency || 'PLN';
      const paymentCurrency = tx.paymentCurrency || tx.currency;
      return {
        ...tx,
        ticker: entry?.ticker || tx.isin,
        name: entry?.name || tx.paperName,
        exchange: entry?.exchange || '',
        currency: quoteCurrency,
        paymentCurrency,
      };
    });
    res.json({ transactions: enriched });
  }),
);

// POST /api/portfolio/transactions
router.post(
  '/transactions',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
    const {
      date,
      ticker,
      side,
      quantity,
      price,
      commission,
      currency: overrideCurrency,
      paymentCurrency,
      fxRate,
      category,
    } = req.body as TransactionInput;
    if (!date || !ticker || !side || !quantity || price == null) {
      return res.status(400).json({ error: 'Wymagane pola: date, ticker, side, quantity, price' });
    }
    if (side !== 'K' && side !== 'S') {
      return res.status(400).json({ error: 'Pole side musi być K lub S' });
    }

    // Look up ticker in ticker_map
    let entry = getTickerBySymbol(ticker, pid);

    // If not found, try to auto-create from Yahoo. Fetch price + display name in parallel
    // so the new ticker_map entry doesn't fall back to the bare symbol (Yahoo chart API
    // doesn't return name, only currency — so we hit Yahoo search separately for longname).
    if (!entry) {
      const [yahooData, yahooName] = await Promise.all([
        fetchYahooPrice(ticker),
        fetchYahooTickerName(ticker),
      ]);
      if (!yahooData) {
        return res
          .status(400)
          .json({ error: `Nie znaleziono tickera: ${ticker}. Sprawdź symbol.` });
      }

      const upperTicker = ticker.toUpperCase();
      const newEntry: TickerMapEntry = {
        isin: `AUTO_${upperTicker}`,
        ticker: upperTicker,
        name: yahooName || upperTicker,
        exchange: 'OTHER',
        currency: overrideCurrency || yahooData.currency || 'USD',
        priceSource: 'yahoo',
      };

      // Try Stooq for .WA tickers
      if (upperTicker.endsWith('.WA')) {
        newEntry.exchange = 'GPW';
        newEntry.currency = overrideCurrency || 'PLN';
        newEntry.priceSource = 'stooq';
      }

      upsertTickerMapEntry(newEntry, pid);
      entry = newEntry;
    }

    const quoteCurrency = entry.currency;
    const value = quantity * price;
    const comm = commission || 0;
    const total = side === 'K' ? value + comm : value - comm;
    // Payment currency: explicit z body lub fallback na quote (brak przewalutowania).
    const effectivePaymentCurrency = paymentCurrency || quoteCurrency;
    // Sanity: jeśli waluty są równe, fxRate nieistotny — wyzeruj na undefined dla czystości.
    const effectiveFxRate =
      effectivePaymentCurrency !== quoteCurrency && fxRate && fxRate > 0 ? fxRate : undefined;

    const id = insertTransaction(
      {
        date,
        paperName: entry.name,
        isin: entry.isin,
        quantity,
        side,
        price,
        value,
        commission: comm,
        total,
        currency: quoteCurrency,
        paymentCurrency: effectivePaymentCurrency,
        fxRate: effectiveFxRate,
        category: category || 'stock',
        source: 'manual',
      },
      pid,
    );

    res.json({ id });
  }),
);

// PUT /api/portfolio/transactions/:id
router.put(
  '/transactions/:id',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getTransactionById(id, pid);
    if (!existing) {
      return res.status(404).json({ error: 'Transakcja nie znaleziona' });
    }

    const { date, ticker, side, quantity, price, commission, paymentCurrency, fxRate } =
      req.body as Partial<TransactionInput>;

    const updates: Partial<import('shared').Transaction> = {};
    if (date) updates.date = date;
    if (side) updates.side = side;
    if (quantity !== undefined) updates.quantity = quantity;
    if (price !== undefined) updates.price = price;
    if (commission !== undefined) updates.commission = commission;

    // If ticker changed, resolve to ISIN. Porównujemy z aktualnym tickerem
    // zamapowanym na existing.isin — NIE z samym ISIN-em (ticker nigdy nie równa się
    // ISIN-owi, więc tamto porównanie wymuszało re-resolve i potrafiło po cichu
    // nadpisać ISIN wpisem AUTO_<TICKER> przy każdej edycji).
    const currentTicker = getTickerMap(pid).get(existing.isin)?.ticker?.toUpperCase();
    if (ticker && ticker.toUpperCase() !== currentTicker) {
      let entry = getTickerBySymbol(ticker, pid);
      if (!entry) {
        const [yahooData, yahooName] = await Promise.all([
          fetchYahooPrice(ticker),
          fetchYahooTickerName(ticker),
        ]);
        if (!yahooData) {
          return res.status(400).json({ error: `Nie znaleziono tickera: ${ticker}` });
        }
        const upperTicker = ticker.toUpperCase();
        const newEntry: TickerMapEntry = {
          isin: `AUTO_${upperTicker}`,
          ticker: upperTicker,
          name: yahooName || upperTicker,
          exchange: 'OTHER',
          currency: yahooData.currency || 'USD',
          priceSource: 'yahoo',
        };
        if (upperTicker.endsWith('.WA')) {
          newEntry.exchange = 'GPW';
          newEntry.currency = 'PLN';
          newEntry.priceSource = 'stooq';
        }
        upsertTickerMapEntry(newEntry, pid);
        entry = newEntry;
      }
      updates.isin = entry.isin;
      updates.paperName = entry.name;
      updates.currency = entry.currency;
    }

    // Payment currency + FX rate (explicit edit). Quote currency = updates.currency lub existing.
    const effectiveCurrency = updates.currency ?? existing.currency;
    if (paymentCurrency !== undefined) {
      updates.paymentCurrency = paymentCurrency || effectiveCurrency;
    }
    if (fxRate !== undefined) {
      const finalPaymentCcy =
        updates.paymentCurrency ?? existing.paymentCurrency ?? effectiveCurrency;
      updates.fxRate = finalPaymentCcy !== effectiveCurrency && fxRate > 0 ? fxRate : undefined;
    }

    // Recalculate value/total if quantity or price changed
    const q = updates.quantity ?? existing.quantity;
    const p = updates.price ?? existing.price;
    const c = updates.commission ?? existing.commission;
    const s = updates.side ?? existing.side;
    updates.value = q * p;
    updates.total = s === 'K' ? updates.value + c : updates.value - c;

    const updated = updateTransaction(id, updates, pid);
    if (!updated) {
      return res.status(500).json({ error: 'Nie udało się zaktualizować' });
    }
    res.json({ success: true });
  }),
);

// DELETE /api/portfolio/transactions/:id
router.delete(
  '/transactions/:id',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getTransactionById(id, pid);
    if (!existing) {
      return res.status(404).json({ error: 'Transakcja nie znaleziona' });
    }
    const deleted = deleteTransaction(id, pid);
    if (!deleted) {
      return res.status(500).json({ error: 'Nie udało się usunąć' });
    }
    res.json({ success: true });
  }),
);

// POST /api/portfolio/transactions/bulk-delete
// Body: { ids: number[] }  — atomic delete (SQLite transaction)
router.post(
  '/transactions/bulk-delete',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const { ids } = req.body as { ids?: number[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Wymagane pole: ids (niepusta tablica).' });
    }
    const validIds = ids.filter((id) => typeof id === 'number' && Number.isFinite(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'Żaden z ID nie jest prawidłowy.' });
    }
    const existing = getTransactionsByIds(validIds, pid);
    if (existing.length !== validIds.length) {
      const foundIds = new Set(existing.map((t) => t.id));
      const missing = validIds.filter((id) => !foundIds.has(id));
      return res.status(404).json({ error: `Nie znaleziono transakcji: ${missing.join(', ')}` });
    }
    const deleted = deleteTransactions(validIds, pid);
    res.json({ success: true, deleted });
  }),
);

// GET /api/portfolio/transactions/fifo-matching?isin=XXX
// Zwraca FIFO-matching dla wszystkich transakcji danego ISIN — używane przez
// dialog smart-delete do wizualizacji par K↔S oraz do ostrzeżeń.
router.get(
  '/transactions/fifo-matching',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const isin = typeof req.query.isin === 'string' ? req.query.isin : null;
    if (!isin) {
      return res.status(400).json({ error: 'Wymagany parametr: isin' });
    }
    const transactions = getAllTransactions(pid);
    const tickerMap = getTickerMap(pid);
    const matching = computeFifoMatching(isin, transactions);
    const entry = tickerMap.get(isin);
    res.json({
      ...matching,
      ticker: entry?.ticker ?? isin,
      paperName: entry?.name ?? isin,
      currency: entry?.currency ?? matching.transactions[0]?.currency ?? 'PLN',
    });
  }),
);

// POST /api/portfolio/transactions/:id/smart-delete-preview
// Zwraca plan: które ID usunąć, które edytować (qty), oraz warnings/unsupported.
router.post(
  '/transactions/:id/smart-delete-preview',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getTransactionById(id, pid);
    if (!existing) {
      return res.status(404).json({ error: 'Transakcja nie znaleziona' });
    }
    const transactions = getAllTransactions(pid);
    const plan = computeSmartDeletePlan(id, transactions);
    res.json(plan);
  }),
);

// POST /api/portfolio/transactions/:id/smart-delete-apply
// Wylicza plan, stosuje atomowo (wszystkie deletes + edits w jednej SQL transakcji).
router.post(
  '/transactions/:id/smart-delete-apply',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const existing = getTransactionById(id, pid);
    if (!existing) {
      return res.status(404).json({ error: 'Transakcja nie znaleziona' });
    }
    const transactions = getAllTransactions(pid);
    const plan = computeSmartDeletePlan(id, transactions);
    if (plan.unsupported) {
      return res.status(409).json({ error: plan.unsupported });
    }

    // Apply edits (zmiana qty + przeliczenie value/total) + deletes atomowo —
    // jedna SQL transakcja, żeby częściowy fail nie zostawił portfela w stanie pośrednim.
    const deleted = getDb(pid).transaction(() => {
      for (const edit of plan.edits) {
        const tx = getTransactionById(edit.txId, pid);
        if (!tx) continue;
        const newValue = edit.newQuantity * tx.price;
        const newCommission = tx.commission * (edit.newQuantity / tx.quantity);
        const newTotal = tx.side === 'K' ? newValue + newCommission : newValue - newCommission;
        updateTransaction(
          edit.txId,
          {
            quantity: edit.newQuantity,
            value: newValue,
            commission: newCommission,
            total: newTotal,
          },
          pid,
        );
      }

      // ...then deletes
      return deleteTransactions(plan.deletes, pid);
    })();

    res.json({
      success: true,
      deleted,
      edited: plan.edits.length,
      warnings: plan.warnings,
    });
  }),
);

// ============ Stock Splits ============

// GET /api/portfolio/splits
router.get(
  '/splits',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const splits = getSplits(pid);
    res.json({ splits });
  }),
);

// POST /api/portfolio/splits
router.post(
  '/splits',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const { isin, ticker, splitDate, ratio } = req.body as StockSplitInput;
    if (!isin || !ticker || !splitDate || !ratio) {
      return res.status(400).json({ error: 'Wymagane pola: isin, ticker, splitDate, ratio' });
    }
    upsertSplits(pid, [
      {
        isin,
        ticker,
        splitDate,
        ratio,
        source: 'manual',
      },
    ]);
    // Ręczny split zmienia korektę transakcji → unieważnij memo historii
    bumpPortfolioDataVersion(pid);
    res.json({ success: true });
  }),
);

// DELETE /api/portfolio/splits/:id
router.delete(
  '/splits/:id',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = parseInt(req.params.id);
    const deleted = deleteSplitFromDb(pid, id);
    if (!deleted) {
      return res.status(404).json({ error: 'Split nie znaleziony' });
    }
    // Usunięty split zmienia korektę transakcji → unieważnij memo historii
    bumpPortfolioDataVersion(pid);
    res.json({ success: true });
  }),
);

export default router;
