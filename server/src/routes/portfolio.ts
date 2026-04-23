import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { getAllTransactions, getTransactionById, insertTransaction, updateTransaction, deleteTransaction } from '../db/transactions-repo.js';
import { getAllOperations, getOperationsByType, getOperationsByTypes, insertOperation, insertOperations, updateOperation, deleteOperation, getOperationById } from '../db/operations-repo.js';
import { getTickerMap, getTickerBySymbol, upsertTickerMapEntry, getAllTickers, updateTickerSectors } from '../db/ticker-map-repo.js';
import { resolveSector } from '../services/sector-resolver.js';
import { getSplits, upsertSplits, deleteSplit as deleteSplitFromDb } from '../db/splits-repo.js';
import type { DividendInput, DepositInput, TransactionInput, TickerMapEntry, FxExchangeInput, StockSplitInput, DetectedSplit, UpcomingDividend } from 'shared';
import { invalidateCachedPrices } from '../services/history-cache.js';
import { fetchYahooPrice, fetchFxRate, fetchDividendCalendar } from '../services/yahoo-finance.js';
import {
  computeOpenPositions,
  computeClosedTrades,
  extractDividends,
  extractFxExchanges,
  computePortfolioHistory,
  computeCashFlow,
  computeXirr,
  computeCashBalances,
  detectBaseCurrency,
  computeFxImpact,
} from '../services/portfolio-engine.js';
import { BENCHMARKS, type BenchmarkKey } from 'shared';
import { searchTickers } from '../services/ticker-search.js';
import { scanDividends } from '../services/dividend-scanner.js';

const router = Router();

/** Load saved splits from DB and convert to DetectedSplit format for the engine. */
function loadSplitsForEngine(pid: string): DetectedSplit[] {
  return getSplits(pid).map(s => ({
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
    const toUpdate = entries.filter(e => !e.supersector);
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
router.get('/positions', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const transactions = getAllTransactions(pid);
  const operations = getAllOperations(pid);
  const tickerMap = getTickerMap(pid);
  const savedSplits = loadSplitsForEngine(pid);

  // Fire-and-forget: lazy backfill brakujących sektorów w tle (raz per proces
  // per portfel). Nie blokuje response — user zobaczy nowe sektory po kolejnym
  // odświeżeniu widoku.
  void lazyBackfillSectors(pid);
  const { positions, totalValuePln: stocksValuePln, detectedSplits } = await computeOpenPositions(transactions, tickerMap, savedSplits);

  // Persist any newly detected splits and invalidate stale price cache
  if (detectedSplits.length > savedSplits.length) {
    const newSplits = detectedSplits.filter(
      ds => !savedSplits.some(ss => ss.isin === ds.isin && ss.date === ds.date)
    );
    upsertSplits(pid, detectedSplits.map(s => ({
      isin: s.isin,
      ticker: s.ticker,
      splitDate: s.date,
      ratio: s.ratio,
      source: s.source,
    })));
    // Invalidate stale pre-split prices so dashboard re-fetches from Yahoo
    for (const s of newSplits) {
      invalidateCachedPrices(s.ticker);
    }
  }

  // Compute cash balances per currency
  const balances = computeCashBalances(transactions, operations);
  const usdPln = await fetchFxRate('USDPLN') || 4.0;
  const cadPln = await fetchFxRate('CADPLN') || 2.95;
  const eurPln = await fetchFxRate('EURPLN') || 4.3;
  const fxRates: Record<string, number> = { PLN: 1, USD: usdPln, CAD: cadPln, EUR: eurPln };

  let cashValuePln = 0;
  const cashPositions = Object.entries(balances)
    .filter(([, balance]) => balance > 0.01) // only positive cash
    .map(([currency, balance]) => {
      const rate = fxRates[currency] || 1;
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
    .filter(s => s.date >= weekAgoStr)
    .map(s => ({ isin: s.isin, ticker: s.ticker, date: s.date, ratio: s.ratio }));

  const baseCurrency = detectBaseCurrency(operations);

  res.json({ positions, cashPositions, totalValuePln, stocksValuePln, cashValuePln, recentSplits, baseCurrency });
}));

// GET /api/portfolio/closed-trades
router.get('/closed-trades', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const transactions = getAllTransactions(pid);
  const tickerMap = getTickerMap(pid);
  const operations = getAllOperations(pid);
  const savedSplits = loadSplitsForEngine(pid);
  const trades = computeClosedTrades(transactions, tickerMap, operations, savedSplits);
  res.json({ trades });
}));

// GET /api/portfolio/dividends
router.get('/dividends', asyncHandler(async (req, res) => {
  const operations = getAllOperations(req.portfolioId);
  const dividends = extractDividends(operations);
  const totalPln = dividends.filter(d => d.currency === 'PLN').reduce((s, d) => s + d.amount, 0);
  const totalUsd = dividends.filter(d => d.currency === 'USD').reduce((s, d) => s + d.amount, 0);
  res.json({ dividends, totalPln, totalUsd });
}));

// POST /api/portfolio/dividends
router.post('/dividends', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const { date, ticker, amount, currency } = req.body as DividendInput;
  if (!date || !ticker || !amount || !currency) {
    return res.status(400).json({ error: 'Wymagane pola: date, ticker, amount, currency' });
  }
  const id = insertOperation({
    date,
    operationType: 'dividend',
    description: `Wypłata dywidendy ${ticker.toUpperCase()}`,
    amount,
    currency,
    ticker: ticker.toUpperCase(),
    source: 'manual',
  }, pid);
  res.json({ id });
}));

// PUT /api/portfolio/dividends/:id
router.put('/dividends/:id', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const id = parseInt(req.params.id);
  const existing = getOperationById(id, pid);
  if (!existing || existing.operationType !== 'dividend') {
    return res.status(404).json({ error: 'Dywidenda nie znaleziona' });
  }
  const { date, ticker, amount, currency } = req.body as DividendInput;
  const updated = updateOperation(id, {
    date: date || existing.date,
    amount: amount ?? existing.amount,
    currency: currency || existing.currency,
    ticker: ticker?.toUpperCase() || existing.ticker,
    description: ticker ? `Wypłata dywidendy ${ticker.toUpperCase()}` : existing.description,
  }, pid);
  if (!updated) {
    return res.status(500).json({ error: 'Nie udało się zaktualizować' });
  }
  res.json({ success: true });
}));

// DELETE /api/portfolio/dividends/:id
router.delete('/dividends/:id', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const id = parseInt(req.params.id);
  const existing = getOperationById(id, pid);
  if (!existing || existing.operationType !== 'dividend') {
    return res.status(404).json({ error: 'Dywidenda nie znaleziona' });
  }
  const deleted = deleteOperation(id, pid);
  if (!deleted) {
    return res.status(500).json({ error: 'Nie udało się usunąć' });
  }
  res.json({ success: true });
}));

// POST /api/portfolio/dividends/scan — trigger manual dividend scan
router.post('/dividends/scan', asyncHandler(async (req, res) => {
  const result = await scanDividends(req.portfolioId);
  res.json(result);
}));

// GET /api/portfolio/dividends/upcoming — upcoming dividends from v10 calendar
router.get('/dividends/upcoming', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const transactions = getAllTransactions(pid);
  const tickerMap = getTickerMap(pid);
  const splits = loadSplitsForEngine(pid);
  const { positions } = await computeOpenPositions(transactions, tickerMap, splits);

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
      const isPendingPayment = cal.paymentDate && cal.paymentDate >= today && cal.exDividendDate < today;

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
}));

// GET /api/portfolio/fees — returns fee operations (interest, payment charges, etc.)
router.get('/fees', asyncHandler((req, res) => {
  const fees = getOperationsByType('fee', req.portfolioId)
    .map(op => ({
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
}));

// GET /api/portfolio/deposits — returns deposits + withdrawals
router.get('/deposits', asyncHandler((req, res) => {
  const deposits = getOperationsByTypes(['deposit', 'withdrawal'], req.portfolioId)
    .map(op => ({
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
}));

// POST /api/portfolio/deposits
router.post('/deposits', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const { date, amount, type } = req.body as DepositInput & { type?: 'deposit' | 'withdrawal' };
  if (!date || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Wymagane pola: date, amount (> 0)' });
  }
  const isWithdrawal = type === 'withdrawal';
  const id = insertOperation({
    date,
    operationType: isWithdrawal ? 'withdrawal' : 'deposit',
    description: isWithdrawal ? 'Wypłata' : 'Wpłata',
    amount: isWithdrawal ? -amount : amount,
    currency: 'PLN',
    source: 'manual',
  }, pid);
  res.json({ id });
}));

// PUT /api/portfolio/deposits/:id
router.put('/deposits/:id', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const id = parseInt(req.params.id);
  const existing = getOperationById(id, pid);
  if (!existing || (existing.operationType !== 'deposit' && existing.operationType !== 'withdrawal')) {
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
}));

// DELETE /api/portfolio/deposits/:id
router.delete('/deposits/:id', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const id = parseInt(req.params.id);
  const existing = getOperationById(id, pid);
  if (!existing || (existing.operationType !== 'deposit' && existing.operationType !== 'withdrawal')) {
    return res.status(404).json({ error: 'Operacja nie znaleziona' });
  }
  const deleted = deleteOperation(id, pid);
  if (!deleted) {
    return res.status(500).json({ error: 'Nie udało się usunąć' });
  }
  res.json({ success: true });
}));

// GET /api/portfolio/ticker-search
router.get('/ticker-search', asyncHandler(async (req, res) => {
  const q = (req.query.q as string || '').trim().slice(0, 50);
  if (!q || q.length < 1) {
    return res.json([]);
  }
  const results = await searchTickers(q);
  res.json(results);
}));

// GET /api/portfolio/fx-history
router.get('/fx-history', asyncHandler(async (req, res) => {
  const operations = getAllOperations(req.portfolioId);
  const exchanges = extractFxExchanges(operations);
  res.json({ exchanges });
}));

// POST /api/portfolio/fx-exchanges
router.post('/fx-exchanges', asyncHandler((req, res) => {
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

  const count = insertOperations([
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
  ], pid);

  res.json({ success: true, operationsCreated: count });
}));

// DELETE /api/portfolio/fx-exchanges/:fromId/:toId
router.delete('/fx-exchanges/:fromId/:toId', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const fromId = parseInt(req.params.fromId);
  const toId = parseInt(req.params.toId);

  if (isNaN(fromId) || isNaN(toId)) {
    return res.status(400).json({ error: 'Nieprawidłowe ID operacji' });
  }

  const fromOp = getOperationById(fromId, pid);
  const toOp = getOperationById(toId, pid);

  if (!fromOp || !toOp || fromOp.operationType !== 'fx_exchange' || toOp.operationType !== 'fx_exchange') {
    return res.status(404).json({ error: 'Operacje wymiany nie znalezione' });
  }

  deleteOperation(fromId, pid);
  deleteOperation(toId, pid);

  res.json({ success: true });
}));

// POST /api/portfolio/history
router.post('/history', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const { benchmark = 'sp500', startDate, endDate } = req.body;
  const benchConfig = BENCHMARKS[benchmark as BenchmarkKey];
  if (!benchConfig) {
    return res.status(400).json({ error: 'Invalid benchmark' });
  }

  const transactions = getAllTransactions(pid);
  const operations = getAllOperations(pid);
  const tickerMap = getTickerMap(pid);

  const benchTicker = benchConfig.source === 'none'
    ? ''
    : benchConfig.source === 'stooq'
      ? (benchConfig as any).stooqTicker
      : (benchConfig as any).yahooTicker;

  const savedSplits = loadSplitsForEngine(pid);

  const baseCurrency = detectBaseCurrency(operations);

  // Always compute full history – client filters & rebases by date range
  const result = await computePortfolioHistory(
    transactions,
    operations,
    tickerMap,
    benchTicker,
    benchConfig.source,
    undefined,
    undefined,
    savedSplits,
    baseCurrency,
  );

  // Persist any newly detected splits and invalidate stale price cache
  if (result.detectedSplits.length > 0) {
    const newSplits = result.detectedSplits.filter(
      ds => !savedSplits.some(ss => ss.isin === ds.isin && ss.date === ds.date)
    );
    upsertSplits(pid, result.detectedSplits.map(s => ({
      isin: s.isin,
      ticker: s.ticker,
      splitDate: s.date,
      ratio: s.ratio,
      source: s.source,
    })));
    for (const s of newSplits) {
      invalidateCachedPrices(s.ticker);
    }
  }

  res.json({ history: result.history, metrics: result.metrics, baseCurrency });
}));

// GET /api/portfolio/cash-flow
router.get('/cash-flow', asyncHandler(async (req, res) => {
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
  const { history, dailyFxRates } = await computePortfolioHistory(
    transactions, operations, tickerMap,
    '^GSPC', 'yahoo', // default benchmark, doesn't matter for cash flow
    undefined, undefined, savedSplits, baseCurrency,
  );

  const cashFlow = computeCashFlow(operations, history, dailyFxRates, baseCurrency);
  res.json({ cashFlow, baseCurrency });
}));

// POST /api/portfolio/ticker-map/refresh-sectors
// Backfill pól sector + supersector dla wszystkich entries w ticker_map aktywnego portfela.
// Kolejność źródeł: GPW_SECTOR_MAP (stockwatch, offline) → CFD_TICKER_MAP (offline) →
// Yahoo fetchAssetProfile (GICS → mapGicsToStockwatch → PL). Bezpieczne — aktualizuje
// tylko entries bez supersektora (nie nadpisuje ręcznie przypisanych).
router.post('/ticker-map/refresh-sectors', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const entries = getAllTickers(pid);
  const toUpdate = entries.filter(e => !e.supersector);

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
}));

// GET /api/portfolio/metrics
router.get('/metrics', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const transactions = getAllTransactions(pid);
  const operations = getAllOperations(pid);
  const tickerMap = getTickerMap(pid);
  const savedSplits = loadSplitsForEngine(pid);

  const baseCurrency = detectBaseCurrency(operations);

  // Engine liczy wszystko w baseCurrency (nowy refactor — commit e9db541+).
  // Wszystkie metrics zwracane są już w walucie bazowej portfela, bez FX drift
  // jaki wcześniej powodował podwójną konwersję (Σ raw × fx_dnia → PLN → /fx_today).
  const { metrics } = await computePortfolioHistory(
    transactions, operations, tickerMap,
    '^GSPC', 'yahoo', // benchmark ticker nie wpływa na metrics
    undefined, undefined, savedSplits, baseCurrency,
  );

  // FX impact — liczymy per-currency exposure dla każdej obcej waluty w portfelu
  // (vs PLN jako referencja). fxImpactPct pokazywany jako % CAŁEGO portfela
  // (intuicyjne — "o ile portfel ruszył dzięki FX"), breakdown per waluta z
  // ekspozycją jako % portfela (user widzi skalę).
  const { positions, totalValuePln: stocksValuePln } = await computeOpenPositions(transactions, tickerMap, savedSplits);
  const cashBalances = computeCashBalances(transactions, operations);

  const foreignExposures = new Map<string, number>();
  for (const pos of positions) {
    const cur = (pos.currency || 'PLN').toUpperCase();
    if (cur === 'PLN') continue;
    const native = pos.currentValue ?? 0;
    foreignExposures.set(cur, (foreignExposures.get(cur) ?? 0) + native);
  }
  for (const [cur, balance] of Object.entries(cashBalances)) {
    const upperCur = cur.toUpperCase();
    if (upperCur === 'PLN') continue;
    if (balance > 0) foreignExposures.set(upperCur, (foreignExposures.get(upperCur) ?? 0) + balance);
  }

  // Dzisiejsze kursy PLN-per-X dla każdej obcej waluty w portfelu
  const todayFxRatesToPln = new Map<string, number>();
  for (const cur of foreignExposures.keys()) {
    const rate = await fetchFxRate(`${cur}PLN`) || 0;
    if (rate > 0) todayFxRatesToPln.set(cur, rate);
  }

  // totalPortfolioValuePln = stocks + cash, cash konwertowany przez dzisiejszy FX.
  // Dla PLN portfeli: stocksValuePln już w PLN, cash PLN + obce waluty konwertowane.
  let cashValuePln = 0;
  for (const [cur, balance] of Object.entries(cashBalances)) {
    const upperCur = cur.toUpperCase();
    if (upperCur === 'PLN') cashValuePln += balance;
    else cashValuePln += balance * (todayFxRatesToPln.get(upperCur) || 0);
  }
  const totalPortfolioValuePln = stocksValuePln + cashValuePln;

  const fxImpact = computeFxImpact(operations, foreignExposures, todayFxRatesToPln, totalPortfolioValuePln);

  res.json({
    currentValue: metrics.currentValue,
    totalInvested: metrics.totalInvested,
    xirr: metrics.xirr,
    totalReturn: metrics.totalReturn,
    totalReturnPct: metrics.totalReturnPct,
    totalDividends: metrics.totalDividends,
    baseCurrency,
    fxImpact,
  });
}));

// GET /api/portfolio/transactions
router.get('/transactions', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const transactions = getAllTransactions(pid);
  const tickerMap = getTickerMap(pid);
  const enriched = transactions.map(tx => {
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
      ? (entry?.currency || tx.currency || 'PLN')
      : (tx.currency || entry?.currency || 'PLN');
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
}));

// POST /api/portfolio/transactions
router.post('/transactions', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const { date, ticker, side, quantity, price, commission, currency: overrideCurrency, fxRate, category } = req.body as TransactionInput;
  if (!date || !ticker || !side || !quantity || price == null) {
    return res.status(400).json({ error: 'Wymagane pola: date, ticker, side, quantity, price' });
  }
  if (side !== 'K' && side !== 'S') {
    return res.status(400).json({ error: 'Pole side musi być K lub S' });
  }

  // Look up ticker in ticker_map
  let entry = getTickerBySymbol(ticker, pid);

  // If not found, try to auto-create from Yahoo
  if (!entry) {
    const yahooData = await fetchYahooPrice(ticker);
    if (!yahooData) {
      return res.status(400).json({ error: `Nie znaleziono tickera: ${ticker}. Sprawdź symbol.` });
    }

    const newEntry: TickerMapEntry = {
      isin: `AUTO_${ticker.toUpperCase()}`,
      ticker: ticker.toUpperCase(),
      name: ticker.toUpperCase(),
      exchange: 'OTHER',
      currency: yahooData.currency || 'USD',
      priceSource: 'yahoo',
    };

    // Try Stooq for .WA tickers
    if (ticker.toUpperCase().endsWith('.WA')) {
      newEntry.exchange = 'GPW';
      newEntry.currency = 'PLN';
      newEntry.priceSource = 'stooq';
    }

    upsertTickerMapEntry(newEntry, pid);
    entry = newEntry;
  }

  const value = quantity * price;
  const comm = commission || 0;
  const total = side === 'K' ? value + comm : value - comm;

  const id = insertTransaction({
    date,
    paperName: entry.name,
    isin: entry.isin,
    quantity,
    side,
    price,
    value,
    commission: comm,
    total,
    currency: overrideCurrency || entry.currency,
    category: category || 'stock',
    source: 'manual',
  }, pid);

  res.json({ id });
}));

// PUT /api/portfolio/transactions/:id
router.put('/transactions/:id', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const id = parseInt(req.params.id);
  const existing = getTransactionById(id, pid);
  if (!existing) {
    return res.status(404).json({ error: 'Transakcja nie znaleziona' });
  }

  const { date, ticker, side, quantity, price, commission } = req.body as Partial<TransactionInput>;

  const updates: Partial<import('shared').Transaction> = {};
  if (date) updates.date = date;
  if (side) updates.side = side;
  if (quantity !== undefined) updates.quantity = quantity;
  if (price !== undefined) updates.price = price;
  if (commission !== undefined) updates.commission = commission;

  // If ticker changed, resolve to ISIN
  if (ticker && ticker !== existing.isin) {
    let entry = getTickerBySymbol(ticker, pid);
    if (!entry) {
      const yahooData = await fetchYahooPrice(ticker);
      if (!yahooData) {
        return res.status(400).json({ error: `Nie znaleziono tickera: ${ticker}` });
      }
      const newEntry: TickerMapEntry = {
        isin: `AUTO_${ticker.toUpperCase()}`,
        ticker: ticker.toUpperCase(),
        name: ticker.toUpperCase(),
        exchange: 'OTHER',
        currency: yahooData.currency || 'USD',
        priceSource: 'yahoo',
      };
      if (ticker.toUpperCase().endsWith('.WA')) {
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
}));

// DELETE /api/portfolio/transactions/:id
router.delete('/transactions/:id', asyncHandler((req, res) => {
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
}));

// ============ Stock Splits ============

// GET /api/portfolio/splits
router.get('/splits', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const splits = getSplits(pid);
  res.json({ splits });
}));

// POST /api/portfolio/splits
router.post('/splits', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const { isin, ticker, splitDate, ratio } = req.body as StockSplitInput;
  if (!isin || !ticker || !splitDate || !ratio) {
    return res.status(400).json({ error: 'Wymagane pola: isin, ticker, splitDate, ratio' });
  }
  upsertSplits(pid, [{
    isin,
    ticker,
    splitDate,
    ratio,
    source: 'manual',
  }]);
  res.json({ success: true });
}));

// DELETE /api/portfolio/splits/:id
router.delete('/splits/:id', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const id = parseInt(req.params.id);
  const deleted = deleteSplitFromDb(pid, id);
  if (!deleted) {
    return res.status(404).json({ error: 'Split nie znaleziony' });
  }
  res.json({ success: true });
}));

export default router;
