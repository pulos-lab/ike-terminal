import type { Transaction, CashOperation, Position, ClosedTrade, ClosedTradeFee, TickerMapEntry, PortfolioHistoryPoint, PortfolioMetrics, DividendRecord, FxExchangeRecord, CashFlowRecord, DetectedSplit } from 'shared';
import { fetchYahooPrice, fetchFxRate, fetchYahooHistory, fetchYahooHistoryDirect } from './yahoo-finance.js';
import { fetchStooqPrice, fetchStooqHistory, fetchStooqPreviousClose } from './stooq.js';
import { detectSplits, rescaleHistoricalPrices, adjustTransactionsForSplits, detectSplitFromQuantityMismatch, isPlausibleSplitRatio, snapToKnownRatio } from './split-detector.js';
import { getDb } from '../db/connection.js';

// ============ Split Helpers ============

/** Merge saved splits with newly detected ones, deduplicating by (isin, date). */
function mergeDetectedSplits(saved: DetectedSplit[], detected: DetectedSplit[]): DetectedSplit[] {
  const map = new Map<string, DetectedSplit>();
  for (const s of saved) map.set(s.isin, s);
  for (const s of detected) {
    if (!map.has(s.isin)) map.set(s.isin, s);
  }
  return [...map.values()];
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
  existingSplits: DetectedSplit[]
): Promise<DetectedSplit[]> {
  const detected: DetectedSplit[] = [];

  // ISINs that already have splits don't need re-detection
  const isinsWithSplits = new Set(existingSplits.map(s => s.isin));

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
        const match = data.find(d => d.date === dateKey);
        freshPrice = match?.close ?? null;
      }

      if (!freshPrice || freshPrice <= 0) return;

      const rawRatio = tx.price / freshPrice;
      if (isPlausibleSplitRatio(rawRatio)) {
        detected.push({
          ticker: entry.ticker,
          isin,
          date: new Date().toISOString().split('T')[0], // FIX: use today, not transaction date
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
  return detected;
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
  tickerMap: Map<string, TickerMapEntry>,
  splits: DetectedSplit[] = [],
): Promise<{ positions: Position[]; totalValuePln: number; detectedSplits: DetectedSplit[] }> {
  // Lightweight split detection: for each ISIN, fetch the provider price on the
  // earliest transaction date and compare. This catches splits even if the user
  // hasn't visited the dashboard yet (which runs the full history-based detection).
  const priceSplits = await detectSplitsFromTransactions(transactions, tickerMap, splits);

  // Additional detection: sell quantity exceeding accumulated buys
  const qtySplits = detectSplitFromQuantityMismatch(transactions);
  const qtySplitsAsDetected: DetectedSplit[] = qtySplits
    .filter(qs => !splits.some(s => s.isin === qs.isin)) // skip already known
    .map(qs => {
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

  // Adjust transactions for stock splits (quantity/price correction)
  const adjustedTxs = adjustTransactionsForSplits(transactions, allSplits);

  // Group by ISIN
  const byIsin = new Map<string, Transaction[]>();
  for (const tx of adjustedTxs) {
    const arr = byIsin.get(tx.isin) || [];
    arr.push(tx);
    byIsin.set(tx.isin, arr);
  }

  // Get FX rates — collect all currencies from ticker map and transactions
  const liveCurrencies = new Set<string>();
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
  const fxRates: Record<string, number> = { PLN: 1 };
  const defaultFx: Record<string, number> = {
    USD: 4.0, CAD: 2.95, EUR: 4.3, GBP: 5.1, NOK: 0.38, HKD: 0.52, JPY: 0.028,
    CHF: 4.5, SEK: 0.39, DKK: 0.58, AUD: 2.65, SGD: 3.0, CZK: 0.17, MXN: 0.22,
  };
  await Promise.all([...liveCurrencies].map(async (cur) => {
    const rate = await fetchFxRate(`${cur}PLN`);
    fxRates[cur] = rate || defaultFx[cur] || 1;
    // Also store GBp → GBP alias so ticker map entries with 'GBp' currency work
    if (cur === 'GBP') fxRates['GBp'] = fxRates[cur];
  }));

  const positions: Position[] = [];
  let totalValuePln = 0;

  for (const [isin, txs] of byIsin) {
    const metrics = computePositionMetrics(txs);
    if (metrics.shares < EPSILON) continue;

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
      const currentValueNative = metrics.shares * fallbackPrice;
      const currentValuePln = currentValueNative * fxNativeToPln;
      let costBasisPln = 0;
      for (const lot of metrics.buyLots) {
        const lotFx = fxRates[lot.currency] || 1;
        costBasisPln += lot.quantity * lot.price * lotFx;
      }
      const profitLossPln = currentValuePln - costBasisPln;
      const profitLossPct = costBasisPln > 0 ? (profitLossPln / costBasisPln) * 100 : 0;
      const avgBuyPriceNative = metrics.shares > 0 ? costBasisPln / fxNativeToPln / metrics.shares : 0;
      const costBasisNative = metrics.shares * avgBuyPriceNative;
      const profitLossNative = currentValueNative - costBasisNative;
      totalValuePln += currentValuePln;
      const category = txs[0]?.category || 'stock';
      positions.push({
        paperName: fallbackEntry.name,
        isin,
        ticker: fallbackEntry.ticker,
        shares: metrics.shares,
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
        buyLots: metrics.buyLots.map(lot => ({
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
    if (entry.exchange === 'NC') {
      // NewConnect: Stooq only (Yahoo doesn't list all NC stocks)
      currentPrice = await fetchStooqPrice(entry.ticker);
      previousClose = await fetchStooqPreviousClose(entry.ticker);
    } else {
      // GPW (.WA) + foreign: Yahoo (to preserve Stooq daily quota)
      const yp = await fetchYahooPrice(entry.ticker);
      currentPrice = yp?.price || null;
      previousClose = yp?.previousClose ?? null;
    }

    // Fallback: if live price unavailable, use last transaction price
    if (currentPrice === null) {
      const lastTx = [...txs].sort((a, b) => b.date.localeCompare(a.date))[0];
      currentPrice = lastTx?.price || 0;
      priceManual = true;
    }

    // Daily change %
    const dailyChangePct = (currentPrice != null && previousClose != null && previousClose > 0)
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

    // Determine category from the first transaction
    const category = txs[0]?.category || 'stock';

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
      category,
      priceManual: priceManual || undefined,
      buyLots: metrics.buyLots.map(lot => {
        // Convert lot price to the paper's native currency for consistent display
        const lotFx = fxRates[lot.currency] || 1;
        const priceInNativeCurrency = lot.currency === entry.currency
          ? lot.price
          : lot.price * lotFx / fxNativeToPln;
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

function roundTo2(n: number): number { return Math.round(n * 100) / 100; }

export function computeClosedTrades(
  transactions: Transaction[],
  tickerMap: Map<string, TickerMapEntry>,
  operations?: CashOperation[],
  splits: DetectedSplit[] = [],
): ClosedTrade[] {
  // Adjust transactions for stock splits (quantity/price correction)
  const adjustedTxs = adjustTransactionsForSplits(transactions, splits);

  // Group transactions by ISIN (or ISIN + positionId for CFD to prevent mixing overlapping positions)
  const byGroup = new Map<string, Transaction[]>();
  for (const tx of adjustedTxs) {
    const groupKey = tx.cfdPositionId ? `${tx.isin}|cfd|${tx.cfdPositionId}` : tx.isin;
    const arr = byGroup.get(groupKey) || [];
    arr.push(tx);
    byGroup.set(groupKey, arr);
  }

  const closedTrades: ClosedTrade[] = [];

  for (const [groupKey, txs] of byGroup) {
    const isin = txs[0].isin; // clean ISIN for display/lookup
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const buyQueue: Array<{ quantity: number; price: number; commission: number; date: string }> = [];
    const shortQueue: Array<{ quantity: number; price: number; commission: number; date: string; sellTx: Transaction }> = [];
    const entry = tickerMap.get(isin);

    for (const tx of sorted) {
      if (tx.side === 'K') {
        // If there are open short positions, this buy covers them (FIFO)
        if (shortQueue.length > 0) {
          let remaining = tx.quantity;
          const commissionPerShare = tx.commission / tx.quantity;

          while (remaining > EPSILON && shortQueue.length > 0) {
            const shortLot = shortQueue[0];
            const matched = Math.min(remaining, shortLot.quantity);
            if (matched < EPSILON) { shortQueue.shift(); continue; }

            const shortDate = new Date(shortLot.date);
            const coverDate = new Date(tx.date);
            const holdingDays = Math.floor((coverDate.getTime() - shortDate.getTime()) / (1000 * 60 * 60 * 24));

            const sellComm = shortLot.commission * (matched / shortLot.quantity);
            const coverComm = matched * commissionPerShare;

            // Proportional swap/rollover from cover transaction (CFD shorts)
            const lotSwap = tx.swap ? roundTo2(tx.swap * (matched / tx.quantity)) : 0;
            const lotRollover = tx.rollover ? roundTo2(tx.rollover * (matched / tx.quantity)) : 0;
            const tradeFees: ClosedTradeFee[] = [];
            if (lotSwap > 0) tradeFees.push({ type: 'swap', amount: lotSwap, description: `swap: ${tx.paperName}` });
            if (lotRollover > 0) tradeFees.push({ type: 'rollover', amount: lotRollover, description: `rollover: ${tx.paperName}` });
            const feesTotal = lotSwap + lotRollover;

            // Short P/L: use XTB gross profit when available (includes contract multiplier + FX)
            const grossProfitPortion = tx.cfdGrossProfit !== undefined
              ? roundTo2(tx.cfdGrossProfit * (matched / tx.quantity))
              : (matched * shortLot.price) - (matched * tx.price);
            const pl = grossProfitPortion - sellComm - coverComm - feesTotal;
            // Percentage: derive notional value from gross profit + price change for CFD
            let plPct: number;
            if (tx.cfdGrossProfit !== undefined) {
              const priceChange = shortLot.price > 0 ? (shortLot.price - tx.price) / shortLot.price : 0;
              const notional = Math.abs(priceChange) > 1e-6 ? Math.abs(grossProfitPortion / priceChange) : 0;
              plPct = notional > 0 ? (pl / notional) * 100 : 0;
            } else {
              const coverValue = matched * tx.price;
              plPct = coverValue > 0 ? (pl / coverValue) * 100 : 0;
            }

            closedTrades.push({
              paperName: entry?.name || tx.paperName,
              isin,
              ticker: entry?.ticker || isin,
              quantity: matched,
              buyDate: shortLot.date,    // short sell date
              buyPrice: shortLot.price,  // short sell price
              buyCommission: sellComm,
              sellDate: tx.date,         // cover date
              sellPrice: tx.price,       // cover price
              sellCommission: coverComm,
              profitLoss: pl,
              profitLossPct: plPct,
              holdingDays,
              currency: tx.currency,
              sellTransactionId: shortLot.sellTx.id!,
              sellSource: shortLot.sellTx.source,
              category: tx.category,
              isShort: true,
              fees: tradeFees.length > 0 ? tradeFees : undefined,
              totalCost: sellComm + coverComm + feesTotal,
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
            });
          }
        } else {
          buyQueue.push({
            quantity: tx.quantity,
            price: tx.price,
            commission: tx.commission,
            date: tx.date,
          });
        }
      } else {
        // FIFO sell — consume buy lots first
        let remaining = tx.quantity;
        const commissionPerShare = tx.commission / tx.quantity;

        while (remaining > EPSILON && buyQueue.length > 0) {
          const lot = buyQueue[0];
          const matched = Math.min(remaining, lot.quantity);
          if (matched < EPSILON) { buyQueue.shift(); continue; }

          const buyDate = new Date(lot.date);
          const sellDate = new Date(tx.date);
          const holdingDays = Math.floor((sellDate.getTime() - buyDate.getTime()) / (1000 * 60 * 60 * 24));

          const buyComm = lot.commission * (matched / lot.quantity);
          const sellComm = matched * commissionPerShare;

          // Proportional swap/rollover from sell transaction (CFD)
          const lotSwap = tx.swap ? roundTo2(tx.swap * (matched / tx.quantity)) : 0;
          const lotRollover = tx.rollover ? roundTo2(tx.rollover * (matched / tx.quantity)) : 0;
          const tradeFees: ClosedTradeFee[] = [];
          if (lotSwap > 0) tradeFees.push({ type: 'swap', amount: lotSwap, description: `swap: ${tx.paperName}` });
          if (lotRollover > 0) tradeFees.push({ type: 'rollover', amount: lotRollover, description: `rollover: ${tx.paperName}` });
          const feesTotal = lotSwap + lotRollover;

          // P/L: use XTB gross profit when available (CFD: includes contract multiplier + FX)
          const grossProfitPortion = tx.cfdGrossProfit !== undefined
            ? roundTo2(tx.cfdGrossProfit * (matched / tx.quantity))
            : (matched * tx.price) - (matched * lot.price);
          const pl = grossProfitPortion - buyComm - sellComm - feesTotal;
          // Percentage: derive notional value from gross profit + price change for CFD
          let plPct: number;
          if (tx.cfdGrossProfit !== undefined) {
            const priceChange = lot.price > 0 ? (tx.price - lot.price) / lot.price : 0;
            const notional = Math.abs(priceChange) > 1e-6 ? Math.abs(grossProfitPortion / priceChange) : 0;
            plPct = notional > 0 ? (pl / notional) * 100 : 0;
          } else {
            const buyValue = matched * lot.price;
            plPct = buyValue > 0 ? (pl / buyValue) * 100 : 0;
          }

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
            category: tx.category,
            fees: tradeFees.length > 0 ? tradeFees : undefined,
            totalCost: buyComm + sellComm + feesTotal,
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
  }

  // ── Match fee operations to closed trades by ticker/isin + date range ──
  // Only operationType='fee' is matched here (e.g. DEGIRO exchange fees, Sec Fee).
  // CFD swap/rollover is embedded directly on the sell transaction (via Position ID).
  if (operations?.length) {
    const feeOps = operations.filter(op => op.operationType === 'fee' && op.ticker);

    // Pass 1: sum total matching quantity per fee (for proportional split by quantity)
    const feeMatchQty = new Map<number, number>();
    for (let i = 0; i < feeOps.length; i++) {
      const fee = feeOps[i];
      const feeDate = fee.date.slice(0, 10);
      let totalQty = 0;
      for (const trade of closedTrades) {
        const tickerMatch = fee.ticker === trade.ticker || fee.ticker === trade.isin;
        if (tickerMatch && feeDate >= trade.buyDate.slice(0, 10) && feeDate <= trade.sellDate.slice(0, 10)) {
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
        const buyValue = trade.quantity * trade.buyPrice;
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

/**
 * Calculate the number of shares held for a given ISIN at a specific date.
 * Processes K (buy) and S (sell) transactions chronologically up to and including the date.
 */
export function getSharesAtDate(
  transactions: Transaction[],
  isin: string,
  date: string
): number {
  return transactions
    .filter(t => t.isin === isin && t.date <= date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .reduce((shares, t) => {
      return t.side === 'K' ? shares + t.quantity : shares - t.quantity;
    }, 0);
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
    // Sort by id so paired inserts stay together
    ops.sort((a, b) => (a.id || 0) - (b.id || 0));
    for (let i = 0; i < ops.length - 1; i += 2) {
      const [first, second] = [ops[i], ops[i + 1]];
      const fromOp = first.amount < 0 ? first : second;
      const toOp = first.amount < 0 ? second : first;
      if (fromOp.amount < 0 && toOp.amount > 0) {
        records.push({
          date,
          pair: fromOp.fxPair || `${fromOp.currency}/${toOp.currency}`,
          rate: fromOp.fxRate || (Math.abs(fromOp.amount) / toOp.amount),
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
  }

  return records.sort((a, b) => b.date.localeCompare(a.date));
}

// ============ XIRR Calculation ============

export function computeXirr(deposits: Array<{ date: string; amount: number }>, currentValue: number): number {
  const cashflows: Array<{ date: Date; amount: number }> = deposits.map(d => ({
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
  benchmarkSource: 'yahoo' | 'stooq' | 'none',
  startDate?: string,
  endDate?: string,
  splits: DetectedSplit[] = [],
): Promise<{ history: PortfolioHistoryPoint[]; metrics: PortfolioMetrics; detectedSplits: DetectedSplit[] }> {
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

  // Build daily deposits and withdrawals per currency. Conversion to PLN
  // happens in the main loop using that day's FX rate — only PLN-normalized
  // values are used for MWR/TWR/benchmark DCA, so totalValue (in PLN) and
  // totalDeposited (in PLN) are on the same scale.
  const dailyDepositByCur = new Map<string, Map<string, number>>();
  const dailyWithdrawalByCur = new Map<string, Map<string, number>>();
  for (const op of operations) {
    const date = op.date.split('T')[0];
    const cur = (op.currency || 'PLN').toUpperCase();
    const target = op.operationType === 'deposit' && op.amount > 0
      ? dailyDepositByCur
      : op.operationType === 'withdrawal'
        ? dailyWithdrawalByCur
        : null;
    if (!target) continue;
    let map = target.get(date);
    if (!map) { map = new Map(); target.set(date, map); }
    map.set(cur, (map.get(cur) || 0) + Math.abs(op.amount));
  }

  // Keep the flat "has any deposit/withdrawal on this day" view for lastActivityDate below.
  const dailyDeposit = new Map<string, number>();
  const dailyWithdrawal = new Map<string, number>();
  for (const [date, curMap] of dailyDepositByCur) {
    let s = 0; for (const v of curMap.values()) s += v;
    dailyDeposit.set(date, s);
  }
  for (const [date, curMap] of dailyWithdrawalByCur) {
    let s = 0; for (const v of curMap.values()) s += v;
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

  // Get unique ISINs that were ever held (ISINs don't change with split adjustment)
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

  // Fetch historical data — Yahoo-first for GPW, Stooq only for NewConnect
  const fetchPromises = tickersToFetch.map(async ({ ticker, source, isin }) => {
    const entry = tickerMap.get(isin);
    let data: Array<{ date: string; close: number }>;
    if (entry?.exchange === 'NC') {
      // NewConnect: Stooq only (Yahoo doesn't list all NC stocks)
      data = await fetchStooqHistory(ticker, start);
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
  for (const tx of transactions) allCurrencies.add(normalizeCurrency(tx.currency));
  // Also include currencies from ticker map (stock prices in foreign currency)
  for (const entry of tickerMap.values()) {
    if (entry.currency) allCurrencies.add(normalizeCurrency(entry.currency));
  }
  allCurrencies.delete('PLN'); // PLN doesn't need FX rate

  // Fetch FX rates for all currencies
  for (const cur of allCurrencies) {
    const fxTicker = `${cur}PLN=X`;
    fetchPromises.push((async () => {
      const data = await fetchYahooHistory(fxTicker, start, end);
      const priceMap = new Map<string, number>();
      for (const d of data) priceMap.set(d.date, d.close);
      historicalPrices.set(fxTicker, priceMap);
    })());
  }

  // Fetch benchmark (skip when disabled)
  if (benchmarkSource !== 'none') {
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
  }

  await Promise.all(fetchPromises);

  // Detect stock splits by comparing transaction prices with provider prices.
  // Merge with any previously saved/manual splits passed in.
  const newlyDetected = detectSplits(transactions, historicalPrices, tickerMap);
  const allSplits = mergeDetectedSplits(splits, newlyDetected);

  // Adjust transactions for splits: convert pre-split transactions to post-split scale
  // (quantity * ratio, price / ratio). Provider prices are already split-adjusted, so
  // after this adjustment, everything is in the same (post-split) scale.
  const adjustedTxs = adjustTransactionsForSplits(transactions, allSplits);

  // Overwrite transaction date prices with adjusted tx prices (same currency only).
  // This ensures exact match on transaction dates even if provider data differs slightly.
  const sortedTxForScaling = [...adjustedTxs].sort((a, b) => a.date.localeCompare(b.date));
  for (const tx of sortedTxForScaling) {
    const entry = tickerMap.get(tx.isin);
    if (!entry) continue;
    // Normalize currencies for comparison (GBX/GBp/GBP are all equivalent)
    const txCurNorm = tx.currency.toUpperCase() === 'GBX' ? 'GBP' : tx.currency.toUpperCase();
    const entryCurNorm = entry.currency.toUpperCase() === 'GBX' ? 'GBP' : entry.currency.toUpperCase();
    if (txCurNorm !== entryCurNorm) continue;
    const dateKey = tx.date.split('T')[0];
    const priceMap = historicalPrices.get(entry.ticker);
    if (priceMap) {
      // Yahoo stores .L prices in GBX (pence) — convert adjusted GBP price back to GBX
      const priceForMap = (txCurNorm === 'GBP' && entry.ticker.endsWith('.L'))
        ? tx.price * 100
        : tx.price;
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
  // price data is missing on the purchase date (prevents stock value = 0)
  const txPriceByTicker = new Map<string, number>();
  for (const tx of adjustedTxs) {
    const entry = tickerMap.get(tx.isin);
    if (entry && tx.price > 0 && !txPriceByTicker.has(entry.ticker)) {
      txPriceByTicker.set(entry.ticker, tx.price);
    }
  }

  // Determine the last date of any activity (deposit, withdrawal, or transaction)
  const allActivityDates = [
    ...Array.from(dailyDeposit.keys()),
    ...Array.from(dailyWithdrawal.keys()),
    ...transactions.map(tx => tx.date.split('T')[0]),
  ];
  const lastActivityDate = allActivityDates.length > 0
    ? allActivityDates.sort().pop()!
    : end;

  // Compute daily values
  const history: PortfolioHistoryPoint[] = [];
  let firstDepositSeen = false;
  const cashByCurrency = new Map<string, number>(); // currency -> balance
  let investedCumulative = 0;
  let totalDeposited = 0;   // sum of all deposits (always positive, for MWR base)
  let totalWithdrawn = 0;   // sum of all withdrawals (always positive, for MWR)
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

    // Track first deposit (any currency) for chart start guard
    const hadDepositToday = dailyDepositByCur.has(date);
    if (hadDepositToday) firstDepositSeen = true;

    // Skip days before first deposit (no money in account yet)
    if (!firstDepositSeen) continue;

    // Get FX rates for the day (generic — all non-PLN currencies)
    const fxRates = new Map<string, number>(); // currency -> PLN rate
    fxRates.set('PLN', 1);
    const defaultFxRates: Record<string, number> = {
      USD: 4.0, CAD: 2.95, EUR: 4.3, GBP: 5.1, NOK: 0.38, HKD: 0.52, JPY: 0.028,
      CHF: 4.5, SEK: 0.39, DKK: 0.58, AUD: 2.65, SGD: 3.0, CZK: 0.17, MXN: 0.22,
    };
    for (const cur of allCurrencies) {
      const fxTicker = `${cur}PLN=X`;
      const rate = getPrice(fxTicker, date, prevPrices.get(fxTicker) || defaultFxRates[cur] || 1);
      prevPrices.set(fxTicker, rate);
      fxRates.set(cur, rate);
    }
    dailyFxRates.set(date, new Map(fxRates));

    // Convert today's deposits / withdrawals to PLN using this day's FX rates.
    // All downstream math (totalDeposited, netCashFlow for TWR, benchmark DCA)
    // uses PLN to stay consistent with totalValue (also in PLN).
    let depositPln = 0;
    const depositByCur = dailyDepositByCur.get(date);
    if (depositByCur) {
      for (const [cur, amt] of depositByCur) {
        depositPln += amt * (fxRates.get(cur) ?? defaultFxRates[cur] ?? 1);
      }
    }
    let withdrawalPln = 0;
    const withdrawalByCur = dailyWithdrawalByCur.get(date);
    if (withdrawalByCur) {
      for (const [cur, amt] of withdrawalByCur) {
        withdrawalPln += amt * (fxRates.get(cur) ?? defaultFxRates[cur] ?? 1);
      }
    }
    investedCumulative += depositPln;
    investedCumulative -= withdrawalPln;
    totalDeposited += depositPln;
    totalWithdrawn += withdrawalPln;

    // Compute stock value in PLN
    let stockValuePln = 0;

    for (const [isin, shares] of holdings) {
      if (shares < EPSILON) continue;
      const entry = tickerMap.get(isin);
      if (!entry) continue;

      let price = getPrice(entry.ticker, date, prevPrices.get(entry.ticker) || txPriceByTicker.get(entry.ticker) || 0);
      prevPrices.set(entry.ticker, price);

      // Yahoo returns London-listed prices in GBX (pence) — convert to GBP
      const upperCur = entry.currency.toUpperCase();
      const isGbx = upperCur === 'GBP' || upperCur === 'GBX';
      if (isGbx && entry.ticker.endsWith('.L')) {
        price = price / 100;
      }

      const fx = fxRates.get(upperCur === 'GBX' ? 'GBP' : upperCur) || 1;
      stockValuePln += shares * price * fx;
    }

    // Total cash in PLN (convert all foreign currency balances)
    let totalCashPln = 0;
    for (const [cur, balance] of cashByCurrency) {
      const fx = fxRates.get(cur) || 1;
      totalCashPln += balance * fx;
    }

    const totalValue = stockValuePln + totalCashPln;

    // Benchmark DCA — only buy once real price data is available
    const benchKey = `benchmark_${benchmarkTicker}`;
    const benchRawPrice = getPrice(benchKey, date, prevPrices.get(benchKey) || 0);
    if (!benchPriceAvailable && benchRawPrice > 0) {
      const benchPriceMap = historicalPrices.get(benchKey);
      if (benchPriceMap && benchPriceMap.has(date)) {
        benchPriceAvailable = true;
        firstBenchPrice = benchRawPrice;
      }
    }
    const benchPrice = benchPriceAvailable ? benchRawPrice : 0;
    prevPrices.set(benchKey, benchRawPrice);

    if (benchPrice > 0 && (depositPln > 0 || pendingBenchDeposit > 0)) {
      benchShares += (depositPln + pendingBenchDeposit) / benchPrice;
      pendingBenchDeposit = 0;
    } else if (depositPln > 0) {
      pendingBenchDeposit += depositPln;
    }
    // Sell benchmark shares for the same PLN withdrawal amount.
    // This simulates "what if I withdrew the same cash from the benchmark?"
    // If benchmark doesn't have enough value, withdraw everything it has.
    if (withdrawalPln > 0 && benchShares > 0 && benchPrice > 0) {
      const benchValueNow = benchShares * benchPrice;
      const actualBenchWithdraw = Math.min(withdrawalPln, benchValueNow);
      benchShares -= actualBenchWithdraw / benchPrice;
      benchTotalWithdrawn += actualBenchWithdraw;
    }
    const benchValue = benchShares * benchPrice;

    // MWR: use total deposited (not net) as the base for return calculation.
    // This avoids the formula breaking when withdrawals exceed deposits.
    const returnPct = totalDeposited > 0
      ? ((totalValue + totalWithdrawn - totalDeposited) / totalDeposited) * 100
      : 0;

    const benchReturnPct = (totalDeposited > 0 && benchPriceAvailable)
      ? ((benchValue + benchTotalWithdrawn - totalDeposited) / totalDeposited) * 100
      : 0;

    // TWR: chain daily returns, adjusting denominator for cash flows
    // dailyReturn = V_today / (V_yesterday + netCashFlow_today) - 1
    // When a large cash flow makes the denominator very small (< 5% of prevValue),
    // use mid-day timing (Modified Dietz) to prevent near-zero division artifacts.
    // When portfolio is essentially liquidated (totalValue < 1% of peak),
    // freeze TWR to avoid meaningless ratios on residual cash.
    const netCashFlow = depositPln - withdrawalPln;
    if (prevTotalValue > 0 && totalValue > peakTotalValue * 0.01) {
      // Guard: if prevTotalValue is negligible relative to totalValue and there
      // was no cash flow, this is a data artifact (e.g. missing price data on
      // purchase date caused portfolio to be valued at ~0). Skip chaining.
      if (prevTotalValue < totalValue * 0.01 && netCashFlow === 0) {
        // TWR stays unchanged — not a real return
      } else {
        let denominator = prevTotalValue + netCashFlow;
        // Modified Dietz: only apply 0.5 weight for WITHDRAWALS (negative cash flow)
        // that are large relative to portfolio value. This prevents near-zero
        // denominator from inflating returns.
        // For DEPOSITS, the full denominator (prevValue + deposit) is correct —
        // applying 0.5 weight would create artificial returns when deposit >> prevValue
        // (e.g., deposit of 1715 into a 9 PLN portfolio → 99% fake return).
        if (netCashFlow < 0 && Math.abs(netCashFlow) > prevTotalValue * 0.3) {
          denominator = prevTotalValue + 0.5 * netCashFlow;
        }
        if (denominator > 0) {
          twrCumulative *= totalValue / denominator;
        }
      }
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
    const benchmarkTwrPct = (benchPriceAvailable && firstBenchPrice > 0)
      ? ((benchPrice / firstBenchPrice) - 1) * 100
      : 0;

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
    const hasHoldings = Array.from(holdings.values()).some(qty => qty > 0);
    if (!hasHoldings && date >= lastActivityDate && history.length > 1) {
      break;
    }
  }

  // Compute metrics
  const lastPoint = history[history.length - 1];

  // Helper: convert an operation's amount to PLN using that day's FX rate.
  // Falls back to default rate (≈ current market) if the date is outside the
  // history range (e.g. operation pre-firstDepositSeen — rare edge case).
  const defaultFxForXirr: Record<string, number> = {
    USD: 4.0, CAD: 2.95, EUR: 4.3, GBP: 5.1, NOK: 0.38, HKD: 0.52, JPY: 0.028,
    CHF: 4.5, SEK: 0.39, DKK: 0.58, AUD: 2.65, SGD: 3.0, CZK: 0.17, MXN: 0.22,
  };
  const opAmountPln = (op: CashOperation): number => {
    const d = op.date.split('T')[0];
    const cur = (op.currency || 'PLN').toUpperCase();
    const fx = dailyFxRates.get(d)?.get(cur) ?? defaultFxForXirr[cur] ?? 1;
    return op.amount * fx;
  };

  // Include both deposits (positive) and withdrawals (negative) for XIRR,
  // converted to PLN (portfolio.value is in PLN, so cash flows must match).
  const depositsList = operations
    .filter(op => op.operationType === 'deposit' || op.operationType === 'withdrawal')
    .map(op => ({ date: op.date, amount: opAmountPln(op) }));

  const totalDividends = operations
    .filter(op => op.operationType === 'dividend')
    .reduce((sum, op) => sum + opAmountPln(op), 0);

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

  return { history, metrics, detectedSplits: allSplits };
}

// ============ Cash Flow History ============

export function computeCashFlow(operations: CashOperation[], portfolioHistory: PortfolioHistoryPoint[]): CashFlowRecord[] {
  // Build cash flow record for every date that has a deposit or withdrawal
  // (in any currency). Values come from history points which are already
  // PLN-normalized per-day using FX rates from computePortfolioHistory.
  // This keeps cash flow chart consistent with MWR/TWR/portfolio value
  // (wszystkie w PLN na jednej osi).
  const cashOpDates = new Set<string>();
  for (const op of operations) {
    if (op.operationType === 'deposit' || op.operationType === 'withdrawal') {
      cashOpDates.add(op.date.split('T')[0]);
    }
  }

  const records: CashFlowRecord[] = [];
  let prevCumDeposits = 0;
  let prevCumWithdrawals = 0;

  for (const p of portfolioHistory) {
    const dCum = p.cumulativeDepositsPln;
    const wCum = p.cumulativeWithdrawalsPln;
    // Only emit records on days where cash flow actually changed OR an op
    // exists on this date (preserves compatibility with previous behavior
    // that emitted one record per operation date).
    const changed = dCum !== prevCumDeposits || wCum !== prevCumWithdrawals;
    if (!changed && !cashOpDates.has(p.date)) continue;

    records.push({
      date: p.date,
      depositAmount: Math.max(0, dCum - prevCumDeposits),
      withdrawalAmount: Math.max(0, wCum - prevCumWithdrawals),
      cumulativeDeposits: dCum,
      cumulativeWithdrawals: wCum,
      netCashFlow: dCum - wCum,
      portfolioValue: p.portfolioValue,
    });

    prevCumDeposits = dCum;
    prevCumWithdrawals = wCum;
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
