import type { Transaction, TickerMapEntry } from 'shared';

/**
 * Represents a detected or manually entered stock split event.
 */
export interface DetectedSplit {
  ticker: string;
  isin: string;
  /** Date when the split was detected (transaction date with price discrepancy) */
  date: string;
  /** Split ratio: e.g. 10 for 10:1 split, 0.2 for 1:5 reverse split */
  ratio: number;
  /** Transaction price that triggered detection */
  txPrice: number;
  /** Provider price on that date (before rescaling) */
  providerPrice: number;
  source: 'auto' | 'manual';
}

/** Minimum price discrepancy threshold to consider a split (15%) */
const SPLIT_THRESHOLD = 0.15;

/**
 * Detect stock splits by comparing transaction prices with provider (Yahoo/Stooq) prices.
 *
 * Providers return split-adjusted prices, so a pre-split transaction at 1070 will show
 * a provider price of 107 after a 10:1 split. We detect the ratio per transaction date
 * and can handle multiple splits over time for the same ticker.
 *
 * Only compares when tx currency matches ticker currency (avoids FX false positives).
 */
export function detectSplits(
  transactions: Transaction[],
  historicalPrices: Map<string, Map<string, number>>,
  tickerMap: Map<string, TickerMapEntry>,
): DetectedSplit[] {
  const splits: DetectedSplit[] = [];
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

  // Track cumulative scaling already applied per ticker so we can detect subsequent splits
  const cumulativeRatio = new Map<string, number>();

  for (const tx of sorted) {
    const entry = tickerMap.get(tx.isin);
    if (!entry) continue;

    // Skip if currencies don't match (FX difference, not split)
    if (tx.currency !== entry.currency) continue;

    const dateKey = tx.date.split('T')[0];
    const priceMap = historicalPrices.get(entry.ticker);
    if (!priceMap) continue;

    const providerPrice = priceMap.get(dateKey);
    if (!providerPrice || providerPrice <= 0) continue;

    // Apply any already-detected scaling for this ticker to compare fairly
    const currentRatio = cumulativeRatio.get(entry.ticker) ?? 1;
    const scaledProviderPrice = providerPrice * currentRatio;

    const discrepancy = Math.abs(tx.price / scaledProviderPrice - 1);
    if (discrepancy > SPLIT_THRESHOLD) {
      const newRatio = tx.price / scaledProviderPrice;
      splits.push({
        ticker: entry.ticker,
        isin: tx.isin,
        date: dateKey,
        ratio: newRatio,
        txPrice: tx.price,
        providerPrice: scaledProviderPrice,
        source: 'auto',
      });
      cumulativeRatio.set(entry.ticker, currentRatio * newRatio);
    }
  }

  return splits;
}

/**
 * Rescale all historical provider prices to match the actual transaction price scale.
 *
 * After rescaling, the price history is consistent with original (non-adjusted) transaction
 * prices. This is needed because providers return split-adjusted prices that differ from
 * what the user actually paid.
 *
 * Splits are applied cumulatively: if a ticker had a 10:1 split and then a 2:1 split,
 * prices before the first split get rescaled by 20x total.
 */
export function rescaleHistoricalPrices(
  historicalPrices: Map<string, Map<string, number>>,
  splits: DetectedSplit[],
): void {
  // Group splits by ticker, sorted chronologically
  const splitsByTicker = new Map<string, DetectedSplit[]>();
  for (const split of splits) {
    const arr = splitsByTicker.get(split.ticker) || [];
    arr.push(split);
    splitsByTicker.set(split.ticker, arr);
  }

  for (const [ticker, tickerSplits] of splitsByTicker) {
    const priceMap = historicalPrices.get(ticker);
    if (!priceMap) continue;

    const sortedSplits = [...tickerSplits].sort((a, b) => a.date.localeCompare(b.date));

    // Compute the total cumulative ratio (product of all split ratios)
    const totalRatio = sortedSplits.reduce((acc, s) => acc * s.ratio, 1);

    // Rescale all prices by the total cumulative ratio
    for (const [date, price] of priceMap) {
      priceMap.set(date, price * totalRatio);
    }
  }
}

/**
 * Create adjusted copies of transactions to account for stock splits.
 *
 * For transactions that occurred BEFORE a split date:
 * - quantity is multiplied by the split ratio
 * - price is divided by the split ratio
 * - value remains unchanged (quantity * price = const)
 *
 * This ensures FIFO calculations work correctly with post-split share counts.
 */
export function adjustTransactionsForSplits(
  transactions: Transaction[],
  splits: DetectedSplit[],
): Transaction[] {
  if (splits.length === 0) return transactions;

  // Group splits by ISIN, sorted chronologically
  const splitsByIsin = new Map<string, DetectedSplit[]>();
  for (const split of splits) {
    const arr = splitsByIsin.get(split.isin) || [];
    arr.push(split);
    splitsByIsin.set(split.isin, arr);
  }

  return transactions.map(tx => {
    const isinSplits = splitsByIsin.get(tx.isin);
    if (!isinSplits) return tx;

    const txDate = tx.date.split('T')[0];

    // Compute cumulative ratio from splits that happened AFTER this transaction
    let ratio = 1;
    for (const split of isinSplits) {
      if (split.date > txDate) {
        ratio *= split.ratio;
      }
    }

    if (ratio === 1) return tx;

    return {
      ...tx,
      quantity: tx.quantity * ratio,
      price: tx.price / ratio,
      // value stays the same (quantity * price is unchanged)
    };
  });
}
