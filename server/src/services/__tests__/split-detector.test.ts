import { describe, it, expect } from 'vitest';
import {
  detectSplits,
  rescaleHistoricalPrices,
  adjustTransactionsForSplits,
  isPlausibleSplitRatio,
  snapToKnownRatio,
  detectSplitFromQuantityMismatch,
} from '../split-detector.js';
import type { Transaction, TickerMapEntry } from 'shared';

// ─── Helpers ───

function makeTx(
  overrides: Partial<Transaction> & { side: 'K' | 'S'; quantity: number; price: number },
): Transaction {
  const value = overrides.quantity * overrides.price;
  return {
    date: '2024-01-15',
    paperName: 'TEST',
    isin: 'TEST0001',
    currency: 'PLN',
    value,
    commission: 0,
    total: value,
    source: 'manual',
    ...overrides,
  };
}

function makeTickerMap(
  entries: Array<{ isin: string; ticker: string; currency?: string }>,
): Map<string, TickerMapEntry> {
  const map = new Map<string, TickerMapEntry>();
  for (const e of entries) {
    map.set(e.isin, {
      isin: e.isin,
      ticker: e.ticker,
      name: e.ticker,
      exchange: 'GPW',
      currency: e.currency ?? 'PLN',
      priceSource: 'yahoo',
    });
  }
  return map;
}

function makePriceMap(
  ticker: string,
  prices: Record<string, number>,
): Map<string, Map<string, number>> {
  const inner = new Map<string, number>(Object.entries(prices));
  return new Map([[ticker, inner]]);
}

// ─── detectSplits ───

describe('detectSplits', () => {
  it('detects a 10:1 split (AVGO case)', () => {
    // User bought at 1070, but Yahoo shows 107 after 10:1 split
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 1070, date: '2023-06-15', isin: 'US11135F1012' }),
    ];
    const tickerMap = makeTickerMap([{ isin: 'US11135F1012', ticker: 'AVGO', currency: 'PLN' }]);
    const prices = makePriceMap('AVGO', { '2023-06-15': 107 });

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(1);
    expect(splits[0].ratio).toBeCloseTo(10);
    expect(splits[0].ticker).toBe('AVGO');
    expect(splits[0].date).toBe('2023-06-15');
  });

  it('pomija instrument tradowany wyłącznie krótko (regresja SMCI −300k)', () => {
    // SMCI: realny split 10:1, ale user tylko shortował (sprzedaż @ 840, odkup @ 875).
    // Cena providera skorygowana (~84) vs tx 840 daje ratio 10, ale bez pozycji długiej
    // split go nie dotyczy — nie może stworzyć widmowej pozycji.
    const txs = [
      makeTx({ side: 'S', quantity: 1, price: 840, date: '2024-02-14', isin: 'SMCI0001' }),
      makeTx({ side: 'K', quantity: 1, price: 875, date: '2024-03-20', isin: 'SMCI0001' }),
    ];
    const tickerMap = makeTickerMap([{ isin: 'SMCI0001', ticker: 'SMCI' }]);
    const prices = makePriceMap('SMCI', { '2024-02-14': 84, '2024-03-20': 87.5 });
    expect(detectSplits(txs, prices, tickerMap)).toHaveLength(0);
  });

  it('detects a 2:1 split', () => {
    const txs = [makeTx({ side: 'K', quantity: 100, price: 200, date: '2024-01-10' })];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST' }]);
    const prices = makePriceMap('TEST', { '2024-01-10': 100 });

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(1);
    expect(splits[0].ratio).toBeCloseTo(2);
  });

  it('detects reverse split 1:5 (ratio = 0.2)', () => {
    // Stock did 1:5 reverse split: price went from 2 to 10
    // User bought at 2, provider shows 10 (adjusted)
    const txs = [makeTx({ side: 'K', quantity: 500, price: 2, date: '2024-01-10' })];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST' }]);
    const prices = makePriceMap('TEST', { '2024-01-10': 10 });

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(1);
    expect(splits[0].ratio).toBeCloseTo(0.2);
  });

  it('no split when prices are consistent', () => {
    const txs = [makeTx({ side: 'K', quantity: 100, price: 100, date: '2024-01-10' })];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST' }]);
    const prices = makePriceMap('TEST', { '2024-01-10': 98 }); // within 15%

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(0);
  });

  it('ignores currency mismatch (FX is not a split)', () => {
    // Bossa records PLN price for USD stock — should NOT detect a split
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 500, date: '2024-01-10', currency: 'PLN' }),
    ];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST', currency: 'USD' }]);
    const prices = makePriceMap('TEST', { '2024-01-10': 120 });

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(0);
  });

  it('detects two splits on the same ticker over time', () => {
    // First buy at 1000, provider shows 125 (adjusted for cumulative 4:1 * 2:1 = 8:1)
    // → first detection: ratio = 1000/125 = 8... but we want two separate splits.
    //
    // Better scenario: Two transactions, each revealing a new split:
    // - 2022: bought at 400, provider (fully adjusted) shows 50 → ratio 8 detected as first.
    //   But let's do it as: tx1 bought at 400 when provider shows 100 → 4:1 split
    //   Then tx2 bought at 200 (post-first-split price) and provider shows 25 → after
    //   applying cumulative 4x: scaledPrice = 25*4=100, tx price=200, ratio = 2
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 400, date: '2022-01-10' }),
      makeTx({ side: 'K', quantity: 40, price: 200, date: '2023-06-15' }),
    ];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST' }]);
    const prices = makePriceMap('TEST', {
      '2022-01-10': 100, // provider shows fully adjusted (4*2=8x)... no,
      '2023-06-15': 25, // provider shows fully adjusted
    });
    // tx1: price=400, providerPrice=100, cumulativeRatio=1 → scaledProvider=100
    //   discrepancy=|400/100-1|=3 > 0.15 → ratio=4, cumulativeRatio→4
    // tx2: price=200, providerPrice=25, cumulativeRatio=4 → scaledProvider=25*4=100
    //   discrepancy=|200/100-1|=1 > 0.15 → ratio=2, cumulativeRatio→8

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(2);
    expect(splits[0].ratio).toBeCloseTo(4);
    expect(splits[1].ratio).toBeCloseTo(2);
  });

  it('does NOT report a false reverse split for a post-split buy', () => {
    // tx1 pre-split: 1070 vs provider 107 → split 10:1.
    // tx2 post-split: 107 vs provider 107 — porównanie ze SKALOWANĄ ceną
    // (107×10) dawałoby ratio 0.1 i fałszywy reverse split.
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 1070, date: '2023-06-15' }),
      makeTx({ side: 'K', quantity: 100, price: 107, date: '2024-08-01' }),
    ];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST' }]);
    const prices = makePriceMap('TEST', { '2023-06-15': 107, '2024-08-01': 107 });

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(1);
    expect(splits[0].ratio).toBeCloseTo(10);
    expect(splits[0].date).toBe('2023-06-15');
  });

  it('skips if no provider price on transaction date', () => {
    const txs = [makeTx({ side: 'K', quantity: 100, price: 1000, date: '2024-01-10' })];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST' }]);
    const prices = makePriceMap('TEST', { '2024-01-11': 100 }); // different date

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(0);
  });
});

// ─── rescaleHistoricalPrices ───

describe('rescaleHistoricalPrices', () => {
  it('rescales all prices by split ratio', () => {
    const prices = makePriceMap('TEST', {
      '2024-01-01': 50,
      '2024-01-02': 52,
      '2024-01-03': 48,
    });

    rescaleHistoricalPrices(prices, [
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2024-01-02',
        ratio: 2,
        txPrice: 104,
        providerPrice: 52,
        source: 'auto',
      },
    ]);

    const priceMap = prices.get('TEST')!;
    expect(priceMap.get('2024-01-01')).toBe(100);
    expect(priceMap.get('2024-01-02')).toBe(104);
    expect(priceMap.get('2024-01-03')).toBe(96);
  });

  it('applies cumulative ratio for multiple splits', () => {
    const prices = makePriceMap('TEST', {
      '2024-01-01': 10,
    });

    rescaleHistoricalPrices(prices, [
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2024-02-01',
        ratio: 4,
        txPrice: 0,
        providerPrice: 0,
        source: 'auto',
      },
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2024-06-01',
        ratio: 2,
        txPrice: 0,
        providerPrice: 0,
        source: 'auto',
      },
    ]);

    // Total ratio: 4 * 2 = 8
    expect(prices.get('TEST')!.get('2024-01-01')).toBe(80);
  });

  it('does nothing when no splits', () => {
    const prices = makePriceMap('TEST', { '2024-01-01': 100 });
    rescaleHistoricalPrices(prices, []);
    expect(prices.get('TEST')!.get('2024-01-01')).toBe(100);
  });
});

// ─── adjustTransactionsForSplits ───

describe('adjustTransactionsForSplits', () => {
  it('adjusts pre-split transaction quantities and prices', () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 1000, date: '2023-01-15' })];
    const splits = [
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2024-07-15',
        ratio: 10,
        txPrice: 100,
        providerPrice: 10,
        source: 'auto' as const,
      },
    ];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0].quantity).toBe(100); // 10 * 10
    expect(adjusted[0].price).toBe(100); // 1000 / 10
    // value should be unchanged
    expect(adjusted[0].quantity * adjusted[0].price).toBeCloseTo(10 * 1000);
  });

  it('does NOT adjust post-split transactions', () => {
    const txs = [makeTx({ side: 'K', quantity: 100, price: 100, date: '2024-08-01' })];
    const splits = [
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2024-07-15',
        ratio: 10,
        txPrice: 100,
        providerPrice: 10,
        source: 'auto' as const,
      },
    ];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    expect(adjusted[0].quantity).toBe(100);
    expect(adjusted[0].price).toBe(100);
  });

  it('does NOT adjust transaction on the split date itself', () => {
    const txs = [makeTx({ side: 'K', quantity: 100, price: 100, date: '2024-07-15' })];
    const splits = [
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2024-07-15',
        ratio: 10,
        txPrice: 100,
        providerPrice: 10,
        source: 'auto' as const,
      },
    ];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    expect(adjusted[0].quantity).toBe(100);
    expect(adjusted[0].price).toBe(100);
  });

  it('applies cumulative ratio for multiple splits', () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 800, date: '2022-01-01' })];
    const splits = [
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2023-01-01',
        ratio: 4,
        txPrice: 0,
        providerPrice: 0,
        source: 'auto' as const,
      },
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2024-01-01',
        ratio: 2,
        txPrice: 0,
        providerPrice: 0,
        source: 'auto' as const,
      },
    ];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    // Both splits happened after 2022-01-01, so cumulative ratio = 4 * 2 = 8
    expect(adjusted[0].quantity).toBe(80);
    expect(adjusted[0].price).toBe(100);
  });

  it('only applies splits that happened after the transaction', () => {
    const txs = [makeTx({ side: 'K', quantity: 40, price: 200, date: '2023-06-01' })];
    const splits = [
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2023-01-01',
        ratio: 4,
        txPrice: 0,
        providerPrice: 0,
        source: 'auto' as const,
      },
      {
        ticker: 'TEST',
        isin: 'TEST0001',
        date: '2024-01-01',
        ratio: 2,
        txPrice: 0,
        providerPrice: 0,
        source: 'auto' as const,
      },
    ];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    // Only the 2024 split happened after this tx, so ratio = 2
    expect(adjusted[0].quantity).toBe(80);
    expect(adjusted[0].price).toBe(100);
  });

  it('returns original transactions when no splits', () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 100, date: '2024-01-01' })];
    const adjusted = adjustTransactionsForSplits(txs, []);
    expect(adjusted).toBe(txs); // same reference
  });

  it('ignores splits for different ISINs', () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 100, date: '2024-01-01', isin: 'AAAA' })];
    const splits = [
      {
        ticker: 'TEST',
        isin: 'BBBB',
        date: '2024-06-01',
        ratio: 10,
        txPrice: 0,
        providerPrice: 0,
        source: 'auto' as const,
      },
    ];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    expect(adjusted[0].quantity).toBe(10);
    expect(adjusted[0].price).toBe(100);
  });
});

// ─── isPlausibleSplitRatio ───

describe('isPlausibleSplitRatio', () => {
  it('accepts exact known ratios', () => {
    expect(isPlausibleSplitRatio(2)).toBe(true);
    expect(isPlausibleSplitRatio(4)).toBe(true);
    expect(isPlausibleSplitRatio(10)).toBe(true);
    expect(isPlausibleSplitRatio(0.5)).toBe(true); // 1:2 reverse
    expect(isPlausibleSplitRatio(0.2)).toBe(true); // 1:5 reverse
    expect(isPlausibleSplitRatio(0.1)).toBe(true); // 1:10 reverse
  });

  it('accepts ratios within 5% tolerance', () => {
    expect(isPlausibleSplitRatio(9.85)).toBe(true); // close to 10
    expect(isPlausibleSplitRatio(10.3)).toBe(true); // close to 10
    expect(isPlausibleSplitRatio(1.98)).toBe(true); // close to 2
    expect(isPlausibleSplitRatio(0.198)).toBe(true); // close to 0.2
  });

  it('rejects -40% crash (ratio ~1.67)', () => {
    expect(isPlausibleSplitRatio(1.67)).toBe(false);
  });

  it('accepts 1:3 reverse split (ratio ~0.33)', () => {
    expect(isPlausibleSplitRatio(0.33)).toBe(true); // close to 1/3
  });

  it('rejects +130% rally (ratio ~0.43)', () => {
    expect(isPlausibleSplitRatio(0.43)).toBe(false);
  });

  it('rejects -20% drop (ratio ~1.25)', () => {
    expect(isPlausibleSplitRatio(1.25)).toBe(false);
  });

  it('rejects arbitrary ratios', () => {
    expect(isPlausibleSplitRatio(2.31)).toBe(false);
    expect(isPlausibleSplitRatio(0.73)).toBe(false);
    expect(isPlausibleSplitRatio(1.5)).toBe(false);
    expect(isPlausibleSplitRatio(11)).toBe(false);
    expect(isPlausibleSplitRatio(9)).toBe(false);
  });
});

// ─── snapToKnownRatio ───

describe('snapToKnownRatio', () => {
  it('snaps 9.85 to 10', () => {
    expect(snapToKnownRatio(9.85)).toBe(10);
  });

  it('snaps 0.198 to 0.2', () => {
    expect(snapToKnownRatio(0.198)).toBe(0.2);
  });

  it('snaps 2.03 to 2', () => {
    expect(snapToKnownRatio(2.03)).toBe(2);
  });

  it('snaps 4.9 to 5', () => {
    expect(snapToKnownRatio(4.9)).toBe(5);
  });
});

// ─── detectSplits with ratio validation ───

describe('detectSplits — false positive prevention', () => {
  it('does NOT detect a -40% crash as a split', () => {
    // Stock crashed from 100 to 60 — ratio 1.67 is NOT a valid split
    const txs = [makeTx({ side: 'K', quantity: 100, price: 100, date: '2024-01-10' })];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST' }]);
    const prices = makePriceMap('TEST', { '2024-01-10': 60 });

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(0);
  });

  it('does NOT detect a +130% rally as a reverse split', () => {
    // Stock rallied from 100 to 230 — ratio 0.43 is NOT a valid split
    const txs = [makeTx({ side: 'K', quantity: 100, price: 100, date: '2024-01-10' })];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST' }]);
    const prices = makePriceMap('TEST', { '2024-01-10': 230 });

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(0);
  });

  it('snaps detected ratio to nearest known value', () => {
    // Ratio is 9.85 (~10:1 split with slight price variance)
    const txs = [makeTx({ side: 'K', quantity: 10, price: 985, date: '2024-01-10' })];
    const tickerMap = makeTickerMap([{ isin: 'TEST0001', ticker: 'TEST' }]);
    const prices = makePriceMap('TEST', { '2024-01-10': 100 });

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(1);
    expect(splits[0].ratio).toBe(10); // snapped from 9.85
  });
});

// ─── detectSplitFromQuantityMismatch ───

describe('detectSplitFromQuantityMismatch', () => {
  it('detects split when sell quantity exceeds buys', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 1000, date: '2023-01-01' }),
      makeTx({ side: 'S', quantity: 50, price: 100, date: '2024-08-01' }),
    ];
    const results = detectSplitFromQuantityMismatch(txs);
    expect(results).toHaveLength(1);
    expect(results[0].ratio).toBe(5);
  });

  it('does NOT trigger when sell is within buys', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 100, price: 10, date: '2023-01-01' }),
      makeTx({ side: 'S', quantity: 50, price: 15, date: '2024-01-01' }),
    ];
    const results = detectSplitFromQuantityMismatch(txs);
    expect(results).toHaveLength(0);
  });

  it('does NOT trigger for non-split quantity mismatch', () => {
    // Sell 17 shares when only 10 bought — ratio 1.7 is not a valid split
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 100, date: '2023-01-01' }),
      makeTx({ side: 'S', quantity: 17, price: 60, date: '2024-01-01' }),
    ];
    const results = detectSplitFromQuantityMismatch(txs);
    expect(results).toHaveLength(0);
  });

  it('krótka sprzedaż + odkup NIE jest splitem (cena bez zawału — regresja SPOT/NET)', () => {
    // Realny SPOT: 5 posiadanych @ ~166, sprzedaż 100 @ 113.68 (short 95), odkup 95 @ 113.63.
    // rawRatio = 20 (plausible), ale cena NIE spadła 20× → to short, nie split.
    const txs = [
      makeTx({ side: 'K', quantity: 5, price: 166, date: '2022-02-15' }),
      makeTx({ side: 'S', quantity: 100, price: 113.68, date: '2022-07-22T09:35:43' }),
      makeTx({ side: 'K', quantity: 95, price: 113.63, date: '2022-07-22T09:36:05' }),
    ];
    expect(detectSplitFromQuantityMismatch(txs)).toHaveLength(0);
  });

  it('short 10:1 (NET) też odrzucony przez korroborację ceną', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 103.7, date: '2022-02-07' }),
      makeTx({ side: 'S', quantity: 100, price: 54.49, date: '2022-07-22' }),
      makeTx({ side: 'K', quantity: 90, price: 54.95, date: '2022-07-22' }),
    ];
    expect(detectSplitFromQuantityMismatch(txs)).toHaveLength(0);
  });

  it('realny split nadal wykrywany gdy cena spadła ~o ratio (20:1)', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 5, price: 2000, date: '2022-01-01' }),
      makeTx({ side: 'S', quantity: 100, price: 105, date: '2022-06-06' }),
    ];
    const r = detectSplitFromQuantityMismatch(txs);
    expect(r).toHaveLength(1);
    expect(r[0].ratio).toBe(20);
  });

  it('pomija opcje (category=option) — shorty opcyjne to norma', () => {
    const txs = [
      makeTx({ side: 'S', quantity: 100, price: 5, date: '2022-01-01', category: 'option' }),
      makeTx({ side: 'K', quantity: 100, price: 3, date: '2022-02-01', category: 'option' }),
    ];
    expect(detectSplitFromQuantityMismatch(txs)).toHaveLength(0);
  });
});
