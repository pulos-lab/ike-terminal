import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction, TickerMapEntry, CashOperation } from 'shared';

// Mock zewnętrznych fetcherów PRZED importem silnika
vi.mock('../stooq.js', () => ({
  fetchStooqPrice: vi.fn(),
  fetchStooqPreviousClose: vi.fn().mockResolvedValue(null),
  fetchStooqHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../stockwatch-bonds.js', () => ({
  // Domyślnie null → gałąź CATALYST spada na zapas Stooq (istniejące asercje
  // fetchStooqPrice zostają w mocy); kolejność źródeł testuje osobny przypadek.
  fetchStockwatchBondPrice: vi.fn().mockResolvedValue(null),
}));
vi.mock('../biznesradar.js', () => ({
  // Historia domyślnie pusta → gałąź NC/CATALYST spada na zapas fetchStooqHistory
  // (istniejące asercje historii ze Stooqa zostają w mocy).
  fetchBiznesradarPrice: vi.fn().mockResolvedValue(null),
  fetchBiznesradarHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn().mockResolvedValue(null),
  fetchFxRate: vi.fn().mockResolvedValue(null),
  fetchYahooHistory: vi.fn().mockResolvedValue([]),
  fetchYahooHistoryDirect: vi.fn().mockResolvedValue(null),
  fetchYahooSplitEvents: vi.fn().mockResolvedValue([]),
}));

import {
  computeOpenPositions,
  computeClosedTrades,
  computePortfolioHistory,
} from '../portfolio-engine.js';
import * as stooq from '../stooq.js';
import * as stockwatchBonds from '../stockwatch-bonds.js';

function bondTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    date: '2024-03-05T10:00:00',
    paperName: 'DS1030',
    isin: 'PL0000112736',
    quantity: 10,
    side: 'K',
    price: 98.5, // % nominału (1000 zł) → 985 zł/szt
    value: 9850,
    commission: 19.7,
    total: 9869.7,
    currency: 'PLN',
    paymentCurrency: 'PLN',
    category: 'bond',
    source: 'bossa',
    ...overrides,
  };
}

const DS1030_ENTRY: TickerMapEntry = {
  isin: 'PL0000112736',
  ticker: 'DS1030',
  name: 'DS1030 (Skarb Państwa)',
  exchange: 'CATALYST',
  currency: 'PLN',
  priceSource: 'stooq',
};

describe('computeOpenPositions — obligacje', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wycenia pozycję kurs% × nominał (10 szt @ 99,20% × 1000 zł = 9920 zł)', async () => {
    (stooq.fetchStooqPrice as any).mockResolvedValue(99.2);
    const tickerMap = new Map([[DS1030_ENTRY.isin, DS1030_ENTRY]]);

    const { positions, totalValuePln } = await computeOpenPositions(
      [bondTx()],
      tickerMap,
      [],
      undefined,
      { skipSplitDetection: true },
    );

    expect(positions).toHaveLength(1);
    const pos = positions[0];
    // Kursy zostają w % (spójna skala z Catalyst/Stooq)
    expect(pos.currentPrice).toBe(99.2);
    expect(pos.avgBuyPrice).toBeCloseTo(98.5);
    // Wartości w PLN przez mnożnik nominal/100
    expect(pos.currentValuePln).toBeCloseTo(9920);
    expect(pos.profitLossPln).toBeCloseTo(9920 - 9850);
    expect(totalValuePln).toBeCloseTo(9920);
    // Cena pobrana ze Stooq (CATALYST), nie z Yahoo
    expect(stooq.fetchStooqPrice).toHaveBeenCalledWith('DS1030');
  });

  it('fallback bez wpisu ticker_map: wycena po ostatniej cenie tx × nominał', async () => {
    const { positions } = await computeOpenPositions([bondTx()], new Map(), [], undefined, {
      skipSplitDetection: true,
    });

    expect(positions).toHaveLength(1);
    expect(positions[0].currentValuePln).toBeCloseTo(9850);
    expect(positions[0].priceManual).toBe(true);
  });

  it('stockwatch-first: kurs + previousClose z tabeli, Stooq nie jest wołany', async () => {
    // mockResolvedValueOnce — jednorazowo, żeby nie przeciekło do innych testów
    (stockwatchBonds.fetchStockwatchBondPrice as any).mockResolvedValueOnce({
      price: 99.2,
      referencePrice: 98.9,
      lastTradeDate: '2026-07-15',
    });
    const tickerMap = new Map([[DS1030_ENTRY.isin, DS1030_ENTRY]]);

    const { positions } = await computeOpenPositions([bondTx()], tickerMap, [], undefined, {
      skipSplitDetection: true,
    });

    expect(positions[0].currentPrice).toBe(99.2);
    expect(positions[0].priceManual).toBeUndefined();
    expect(positions[0].dailyChangePct).toBeCloseTo(((99.2 - 98.9) / 98.9) * 100, 6);
    expect(stooq.fetchStooqPrice).not.toHaveBeenCalled();
    expect(stooq.fetchStooqPreviousClose).not.toHaveBeenCalled();
  });
});

describe('computeClosedTrades — obligacje', () => {
  it('P/L w PLN przez mnożnik: kupno 98,50% → wykup 100,00% = 150 zł − prowizja', () => {
    const txs: Transaction[] = [
      bondTx({ id: 1 }),
      bondTx({
        id: 2,
        date: '2030-10-25T00:00:00',
        side: 'S',
        price: 100,
        value: 10000,
        commission: 0,
        total: 10000,
      }),
    ];

    const trades = computeClosedTrades(txs, new Map([[DS1030_ENTRY.isin, DS1030_ENTRY]]));

    expect(trades).toHaveLength(1);
    // (10×100% − 10×98,50%) × 1000/100 = 150 zł brutto − 19,70 prowizji kupna
    expect(trades[0].profitLoss).toBeCloseTo(150 - 19.7);
    // % od wartości zakupu w PLN: 130,30 / 9850
    expect(trades[0].profitLossPct).toBeCloseTo(((150 - 19.7) / 9850) * 100);
    // Ceny w trade'zie zostają w % (wyświetlacz)
    expect(trades[0].buyPrice).toBe(98.5);
    expect(trades[0].sellPrice).toBe(100);
    // Zaangażowany kapitał z nominałem (nie surowe buyPrice×qty = 985): 9850 + prowizja
    expect(trades[0].costBasis).toBeCloseTo(9850 + 19.7);
  });
});

describe('computePortfolioHistory — obligacje', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dzienna wycena akcji portfela uwzględnia mnożnik nominału (historia ze Stooq)', async () => {
    (stooq.fetchStooqHistory as any).mockResolvedValue([
      { date: '2024-03-05', close: 98.5 },
      { date: '2024-03-06', close: 99.2 },
    ]);

    const operations: CashOperation[] = [
      {
        date: '2024-03-04T00:00:00',
        operationType: 'deposit',
        description: 'Zasilenie konta',
        amount: 10000,
        currency: 'PLN',
        source: 'bossa',
      },
    ];

    const { history } = await computePortfolioHistory(
      [bondTx()],
      operations,
      new Map([[DS1030_ENTRY.isin, DS1030_ENTRY]]),
      'WIG',
      'none',
    );

    expect(history.length).toBeGreaterThan(0);
    const last = history[history.length - 1];
    // cash 10000 − 9869,70 = 130,30; obligacje 10 × 99,20% × 1000 = 9920 (forward-fill)
    expect(last.portfolioValue).toBeCloseTo(130.3 + 9920, 1);
    // Historia pobrana ze Stooq po tickerze serii
    expect(stooq.fetchStooqHistory).toHaveBeenCalledWith('DS1030', expect.anything());
  });
});
