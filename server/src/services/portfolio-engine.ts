import type { Transaction, CashOperation, Position, ClosedTrade, TickerMapEntry, PortfolioHistoryPoint, PortfolioMetrics, DividendRecord, FxExchangeRecord, CashFlowRecord } from 'shared';
import { fetchYahooPrice, fetchFxRate, fetchYahooHistory } from './yahoo-finance.js';
import { fetchStooqPrice, fetchStooqHistory, fetchStooqPreviousClose } from './stooq.js';
import { getDb } from '../db/connection.js';

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
  buyCurrency: string;
  /** Total cost basis in PLN (for cross-currency P/L) */
  costBasisPln: number;
}

export function computePositionMetrics(transactions: Transaction[]): PositionMetrics {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const buyLots: BuyLot[] = [];
  let totalCommission = 0;

  for (const tx of sorted) {
    totalCommission += tx.commission;
    if (tx.side === 'K') {
      buyLots.push({
        quantity: tx.quantity,
        price: tx.price,
        commission: tx.commission,
        date: tx.date,
        currency: tx.currency,
      });
    } else {
      // FIFO sell
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
    }
  }

  const shares = buyLots.reduce((sum, lot) => sum + lot.quantity, 0);
  const totalCost = buyLots.reduce((sum, lot) => sum + lot.quantity * lot.price, 0);
  const avgBuyPrice = shares > 0 ? totalCost / shares : 0;
  const buyCurrency = buyLots.length > 0 ? buyLots[0].currency : 'PLN';
  // costBasisPln: total cost in the transaction currency (which is PLN for PLN buys,
  // or needs FX conversion for USD/CAD buys — handled in computeOpenPositions)
  const costBasisPln = totalCost;

  return { shares, avgBuyPrice, totalCommission, buyLots, buyCurrency, costBasisPln };
}

// ============ Open Positions ============

export async function computeOpenPositions(
  transactions: Transaction[],
  tickerMap: Map<string, TickerMapEntry>
): Promise<{ positions: Position[]; totalValuePln: number }> {
  // Group by ISIN
  const byIsin = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const arr = byIsin.get(tx.isin) || [];
    arr.push(tx);
    byIsin.set(tx.isin, arr);
  }

  // Get FX rates
  const usdPln = await fetchFxRate('USDPLN') || 4.0;
  const cadPln = await fetchFxRate('CADPLN') || 2.95;
  const eurPln = await fetchFxRate('EURPLN') || 4.3;
  const fxRates: Record<string, number> = { USD: usdPln, CAD: cadPln, EUR: eurPln, PLN: 1 };

  const positions: Position[] = [];
  let totalValuePln = 0;

  for (const [isin, txs] of byIsin) {
    const metrics = computePositionMetrics(txs);
    if (metrics.shares <= 0) continue;

    const entry = tickerMap.get(isin);
    if (!entry) continue;

    // Fetch current price (in the paper's native currency)
    let currentPrice: number | null = null;
    let previousClose: number | null = null;
    if (entry.priceSource === 'stooq' || entry.ticker.endsWith('.WA')) {
      currentPrice = await fetchStooqPrice(entry.ticker);
      previousClose = await fetchStooqPreviousClose(entry.ticker);
    } else {
      const yp = await fetchYahooPrice(entry.ticker);
      currentPrice = yp?.price || null;
      previousClose = yp?.previousClose ?? null;
    }

    // Daily change %
    const dailyChangePct = (currentPrice != null && previousClose != null && previousClose > 0)
      ? ((currentPrice - previousClose) / previousClose) * 100
      : null;

    const priceInNative = currentPrice || 0;
    const fxNativeToPln = fxRates[entry.currency] || 1;
    const currentValueNative = metrics.shares * priceInNative;
    const currentValuePln = currentValueNative * fxNativeToPln;

    // Cost basis in PLN: convert each buy lot individually using its own currency.
    // This correctly handles mixed-currency purchases (e.g. NVO bought in PLN and USD).
    let costBasisPln = 0;
    for (const lot of metrics.buyLots) {
      const lotFx = fxRates[lot.currency] || 1;
      costBasisPln += lot.quantity * lot.price * lotFx;
    }

    // P/L in PLN (the account currency)
    const profitLossPln = currentValuePln - costBasisPln;
    const profitLossPct = costBasisPln > 0 ? (profitLossPln / costBasisPln) * 100 : 0;

    // For display: avgBuyPrice in the paper's native currency
    // Derived from PLN cost basis to correctly handle mixed-currency lots
    const avgBuyPriceNative = metrics.shares > 0
      ? costBasisPln / fxNativeToPln / metrics.shares
      : 0;

    // P/L in native currency (for display alongside position's currency)
    const costBasisNative = metrics.shares * avgBuyPriceNative;
    const profitLossNative = currentValueNative - costBasisNative;

    totalValuePln += currentValuePln;

    positions.push({
      paperName: entry.name,
      isin,
      ticker: entry.ticker,
      shares: metrics.shares,
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
      dailyChangePct,
    });
  }

  // Compute weights
  for (const pos of positions) {
    pos.weight = totalValuePln > 0 ? (pos.currentValuePln / totalValuePln) * 100 : 0;
  }

  // Sort by value descending
  positions.sort((a, b) => b.currentValuePln - a.currentValuePln);

  return { positions, totalValuePln };
}

// ============ Closed Trades (FIFO) ============

export function computeClosedTrades(
  transactions: Transaction[],
  tickerMap: Map<string, TickerMapEntry>
): ClosedTrade[] {
  const byIsin = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const arr = byIsin.get(tx.isin) || [];
    arr.push(tx);
    byIsin.set(tx.isin, arr);
  }

  const closedTrades: ClosedTrade[] = [];

  for (const [isin, txs] of byIsin) {
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const buyQueue: Array<{ quantity: number; price: number; commission: number; date: string }> = [];
    const entry = tickerMap.get(isin);

    for (const tx of sorted) {
      if (tx.side === 'K') {
        buyQueue.push({
          quantity: tx.quantity,
          price: tx.price,
          commission: tx.commission,
          date: tx.date,
        });
      } else {
        let remaining = tx.quantity;
        const commissionPerShare = tx.commission / tx.quantity;

        while (remaining > 0 && buyQueue.length > 0) {
          const lot = buyQueue[0];
          const matched = Math.min(remaining, lot.quantity);
          const buyCommPerShare = lot.commission / (lot.quantity + matched - lot.quantity); // approximation

          const buyDate = new Date(lot.date);
          const sellDate = new Date(tx.date);
          const holdingDays = Math.floor((sellDate.getTime() - buyDate.getTime()) / (1000 * 60 * 60 * 24));

          const buyValue = matched * lot.price;
          const sellValue = matched * tx.price;
          const buyComm = matched * (lot.commission / (lot.quantity + (lot.quantity === matched ? 0 : matched)));
          const sellComm = matched * commissionPerShare;
          const pl = sellValue - buyValue - buyComm - sellComm;
          const plPct = buyValue > 0 ? (pl / buyValue) * 100 : 0;

          closedTrades.push({
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
            sellTransactionId: tx.id!,
            sellSource: tx.source,
          });

          if (lot.quantity <= remaining) {
            remaining -= lot.quantity;
            buyQueue.shift();
          } else {
            lot.quantity -= remaining;
            remaining = 0;
          }
        }
      }
    }
  }

  // Sort by sell date descending
  closedTrades.sort((a, b) => b.sellDate.localeCompare(a.sellDate));
  return closedTrades;
}

// ============ Dividends ============

export function extractDividends(operations: CashOperation[]): DividendRecord[] {
  return operations
    .filter(op => op.operationType === 'dividend')
    .map(op => ({
      id: op.id!,
      date: op.date,
      ticker: op.ticker || extractTickerFromDescription(op.description),
      description: op.description,
      amount: op.amount,
      currency: op.currency,
      source: op.source,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function extractTickerFromDescription(desc: string): string {
  const match = desc.match(/dywidendy(?:\s+netto)?\s+(\w+)/i);
  return match ? match[1] : 'UNKNOWN';
}

// ============ FX Exchange History ============

export function extractFxExchanges(operations: CashOperation[]): FxExchangeRecord[] {
  const fxOps = operations.filter(op => op.operationType === 'fx_exchange');
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
    const fromOp = ops.find(o => o.amount < 0);
    const toOp = ops.find(o => o.amount > 0);
    if (fromOp && toOp) {
      records.push({
        date,
        pair: fromOp.fxPair || `${fromOp.currency}/${toOp.currency}`,
        rate: fromOp.fxRate || (Math.abs(fromOp.amount) / toOp.amount),
        amountFrom: Math.abs(fromOp.amount),
        currencyFrom: fromOp.currency,
        amountTo: toOp.amount,
        currencyTo: toOp.currency,
      });
    }
  }

  return records.sort((a, b) => b.date.localeCompare(a.date));
}

// ============ XIRR Calculation ============

export function computeXirr(deposits: Array<{ date: string; amount: number }>, currentValue: number): number {
  const cashflows: Array<{ date: Date; amount: number }> = deposits.map(d => ({
    date: new Date(d.date),
    amount: -Math.abs(d.amount), // deposits are negative (outflow)
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
      return sum - t * cf.amount / Math.pow(1 + rate, t + 1);
    }, 0);
  }

  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate);
    const df = dnpv(rate);
    if (Math.abs(df) < 1e-12) break;
    const newRate = rate - f / df;
    if (Math.abs(newRate - rate) < 1e-9) {
      return newRate;
    }
    rate = newRate;
  }

  return rate;
}

// ============ Portfolio History ============

export async function computePortfolioHistory(
  transactions: Transaction[],
  operations: CashOperation[],
  tickerMap: Map<string, TickerMapEntry>,
  benchmarkTicker: string,
  benchmarkSource: 'yahoo' | 'stooq',
  startDate?: string,
  endDate?: string
): Promise<{ history: PortfolioHistoryPoint[]; metrics: PortfolioMetrics }> {
  // Determine date range
  const allDates = [
    ...operations.map(o => o.date.split('T')[0]),
    ...transactions.map(t => t.date.split('T')[0]),
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

  // Build daily deposits
  const dailyDeposit = new Map<string, number>();
  for (const op of operations) {
    if (op.operationType === 'deposit' && op.amount > 0) {
      const date = op.date.split('T')[0];
      dailyDeposit.set(date, (dailyDeposit.get(date) || 0) + op.amount);
    }
  }

  // Build daily cash flow per currency (PLN + USD + CAD + EUR)
  const dailyCashFlowPln = new Map<string, number>();
  const dailyCashFlowUsd = new Map<string, number>();
  const dailyCashFlowCad = new Map<string, number>();
  const dailyCashFlowEur = new Map<string, number>();

  function getCashFlowMap(currency: string) {
    if (currency === 'USD') return dailyCashFlowUsd;
    if (currency === 'CAD') return dailyCashFlowCad;
    if (currency === 'EUR') return dailyCashFlowEur;
    return dailyCashFlowPln;
  }

  for (const op of operations) {
    const date = op.date.split('T')[0];
    const map = getCashFlowMap(op.currency);
    map.set(date, (map.get(date) || 0) + op.amount);
  }

  // Transaction cash impacts (per currency)
  for (const tx of transactions) {
    const date = tx.date.split('T')[0];
    const map = getCashFlowMap(tx.currency);
    const impact = tx.side === 'K' ? -tx.total : tx.total;
    map.set(date, (map.get(date) || 0) + impact);
  }

  // Build daily holdings per ISIN
  const holdingsChanges = new Map<string, Map<string, number>>(); // date -> isin -> qty change
  for (const tx of transactions) {
    const date = tx.date.split('T')[0];
    const byDate = holdingsChanges.get(date) || new Map();
    const change = tx.side === 'K' ? tx.quantity : -tx.quantity;
    byDate.set(tx.isin, (byDate.get(tx.isin) || 0) + change);
    holdingsChanges.set(date, byDate);
  }

  // Get unique ISINs that were ever held
  const allIsins = new Set<string>();
  for (const tx of transactions) allIsins.add(tx.isin);

  // Fetch historical prices for all tickers + FX
  const tickersToFetch: Array<{ isin: string; ticker: string; source: string; currency: string }> = [];
  for (const isin of allIsins) {
    const entry = tickerMap.get(isin);
    if (entry) {
      tickersToFetch.push({ isin, ticker: entry.ticker, source: entry.priceSource, currency: entry.currency });
    }
  }

  // Fetch all historical data
  const historicalPrices = new Map<string, Map<string, number>>(); // ticker -> date -> close

  // Fetch in batches — try Stooq first for .WA tickers, fall back to Yahoo
  const fetchPromises = tickersToFetch.map(async ({ ticker, source }) => {
    let data: Array<{ date: string; close: number }>;
    if (source === 'stooq' || ticker.endsWith('.WA')) {
      data = await fetchStooqHistory(ticker, start);
      // If Stooq returned no/insufficient data (rate limit), fall back to Yahoo
      if (data.length < 10) {
        console.log(`Stooq returned ${data.length} points for ${ticker}, falling back to Yahoo`);
        const yahooData = await fetchYahooHistory(ticker, start, end);
        if (yahooData.length > data.length) {
          data = yahooData;
        }
      }
    } else {
      data = await fetchYahooHistory(ticker, start, end);
    }
    const priceMap = new Map<string, number>();
    for (const d of data) priceMap.set(d.date, d.close);
    historicalPrices.set(ticker, priceMap);
  });

  // Fetch FX rates
  fetchPromises.push((async () => {
    const data = await fetchYahooHistory('USDPLN=X', start, end);
    const priceMap = new Map<string, number>();
    for (const d of data) priceMap.set(d.date, d.close);
    historicalPrices.set('USDPLN=X', priceMap);
  })());

  fetchPromises.push((async () => {
    const data = await fetchYahooHistory('CADPLN=X', start, end);
    const priceMap = new Map<string, number>();
    for (const d of data) priceMap.set(d.date, d.close);
    historicalPrices.set('CADPLN=X', priceMap);
  })());

  fetchPromises.push((async () => {
    const data = await fetchYahooHistory('EURPLN=X', start, end);
    const priceMap = new Map<string, number>();
    for (const d of data) priceMap.set(d.date, d.close);
    historicalPrices.set('EURPLN=X', priceMap);
  })());

  // Fetch benchmark
  fetchPromises.push((async () => {
    let data: Array<{ date: string; close: number }>;
    if (benchmarkSource === 'stooq') {
      data = await fetchStooqHistory(benchmarkTicker, start);
    } else {
      data = await fetchYahooHistory(benchmarkTicker, start, end);
    }
    const priceMap = new Map<string, number>();
    for (const d of data) priceMap.set(d.date, d.close);
    historicalPrices.set(`benchmark_${benchmarkTicker}`, priceMap);
  })());

  await Promise.all(fetchPromises);

  // Scale historical prices to match actual transaction prices.
  // Data providers (Yahoo, Stooq) return split/dividend-adjusted prices
  // which can be very different from the price actually paid (e.g. AVGO
  // 10:1 split makes Yahoo show 107 instead of 1070).
  // We detect the ratio on transaction dates and rescale all prices for that ticker.
  // Only compare when tx currency matches ticker currency (otherwise it's an FX
  // difference, not a split — Bossa sometimes records PLN prices for USD stocks).
  // Process in chronological order so the earliest transaction sets the scale.
  const sortedTxForScaling = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const alreadyScaled = new Set<string>();
  for (const tx of sortedTxForScaling) {
    const entry = tickerMap.get(tx.isin);
    if (!entry) continue;
    const dateKey = tx.date.split('T')[0];
    if (!historicalPrices.has(entry.ticker)) historicalPrices.set(entry.ticker, new Map());
    const priceMap = historicalPrices.get(entry.ticker)!;

    // Only attempt scaling if currencies match and not already scaled
    if (tx.currency === entry.currency && !alreadyScaled.has(entry.ticker)) {
      const providerPrice = priceMap.get(dateKey);
      if (providerPrice && providerPrice > 0 && Math.abs(tx.price / providerPrice - 1) > 0.15) {
        // Significant discrepancy detected — likely a split or major adjustment.
        // Rescale ALL provider prices by this ratio so the entire history is
        // consistent with actual transaction prices.
        const ratio = tx.price / providerPrice;
        for (const [d, p] of priceMap) {
          priceMap.set(d, p * ratio);
        }
        alreadyScaled.add(entry.ticker);
      }
    }

    // Overwrite transaction date price only if same currency
    if (tx.currency === entry.currency) {
      priceMap.set(dateKey, tx.price);
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

    // Collect transaction price points for this ticker (same currency only)
    const txPoints: Array<{ date: string; price: number }> = [];
    for (const tx of transactions) {
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
      if (d > firstDate && d < lastDate && !sortedTx.some(t => t.date === d)) {
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
      const totalDays = (d2.getTime() - d1.getTime()) / (86400000);
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

  // Helper to get price with forward-fill
  function getPrice(ticker: string, date: string, prevPrice: number): number {
    const priceMap = historicalPrices.get(ticker);
    if (!priceMap) return prevPrice;
    return priceMap.get(date) ?? prevPrice;
  }

  // Compute daily values
  const history: PortfolioHistoryPoint[] = [];
  let cashPln = 0;
  let cashUsd = 0;
  let cashCad = 0;
  let cashEur = 0;
  let investedCumulative = 0;
  const holdings = new Map<string, number>(); // isin -> shares
  let benchShares = 0;
  let benchPriceAvailable = false; // true once we have real benchmark data
  let pendingBenchDeposit = 0; // deposits before benchmark data is available

  // TWR tracking: chain daily sub-period returns
  let twrCumulative = 1; // product of (1 + daily return)
  let benchTwrCumulative = 1;
  let prevTotalValue = 0; // previous day's total value
  let prevBenchValue = 0;

  // Track previous prices for forward-fill
  const prevPrices = new Map<string, number>();

  for (const date of dates) {
    // Update cash balances per currency
    cashPln += dailyCashFlowPln.get(date) || 0;
    cashUsd += dailyCashFlowUsd.get(date) || 0;
    cashCad += dailyCashFlowCad.get(date) || 0;
    cashEur += dailyCashFlowEur.get(date) || 0;

    // Update holdings
    const changes = holdingsChanges.get(date);
    if (changes) {
      for (const [isin, qty] of changes) {
        holdings.set(isin, (holdings.get(isin) || 0) + qty);
      }
    }

    // Update invested cumulative
    const deposit = dailyDeposit.get(date) || 0;
    investedCumulative += deposit;

    // Skip days before first deposit (no money in account yet)
    if (investedCumulative <= 0) continue;

    // Get FX rates for the day
    const usdPln = getPrice('USDPLN=X', date, prevPrices.get('USDPLN=X') || 4.0);
    const cadPln = getPrice('CADPLN=X', date, prevPrices.get('CADPLN=X') || 2.95);
    const eurPln = getPrice('EURPLN=X', date, prevPrices.get('EURPLN=X') || 4.3);
    prevPrices.set('USDPLN=X', usdPln);
    prevPrices.set('CADPLN=X', cadPln);
    prevPrices.set('EURPLN=X', eurPln);

    // Compute stock value in PLN
    let stockValuePln = 0;

    for (const [isin, shares] of holdings) {
      if (shares <= 0) continue;
      const entry = tickerMap.get(isin);
      if (!entry) continue;

      const price = getPrice(entry.ticker, date, prevPrices.get(entry.ticker) || 0);
      prevPrices.set(entry.ticker, price);

      let fx = 1;
      if (entry.currency === 'USD') fx = usdPln;
      else if (entry.currency === 'CAD') fx = cadPln;
      else if (entry.currency === 'EUR') fx = eurPln;

      stockValuePln += shares * price * fx;
    }

    // Total cash in PLN (convert foreign currency balances)
    const totalCashPln = Math.max(cashPln, 0)
      + Math.max(cashUsd, 0) * usdPln
      + Math.max(cashCad, 0) * cadPln
      + Math.max(cashEur, 0) * eurPln;

    const totalValue = stockValuePln + totalCashPln;

    // Benchmark DCA — only buy once real price data is available
    const benchKey = `benchmark_${benchmarkTicker}`;
    const benchRawPrice = getPrice(benchKey, date, prevPrices.get(benchKey) || 0);
    if (!benchPriceAvailable && benchRawPrice > 0) {
      const benchPriceMap = historicalPrices.get(benchKey);
      if (benchPriceMap && benchPriceMap.has(date)) {
        benchPriceAvailable = true;
      }
    }
    const benchPrice = benchPriceAvailable ? benchRawPrice : 0;
    prevPrices.set(benchKey, benchRawPrice);

    if (benchPrice > 0 && (deposit > 0 || pendingBenchDeposit > 0)) {
      benchShares += (deposit + pendingBenchDeposit) / benchPrice;
      pendingBenchDeposit = 0;
    } else if (deposit > 0) {
      pendingBenchDeposit += deposit;
    }
    const benchValue = benchShares * benchPrice;

    const returnPct = investedCumulative > 0
      ? ((totalValue - investedCumulative) / investedCumulative) * 100
      : 0;

    const benchReturnPct = (investedCumulative > 0 && benchPriceAvailable)
      ? ((benchValue - investedCumulative) / investedCumulative) * 100
      : 0;

    // TWR: chain daily returns, adjusting denominator for cash flows
    // dailyReturn = V_today / (V_yesterday + cashFlow_today) - 1
    if (prevTotalValue > 0) {
      const denominator = prevTotalValue + deposit;
      if (denominator > 0) {
        twrCumulative *= totalValue / denominator;
      }
    } else if (totalValue > 0) {
      // First day with value — TWR starts at 1 (0%)
      twrCumulative = 1;
    }

    if (prevBenchValue > 0 && benchPrice > 0) {
      const benchDenom = prevBenchValue + deposit;
      if (benchDenom > 0) {
        benchTwrCumulative *= benchValue / benchDenom;
      }
    } else if (benchValue > 0) {
      benchTwrCumulative = 1;
    }

    prevTotalValue = totalValue;
    prevBenchValue = benchValue;

    const twrPct = (twrCumulative - 1) * 100;
    const benchmarkTwrPct = (benchTwrCumulative - 1) * 100;

    history.push({
      date,
      portfolioValue: totalValue,
      returnPct,
      twrPct,
      benchmarkValue: benchValue,
      benchmarkReturnPct: benchReturnPct,
      benchmarkTwrPct,
      investedCumulative,
    });
  }

  // Compute metrics
  const lastPoint = history[history.length - 1];
  const depositsList = operations
    .filter(op => op.operationType === 'deposit' && op.amount > 0 && op.currency === 'PLN')
    .map(op => ({ date: op.date, amount: op.amount }));

  const totalDividends = operations
    .filter(op => op.operationType === 'dividend')
    .reduce((sum, op) => sum + op.amount, 0);

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
  };

  return { history, metrics };
}

// ============ Cash Flow History ============

export function computeCashFlow(operations: CashOperation[], portfolioHistory: PortfolioHistoryPoint[]): CashFlowRecord[] {
  const historyMap = new Map(portfolioHistory.map(p => [p.date, p]));
  const deposits = operations.filter(op => op.operationType === 'deposit' && op.amount > 0 && op.currency === 'PLN');

  let cumulative = 0;
  const records: CashFlowRecord[] = [];

  for (const dep of deposits.sort((a, b) => a.date.localeCompare(b.date))) {
    cumulative += dep.amount;
    const date = dep.date.split('T')[0];
    const histPoint = historyMap.get(date);
    records.push({
      date,
      depositAmount: dep.amount,
      cumulativeDeposits: cumulative,
      portfolioValue: histPoint?.portfolioValue || cumulative,
    });
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

  // Transactions: buy = cash outflow, sell = cash inflow
  for (const tx of transactions) {
    const impact = tx.side === 'K' ? -tx.total : tx.total;
    add(tx.currency, impact);
  }

  // Remove currencies with negligible balances (< 0.01)
  for (const [currency, balance] of Object.entries(balances)) {
    if (Math.abs(balance) < 0.01) {
      delete balances[currency];
    }
  }

  return balances;
}
