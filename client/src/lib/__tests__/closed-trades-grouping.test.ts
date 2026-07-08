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
    tradeGroupId: 'PLTEST0000017#1',
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

  it('scala partial fille jednego round-tripu (ten sam tradeGroupId, różne sprzedaże)', () => {
    // Kupno 100, sprzedaż z limitem wypełniona w 2 transzach po lekko różnej cenie —
    // ten sam round-trip → jedna grupa, jedna pozycja w win rate.
    const trades = [
      makeTrade({ tradeGroupId: 'X#1', sellTransactionId: 1, quantity: 20, sellPrice: 120 }),
      makeTrade({ tradeGroupId: 'X#1', sellTransactionId: 2, quantity: 20, sellPrice: 119 }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups).toHaveLength(1);
    expect(groups[0].totalQuantity).toBe(40);
    expect(groups[0].sellTransactionIds.sort()).toEqual([1, 2]);
    // Średnia cena sprzedaży ważona ilością: (20×120 + 20×119) / 40 = 119.5
    expect(groups[0].sellPrice).toBeCloseTo(119.5, 6);
    expect(groups[0].minSellPrice).toBe(119);
    expect(groups[0].maxSellPrice).toBe(120);
  });

  it('NIE scala dwóch odrębnych round-tripów (pozycja zamknięta i otwarta ponownie)', () => {
    const trades = [
      makeTrade({ tradeGroupId: 'X#1', sellTransactionId: 1, quantity: 10 }),
      makeTrade({ tradeGroupId: 'X#2', sellTransactionId: 2, quantity: 20 }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key).sort()).toEqual(['X#1', 'X#2']);
  });

  it('scala loty FIFO zamknięte tym samym round-tripem (różne daty/ceny kupna)', () => {
    const trades = [
      makeTrade({ tradeGroupId: 'X#1', quantity: 10, buyDate: '2024-01-10' }),
      makeTrade({ tradeGroupId: 'X#1', quantity: 5, buyDate: '2024-02-15', buyPrice: 110 }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups).toHaveLength(1);
    expect(groups[0].totalQuantity).toBe(15);
    expect(groups[0].trades).toHaveLength(2);
    expect(groups[0].minBuyDate).toBe('2024-01-10');
    expect(groups[0].maxBuyDate).toBe('2024-02-15');
  });

  it('data domknięcia grupy = najpóźniejsza sprzedaż round-tripu', () => {
    const trades = [
      makeTrade({ tradeGroupId: 'X#1', sellTransactionId: 1, sellDate: '2024-03-01' }),
      makeTrade({ tradeGroupId: 'X#1', sellTransactionId: 2, sellDate: '2024-05-20' }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups[0].sellDate).toBe('2024-05-20');
    expect(groups[0].minSellDate).toBe('2024-03-01');
  });

  it('waży P/L % kosztem nabycia, nie ilością', () => {
    // Lot A: 10 szt @ 10 (koszt 100), P/L +50 → +50%
    // Lot B: 10 szt @ 90 (koszt 900), P/L -90 → -10%
    // Ważone ilością: (50% - 10%) / 2 = +20% (błędnie)
    // Ważone kosztem: (50 - 90) / 1000 = -4% (poprawnie)
    const trades = [
      makeTrade({
        tradeGroupId: 'X#1',
        quantity: 10,
        buyPrice: 10,
        buyCommission: 0,
        profitLoss: 50,
        profitLossPct: 50,
      }),
      makeTrade({
        tradeGroupId: 'X#1',
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
        tradeGroupId: 'X#1',
        quantity: 10,
        buyPrice: 0,
        buyCommission: 0,
        profitLossPct: 20,
      }),
      makeTrade({
        tradeGroupId: 'X#1',
        quantity: 30,
        buyPrice: 0,
        buyCommission: 0,
        profitLossPct: -20,
      }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups[0].weightedProfitLossPct).toBeCloseTo((20 * 10 - 20 * 30) / 40, 6);
  });

  it('sortuje grupy malejąco po dacie domknięcia', () => {
    const trades = [
      makeTrade({ tradeGroupId: 'A#1', sellTransactionId: 1, sellDate: '2024-01-05' }),
      makeTrade({ tradeGroupId: 'B#1', sellTransactionId: 2, sellDate: '2024-12-31' }),
      makeTrade({ tradeGroupId: 'C#1', sellTransactionId: 3, sellDate: '2024-06-15' }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups.map((g) => g.sellDate)).toEqual(['2024-12-31', '2024-06-15', '2024-01-05']);
  });

  it('liczy avgHoldingDays ważone ilością', () => {
    const trades = [
      makeTrade({ tradeGroupId: 'X#1', quantity: 1, holdingDays: 100 }),
      makeTrade({ tradeGroupId: 'X#1', quantity: 3, holdingDays: 20 }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups[0].avgHoldingDays).toBe(Math.round((100 * 1 + 20 * 3) / 4));
  });

  it('everyManual=false i isOpen=true gdy round-trip ma nogę importowaną / otwartą', () => {
    const trades = [
      makeTrade({ tradeGroupId: 'X#1', sellSource: 'manual', tradeGroupOpen: true }),
      makeTrade({ tradeGroupId: 'X#1', sellSource: 'bossa' }),
    ];
    const groups = groupClosedTrades(trades);
    expect(groups[0].everyManual).toBe(false);
    expect(groups[0].isOpen).toBe(true);
  });
});

describe('groupClosedTrades — scalanie spreadów opcyjnych', () => {
  const long = (o: Partial<ClosedTrade> = {}): ClosedTrade =>
    makeTrade({
      category: 'option',
      currency: 'USD',
      ticker: 'DECK220620P00090000',
      isin: 'OPT:DECK220620P00090000',
      tradeGroupId: 'OPT:DECK220620P00090000#1',
      isShort: false,
      profitLoss: 120,
      ...o,
    });
  const short = (o: Partial<ClosedTrade> = {}): ClosedTrade =>
    makeTrade({
      category: 'option',
      currency: 'USD',
      ticker: 'DECK220620P00100000',
      isin: 'OPT:DECK220620P00100000',
      tradeGroupId: 'OPT:DECK220620P00100000#1',
      isShort: true,
      profitLoss: -40,
      ...o,
    });

  it('long + short na tym samym underlying/expiry → jeden spread (P/L netto)', () => {
    const groups = groupClosedTrades([long(), short()]);
    expect(groups).toHaveLength(1);
    expect(groups[0].isSpread).toBe(true);
    expect(groups[0].spreadLabel).toBe('DECK 90/100 PUT');
    expect(groups[0].totalProfitLoss).toBe(80); // 120 + (−40)
    expect(groups[0].trades).toHaveLength(2);
  });

  it('same długie nogi (brak short) NIE są scalane', () => {
    const groups = groupClosedTrades([
      long(),
      long({ ticker: 'DECK220620P00095000', tradeGroupId: 'OPT:DECK220620P00095000#1' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.isSpread)).toBe(true);
  });

  it('różne daty wygaśnięcia nie łączą się w spread', () => {
    const groups = groupClosedTrades([
      long(),
      short({ ticker: 'DECK250117P00100000', tradeGroupId: 'OPT:DECK250117P00100000#1' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('akcje (nie-opcje) nietknięte przez scalanie', () => {
    const groups = groupClosedTrades([
      makeTrade({ tradeGroupId: 'A#1' }),
      makeTrade({ ticker: 'FOO.WA', tradeGroupId: 'B#1', sellTransactionId: 2 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.isSpread)).toBe(true);
  });
});
