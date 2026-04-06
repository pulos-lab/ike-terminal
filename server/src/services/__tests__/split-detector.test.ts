import { describe, it, expect } from 'vitest';
import { detectSplits, rescaleHistoricalPrices, adjustTransactionsForSplits } from '../split-detector.js';
import type { Transaction, TickerMapEntry } from 'shared';

// ─── Helpers ───

function makeTx(overrides: Partial<Transaction> & { side: 'K' | 'S'; quantity: number; price: number }): Transaction {
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

function makeTickerMap(entries: Array<{ isin: string; ticker: string; currency?: string }>): Map<string, TickerMapEntry> {
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

function makePriceMap(ticker: string, prices: Record<string, number>): Map<string, Map<string, number>> {
  const inner = new Map<string, number>(Object.entries(prices));
  return new Map([[ticker, inner]]);
}

// ─── detectSplits ───

describe('detectSplits', () => {
  it('detects a 10:1 split (AVGO case)', () => {
    // User bought at 1070, but Yahoo shows 107 after 10:1 split
    const txs = [makeTx({ side: 'K', quantity: 10, price: 1070, date: '2023-06-15', isin: 'US11135F1012' })];
    const tickerMap = makeTickerMap([{ isin: 'US11135F1012', ticker: 'AVGO', currency: 'PLN' }]);
    const prices = makePriceMap('AVGO', { '2023-06-15': 107 });

    const splits = detectSplits(txs, prices, tickerMap);
    expect(splits).toHaveLength(1);
    expect(splits[0].ratio).toBeCloseTo(10);
    expect(splits[0].ticker).toBe('AVGO');
    expect(splits[0].date).toBe('2023-06-15');
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
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500, date: '2024-01-10', currency: 'PLN' })];
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
      '2022-01-10': 100,  // provider shows fully adjusted (4*2=8x)... no,
      '2023-06-15': 25,   // provider shows fully adjusted
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

    rescaleHistoricalPrices(prices, [{
      ticker: 'TEST', isin: 'TEST0001', date: '2024-01-02',
      ratio: 2, txPrice: 104, providerPrice: 52, source: 'auto',
    }]);

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
      { ticker: 'TEST', isin: 'TEST0001', date: '2024-02-01', ratio: 4, txPrice: 0, providerPrice: 0, source: 'auto' },
      { ticker: 'TEST', isin: 'TEST0001', date: '2024-06-01', ratio: 2, txPrice: 0, providerPrice: 0, source: 'auto' },
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
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 1000, date: '2023-01-15' }),
    ];
    const splits = [{
      ticker: 'TEST', isin: 'TEST0001', date: '2024-07-15',
      ratio: 10, txPrice: 100, providerPrice: 10, source: 'auto' as const,
    }];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0].quantity).toBe(100);   // 10 * 10
    expect(adjusted[0].price).toBe(100);      // 1000 / 10
    // value should be unchanged
    expect(adjusted[0].quantity * adjusted[0].price).toBeCloseTo(10 * 1000);
  });

  it('does NOT adjust post-split transactions', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 100, price: 100, date: '2024-08-01' }),
    ];
    const splits = [{
      ticker: 'TEST', isin: 'TEST0001', date: '2024-07-15',
      ratio: 10, txPrice: 100, providerPrice: 10, source: 'auto' as const,
    }];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    expect(adjusted[0].quantity).toBe(100);
    expect(adjusted[0].price).toBe(100);
  });

  it('does NOT adjust transaction on the split date itself', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 100, price: 100, date: '2024-07-15' }),
    ];
    const splits = [{
      ticker: 'TEST', isin: 'TEST0001', date: '2024-07-15',
      ratio: 10, txPrice: 100, providerPrice: 10, source: 'auto' as const,
    }];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    expect(adjusted[0].quantity).toBe(100);
    expect(adjusted[0].price).toBe(100);
  });

  it('applies cumulative ratio for multiple splits', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 800, date: '2022-01-01' }),
    ];
    const splits = [
      { ticker: 'TEST', isin: 'TEST0001', date: '2023-01-01', ratio: 4, txPrice: 0, providerPrice: 0, source: 'auto' as const },
      { ticker: 'TEST', isin: 'TEST0001', date: '2024-01-01', ratio: 2, txPrice: 0, providerPrice: 0, source: 'auto' as const },
    ];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    // Both splits happened after 2022-01-01, so cumulative ratio = 4 * 2 = 8
    expect(adjusted[0].quantity).toBe(80);
    expect(adjusted[0].price).toBe(100);
  });

  it('only applies splits that happened after the transaction', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 40, price: 200, date: '2023-06-01' }),
    ];
    const splits = [
      { ticker: 'TEST', isin: 'TEST0001', date: '2023-01-01', ratio: 4, txPrice: 0, providerPrice: 0, source: 'auto' as const },
      { ticker: 'TEST', isin: 'TEST0001', date: '2024-01-01', ratio: 2, txPrice: 0, providerPrice: 0, source: 'auto' as const },
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
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 100, date: '2024-01-01', isin: 'AAAA' }),
    ];
    const splits = [{
      ticker: 'TEST', isin: 'BBBB', date: '2024-06-01',
      ratio: 10, txPrice: 0, providerPrice: 0, source: 'auto' as const,
    }];

    const adjusted = adjustTransactionsForSplits(txs, splits);
    expect(adjusted[0].quantity).toBe(10);
    expect(adjusted[0].price).toBe(100);
  });
});
