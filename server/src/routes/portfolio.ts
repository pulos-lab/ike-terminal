import { Router } from 'express';
import { getAllTransactions, getTransactionById, insertTransaction, updateTransaction, deleteTransaction } from '../db/transactions-repo.js';
import { getAllOperations, getOperationsByType, getOperationsByTypes, insertOperation, updateOperation, deleteOperation, getOperationById } from '../db/operations-repo.js';
import { getTickerMap, getTickerBySymbol, upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import type { DividendInput, DepositInput, TransactionInput, TickerMapEntry } from 'shared';
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

const router = Router();

// GET /api/portfolio/positions
router.get('/positions', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Portfolio positions error:', error);
    res.status(500).json({ error: 'Failed to compute positions' });
  }
});

// GET /api/portfolio/closed-trades
router.get('/closed-trades', async (req, res) => {
  try {
    const pid = req.portfolioId;
    const transactions = getAllTransactions(pid);
    const tickerMap = getTickerMap(pid);
    const trades = computeClosedTrades(transactions, tickerMap);
    res.json({ trades });
  } catch (error) {
    console.error('Closed trades error:', error);
    res.status(500).json({ error: 'Failed to compute closed trades' });
  }
});

// GET /api/portfolio/dividends
router.get('/dividends', async (req, res) => {
  try {
    const operations = getAllOperations(req.portfolioId);
    const dividends = extractDividends(operations);
    const totalPln = dividends.filter(d => d.currency === 'PLN').reduce((s, d) => s + d.amount, 0);
    const totalUsd = dividends.filter(d => d.currency === 'USD').reduce((s, d) => s + d.amount, 0);
    res.json({ dividends, totalPln, totalUsd });
  } catch (error) {
    console.error('Dividends error:', error);
    res.status(500).json({ error: 'Failed to extract dividends' });
  }
});

// POST /api/portfolio/dividends
router.post('/dividends', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Create dividend error:', error);
    res.status(500).json({ error: 'Failed to create dividend' });
  }
});

// PUT /api/portfolio/dividends/:id
router.put('/dividends/:id', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Update dividend error:', error);
    res.status(500).json({ error: 'Failed to update dividend' });
  }
});

// DELETE /api/portfolio/dividends/:id
router.delete('/dividends/:id', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Delete dividend error:', error);
    res.status(500).json({ error: 'Failed to delete dividend' });
  }
});

// GET /api/portfolio/deposits — returns deposits + withdrawals
router.get('/deposits', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Deposits list error:', error);
    res.status(500).json({ error: 'Failed to list deposits' });
  }
});

// POST /api/portfolio/deposits
router.post('/deposits', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Create deposit error:', error);
    res.status(500).json({ error: 'Failed to create deposit' });
  }
});

// PUT /api/portfolio/deposits/:id
router.put('/deposits/:id', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Update deposit error:', error);
    res.status(500).json({ error: 'Failed to update deposit' });
  }
});

// DELETE /api/portfolio/deposits/:id
router.delete('/deposits/:id', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Delete deposit error:', error);
    res.status(500).json({ error: 'Failed to delete deposit' });
  }
});

// GET /api/portfolio/ticker-search
router.get('/ticker-search', async (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q || q.length < 1) {
      return res.json([]);
    }
    const results = await searchTickers(q);
    res.json(results);
  } catch (error) {
    console.error('Ticker search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/portfolio/fx-history
router.get('/fx-history', async (req, res) => {
  try {
    const operations = getAllOperations(req.portfolioId);
    const exchanges = extractFxExchanges(operations);
    res.json({ exchanges });
  } catch (error) {
    console.error('FX history error:', error);
    res.status(500).json({ error: 'Failed to extract FX history' });
  }
});

// POST /api/portfolio/history
router.post('/history', async (req, res) => {
  try {
    const pid = req.portfolioId;
    const { benchmark = 'sp500', startDate, endDate } = req.body;
    const benchConfig = BENCHMARKS[benchmark as BenchmarkKey];
    if (!benchConfig) {
      return res.status(400).json({ error: 'Invalid benchmark' });
    }

    const transactions = getAllTransactions(pid);
    const operations = getAllOperations(pid);
    const tickerMap = getTickerMap(pid);

    const benchTicker = benchConfig.source === 'stooq'
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
  } catch (error) {
    console.error('Portfolio history error:', error);
    res.status(500).json({ error: 'Failed to compute portfolio history' });
  }
});

// GET /api/portfolio/cash-flow
router.get('/cash-flow', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Cash flow error:', error);
    res.status(500).json({ error: 'Failed to compute cash flow' });
  }
});

// GET /api/portfolio/metrics
router.get('/metrics', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Metrics error:', error);
    res.status(500).json({ error: 'Failed to compute metrics' });
  }
});

// GET /api/portfolio/transactions
router.get('/transactions', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Transactions list error:', error);
    res.status(500).json({ error: 'Failed to list transactions' });
  }
});

// POST /api/portfolio/transactions
router.post('/transactions', async (req, res) => {
  try {
    const pid = req.portfolioId;
    const { date, ticker, side, quantity, price, commission } = req.body as TransactionInput;
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
      currency: entry.currency,
      source: 'manual',
    }, pid);

    res.json({ id });
  } catch (error) {
    console.error('Create transaction error:', error);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

// PUT /api/portfolio/transactions/:id
router.put('/transactions/:id', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Update transaction error:', error);
    res.status(500).json({ error: 'Failed to update transaction' });
  }
});

// DELETE /api/portfolio/transactions/:id
router.delete('/transactions/:id', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

export default router;
