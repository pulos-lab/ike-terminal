import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { getAllTransactions, getTransactionById, insertTransaction, updateTransaction, deleteTransaction } from '../db/transactions-repo.js';
import { getAllOperations, getOperationsByType, getOperationsByTypes, insertOperation, insertOperations, updateOperation, deleteOperation, getOperationById } from '../db/operations-repo.js';
import { getTickerMap, getTickerBySymbol, upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import type { DividendInput, DepositInput, TransactionInput, TickerMapEntry, FxExchangeInput } from 'shared';
import { fetchYahooPrice, fetchFxRate } from '../services/yahoo-finance.js';
import {
  computeOpenPositions,
  computeClosedTrades,
  extractDividends,
  extractFxExchanges,
  computePortfolioHistory,
  computeCashFlow,
  computeXirr,
  computeCashBalances,
} from '../services/portfolio-engine.js';
import { BENCHMARKS, type BenchmarkKey } from 'shared';
import { searchTickers } from '../services/ticker-search.js';
import { scanDividends } from '../services/dividend-scanner.js';

const router = Router();

// GET /api/portfolio/positions
router.get('/positions', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const transactions = getAllTransactions(pid);
  const operations = getAllOperations(pid);
  const tickerMap = getTickerMap(pid);
  const { positions, totalValuePln: stocksValuePln } = await computeOpenPositions(transactions, tickerMap);

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

  res.json({ positions, cashPositions, totalValuePln, stocksValuePln, cashValuePln });
}));

// GET /api/portfolio/closed-trades
router.get('/closed-trades', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const transactions = getAllTransactions(pid);
  const tickerMap = getTickerMap(pid);
  const operations = getAllOperations(pid);
  const trades = computeClosedTrades(transactions, tickerMap, operations);
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

  // Always compute full history – client filters & rebases by date range
  const result = await computePortfolioHistory(
    transactions,
    operations,
    tickerMap,
    benchTicker,
    benchConfig.source,
    undefined,
    undefined
  );

  res.json(result);
}));

// GET /api/portfolio/cash-flow
router.get('/cash-flow', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const operations = getAllOperations(pid);
  const transactions = getAllTransactions(pid);
  const tickerMap = getTickerMap(pid);

  // Need portfolio history to get daily values
  const { history } = await computePortfolioHistory(
    transactions, operations, tickerMap,
    '^GSPC', 'yahoo' // default benchmark, doesn't matter for cash flow
  );

  const cashFlow = computeCashFlow(operations, history);
  res.json({ cashFlow });
}));

// GET /api/portfolio/metrics
router.get('/metrics', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const transactions = getAllTransactions(pid);
  const operations = getAllOperations(pid);
  const tickerMap = getTickerMap(pid);

  const { positions, totalValuePln } = await computeOpenPositions(transactions, tickerMap);

  // Include both deposits (positive) and withdrawals (negative) for accurate metrics
  const cashFlows = operations
    .filter(op => (op.operationType === 'deposit' || op.operationType === 'withdrawal') && op.currency === 'PLN')
    .map(op => ({ date: op.date, amount: op.amount }));

  const totalDeposits = cashFlows.filter(f => f.amount > 0).reduce((s, d) => s + d.amount, 0);
  const totalWithdrawals = cashFlows.filter(f => f.amount < 0).reduce((s, d) => s + Math.abs(d.amount), 0);
  const totalInvested = totalDeposits - totalWithdrawals;

  let xirr = 0;
  try {
    const raw = computeXirr(cashFlows, totalValuePln) * 100;
    xirr = isFinite(raw) ? raw : 0;
  } catch {
    xirr = 0;
  }

  const totalDividends = operations
    .filter(op => op.operationType === 'dividend')
    .reduce((s, op) => s + op.amount, 0);

  res.json({
    currentValue: totalValuePln,
    totalInvested,
    xirr,
    totalReturn: totalValuePln - totalInvested,
    totalReturnPct: totalInvested > 0 ? ((totalValuePln - totalInvested) / totalInvested) * 100 : 0,
    totalDividends,
  });
}));

// GET /api/portfolio/transactions
router.get('/transactions', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  const transactions = getAllTransactions(pid);
  const tickerMap = getTickerMap(pid);
  const enriched = transactions.map(tx => {
    const entry = tickerMap.get(tx.isin);
    return {
      ...tx,
      ticker: entry?.ticker || tx.isin,
      name: entry?.name || tx.paperName,
      exchange: entry?.exchange || '',
    };
  });
  res.json({ transactions: enriched });
}));

// POST /api/portfolio/transactions
router.post('/transactions', asyncHandler(async (req, res) => {
  const pid = req.portfolioId;
  const { date, ticker, side, quantity, price, commission, currency: overrideCurrency, fxRate, category } = req.body as TransactionInput;
  if (!date || !ticker || !side || !quantity || !price) {
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

export default router;
