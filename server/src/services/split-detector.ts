import type { Transaction, TickerMapEntry, DetectedSplit } from 'shared';

/** Maximum tolerance when matching a raw ratio to a known split ratio (5%) */
const RATIO_TOLERANCE = 0.05;

/**
 * Known real-world stock split ratios (forward and reverse).
 * The smallest possible split is 2:1 (forward) or 1:2 (reverse),
 * so any ratio between 0.53 and 1.9 is definitely NOT a split.
 */
const KNOWN_SPLIT_RATIOS = [
  // Forward splits (ratio >= 2)
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  10,
  15,
  20,
  25,
  50,
  100,
  // Reverse splits (ratio <= 0.5)
  1 / 2,
  1 / 3,
  1 / 4,
  1 / 5,
  1 / 6,
  1 / 8,
  1 / 10,
  1 / 15,
  1 / 20,
  1 / 25,
  1 / 50,
];

/**
 * Check if a detected ratio is close to a known stock split ratio.
 *
 * The minimum real split is 2:1 (forward) or 1:2 (reverse), so any price
 * discrepancy under 2x is guaranteed to be a normal price movement, not a split.
 * This eliminates false positives from crashes (-40%, -60%) and rallies (+80%, +150%).
 */
export function isPlausibleSplitRatio(ratio: number): boolean {
  // Quick reject: anything between 0.53 and 1.9 can't be a split
  // (smallest split is 2:1 forward or 1:2 reverse, with 5% tolerance)
  if (ratio > 0.5 * (1 + RATIO_TOLERANCE) && ratio < 2 * (1 - RATIO_TOLERANCE)) {
    return false;
  }
  return KNOWN_SPLIT_RATIOS.some((known) => Math.abs(ratio / known - 1) < RATIO_TOLERANCE);
}

/**
 * Snap a raw ratio to the nearest known split ratio.
 * E.g. 9.85 → 10, 0.198 → 0.2 (1/5)
 */
export function snapToKnownRatio(ratio: number): number {
  let best = ratio;
  let bestDist = Infinity;
  for (const known of KNOWN_SPLIT_RATIOS) {
    const dist = Math.abs(ratio / known - 1);
    if (dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }
  return best;
}

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
    // Normalize: GBX/GBp/GBP are all equivalent for comparison
    const txCurNorm = tx.currency.toUpperCase() === 'GBX' ? 'GBP' : tx.currency.toUpperCase();
    const entryCurNorm =
      entry.currency.toUpperCase() === 'GBX' ? 'GBP' : entry.currency.toUpperCase();
    if (txCurNorm !== entryCurNorm) continue;

    const dateKey = tx.date.split('T')[0];
    const priceMap = historicalPrices.get(entry.ticker);
    if (!priceMap) continue;

    let providerPrice = priceMap.get(dateKey);
    if (!providerPrice || providerPrice <= 0) continue;

    // Yahoo returns London-listed prices in GBX (pence) — convert to GBP for comparison
    if (txCurNorm === 'GBP' && entry.ticker.endsWith('.L')) {
      providerPrice = providerPrice / 100;
    }

    // Apply any already-detected scaling for this ticker to compare fairly
    const currentRatio = cumulativeRatio.get(entry.ticker) ?? 1;
    const scaledProviderPrice = providerPrice * currentRatio;

    const rawRatio = tx.price / scaledProviderPrice;

    // Only accept ratios matching known splits (>=2x or <=0.5x).
    // Any discrepancy under 2x is a normal price movement, not a split.
    if (isPlausibleSplitRatio(rawRatio)) {
      const snappedRatio = snapToKnownRatio(rawRatio);
      splits.push({
        ticker: entry.ticker,
        isin: tx.isin,
        date: new Date().toISOString().split('T')[0], // Use today — the actual split date
        ratio: snappedRatio,
        txPrice: tx.price,
        providerPrice: scaledProviderPrice,
        source: 'auto',
      });
      cumulativeRatio.set(entry.ticker, currentRatio * snappedRatio);
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

  return transactions.map((tx) => {
    const isinSplits = splitsByIsin.get(tx.isin);
    if (!isinSplits) return tx;

    const txDate = tx.date.split('T')[0];

    // Compute cumulative ratio from splits that happened ON or AFTER this transaction.
    // FIX: use >= instead of > — the split date from detection is today (or the actual
    // split date), and ALL pre-existing transactions need adjustment.
    let ratio = 1;
    for (const split of isinSplits) {
      if (split.date >= txDate) {
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

/**
 * Detect a split by noticing that a sell quantity exceeds accumulated buy quantity.
 * This is a strong signal — if you bought 10 shares and try to sell 50, a split
 * must have happened in between.
 *
 * Only works when there's been a sell after the split.
 */
export function detectSplitFromQuantityMismatch(
  transactions: Transaction[],
): Array<{ isin: string; date: string; ratio: number }> {
  // Group by ISIN
  const byIsin = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const arr = byIsin.get(tx.isin) || [];
    arr.push(tx);
    byIsin.set(tx.isin, arr);
  }

  const results: Array<{ isin: string; date: string; ratio: number }> = [];

  for (const [isin, txs] of byIsin) {
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    let accumulated = 0;

    for (const tx of sorted) {
      if (tx.side === 'K') {
        accumulated += tx.quantity;
      } else {
        if (accumulated > 0 && tx.quantity > accumulated * 1.5) {
          const rawRatio = tx.quantity / accumulated;
          if (isPlausibleSplitRatio(rawRatio)) {
            results.push({
              isin,
              date: tx.date.split('T')[0],
              ratio: snapToKnownRatio(rawRatio),
            });
            // Adjust accumulated as if split happened
            accumulated = accumulated * snapToKnownRatio(rawRatio);
          }
        }
        accumulated = Math.max(0, accumulated - tx.quantity);
      }
    }
  }

  return results;
}
