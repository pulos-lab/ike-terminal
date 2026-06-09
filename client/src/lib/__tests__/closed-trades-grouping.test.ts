import { describe, it, expect } from 'vitest';
import { groupClosedTrades, lotCostBasis } from '../closed-trades-grouping';
import type { ClosedTrade } from 'shared';

function makeTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    paperName: 'Test SA',
    isin: 'PLTEST0000017',
    ticker: 'TST.WA',
    quantity: 10,
    buyDate: '2024-01-10',
    buyPrice: 100,
    buyCommission: 5,
    sellDate: '2024-06-01',
    sellPrice: 120,
    sellCommission: 5,
    profitLoss: 190,
    profitLossPct: 19,
    holdingDays: 143,
    currency: 'PLN',
    sellTransactionId: 1,
    sellSource: 'manual',
    ...overrides,
  };
}

describe('lotCostBasis', () => {
  it('liczy koszt nabycia: cena kupna × ilość + prowizja kupna', () => {
    expect(lotCostBasis(makeTrade({ buyPrice: 100, quantity: 10, buyCommission: 5 }))).toBe(1005);
  });

  it('toleruje brakujące pola (0 zamiast NaN)', () => {
    const t = makeTrade();
    (t as any).buyPrice = undefined;
    (t as any).buyCommission = undefined;
    expect(lotCostBasis(t)).toBe(0);
  });
});

describe('groupClosedTrades', () => {
  it('zwraca pustą tablicę dla braku danych', () => {
    expect(groupClosedTrades([])).toEqual([]);
  });

  it('NIE scala dwóch odrębnych sprzedaży tego samego tickera tego samego dnia', () => {
    const trades = [
      makeTrade({ sellTransactionId: 1, quantity: 10 }),
      makeTrade({ sellTransactionId: 2, quantity: 20 }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.sellTransactionId).sort();
    expect(ids).toEqual([1, 2]);
    // klucze różne — trash button trafia we właściwą sprzedaż
    expect(groups[0].key).not.toBe(groups[1].key);
  });

  it('scala loty FIFO zamknięte tą samą sprzedażą (ten sam sellTransactionId)', () => {
    const trades = [
      makeTrade({ sellTransactionId: 7, quantity: 10, buyDate: '2024-01-10' }),
      makeTrade({ sellTransactionId: 7, quantity: 5, buyDate: '2024-02-15', buyPrice: 110 }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups).toHaveLength(1);
    expect(groups[0].totalQuantity).toBe(15);
    expect(groups[0].trades).toHaveLength(2);
    expect(groups[0].minBuyDate).toBe('2024-01-10');
    expect(groups[0].maxBuyDate).toBe('2024-02-15');
  });

  it('waży P/L % kosztem nabycia, nie ilością', () => {
    // Lot A: 10 szt @ 10 (koszt 100), P/L +50 → +50%
    // Lot B: 10 szt @ 90 (koszt 900), P/L -90 → -10%
    // Ważone ilością: (50% - 10%) / 2 = +20% (błędnie)
    // Ważone kosztem: (50 - 90) / 1000 = -4% (poprawnie)
    const trades = [
      makeTrade({
        sellTransactionId: 3,
        quantity: 10,
        buyPrice: 10,
        buyCommission: 0,
        profitLoss: 50,
        profitLossPct: 50,
      }),
      makeTrade({
        sellTransactionId: 3,
        quantity: 10,
        buyPrice: 90,
        buyCommission: 0,
        profitLoss: -90,
        profitLossPct: -10,
      }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups).toHaveLength(1);
    expect(groups[0].totalProfitLoss).toBe(-40);
    expect(groups[0].weightedProfitLossPct).toBeCloseTo(-4, 6);
  });

  it('fallback do średniej ważonej ilością gdy koszt nabycia = 0', () => {
    const trades = [
      makeTrade({
        sellTransactionId: 4,
        quantity: 10,
        buyPrice: 0,
        buyCommission: 0,
        profitLossPct: 20,
      }),
      makeTrade({
        sellTransactionId: 4,
        quantity: 30,
        buyPrice: 0,
        buyCommission: 0,
        profitLossPct: -20,
      }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups[0].weightedProfitLossPct).toBeCloseTo((20 * 10 - 20 * 30) / 40, 6);
  });

  it('sortuje grupy malejąco po dacie sprzedaży', () => {
    const trades = [
      makeTrade({ sellTransactionId: 1, sellDate: '2024-01-05' }),
      makeTrade({ sellTransactionId: 2, sellDate: '2024-12-31' }),
      makeTrade({ sellTransactionId: 3, sellDate: '2024-06-15' }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups.map((g) => g.sellDate)).toEqual(['2024-12-31', '2024-06-15', '2024-01-05']);
  });

  it('liczy avgHoldingDays ważone ilością', () => {
    const trades = [
      makeTrade({ sellTransactionId: 5, quantity: 1, holdingDays: 100 }),
      makeTrade({ sellTransactionId: 5, quantity: 3, holdingDays: 20 }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups[0].avgHoldingDays).toBe(Math.round((100 * 1 + 20 * 3) / 4));
  });
});
