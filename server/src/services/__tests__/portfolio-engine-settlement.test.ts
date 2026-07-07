import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction, TickerMapEntry, CashOperation } from 'shared';

// Mock zewnętrznych fetcherów PRZED importem silnika
vi.mock('../stooq.js', () => ({
  fetchStooqPrice: vi.fn(),
  fetchStooqPreviousClose: vi.fn().mockResolvedValue(null),
  fetchStooqHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn().mockResolvedValue(null),
  fetchFxRate: vi.fn().mockResolvedValue(null),
  fetchYahooHistory: vi.fn().mockResolvedValue([]),
  fetchYahooHistoryDirect: vi.fn().mockResolvedValue(null),
  fetchYahooSplitEvents: vi.fn().mockResolvedValue([]),
}));

import { computePortfolioHistory, computeCashBalances } from '../portfolio-engine.js';
import * as yahoo from '../yahoo-finance.js';

const AAPL_ENTRY: TickerMapEntry = {
  isin: 'US0378331005',
  ticker: 'AAPL',
  name: 'Apple Inc',
  exchange: 'NASDAQ',
  currency: 'USD',
  priceSource: 'yahoo',
};

function usdBuy(overrides: Partial<Transaction> = {}): Transaction {
  return {
    date: '2024-03-05T10:00:00',
    paperName: 'AAPL',
    isin: 'US0378331005',
    quantity: 10,
    side: 'K',
    price: 10,
    value: 100,
    commission: 0,
    total: 100,
    currency: 'USD',
    paymentCurrency: 'PLN',
    source: 'mbank',
    ...overrides,
  };
}

const plnDeposit: CashOperation = {
  date: '2024-03-04T00:00:00',
  operationType: 'deposit',
  description: 'Zasilenie konta',
  amount: 1000,
  currency: 'PLN',
  source: 'mbank',
};

/** AAPL 10 USD (płasko), USDPLN wg podanych punktów. */
function mockHistory(usdplnPoints: Array<{ date: string; close: number }>) {
  (yahoo.fetchYahooHistory as any).mockImplementation(async (ticker: string) => {
    if (ticker === 'AAPL') {
      return [
        { date: '2024-03-05', close: 10 },
        { date: '2024-03-06', close: 10 },
      ];
    }
    if (ticker === 'USDPLN=X') return usdplnPoints;
    return [];
  });
}

async function lastPortfolioValue(tx: Transaction): Promise<number> {
  const { history } = await computePortfolioHistory(
    [tx],
    [plnDeposit],
    new Map([[AAPL_ENTRY.isin, AAPL_ENTRY]]),
    'WIG',
    'none',
  );
  expect(history.length).toBeGreaterThan(0);
  return history[history.length - 1].portfolioValue;
}

describe('computePortfolioHistory — cash flow transakcji w paymentCurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fxRate brokera: kupno USD z konta PLN debetuje PLN (total×fxRate), bez fantomu USD', async () => {
    mockHistory([
      { date: '2024-03-05', close: 4.0 },
      { date: '2024-03-06', close: 5.0 },
    ]);
    // PLN: 1000 − 100×4.0 = 600; akcje: 10×10 USD × 5.0 = 500.
    // Stary model (fantom −100 USD) dawałby 1000 + (−100+100)×5.0 = 1000.
    const value = await lastPortfolioValue(usdBuy({ fxRate: 4.0 }));
    expect(value).toBeCloseTo(1100, 1);
  });

  it('bez fxRate (mBank): debet PLN po dziennym kursie z historii FX', async () => {
    mockHistory([
      { date: '2024-03-05', close: 4.0 },
      { date: '2024-03-06', close: 5.0 },
    ]);
    const value = await lastPortfolioValue(usdBuy());
    expect(value).toBeCloseTo(1100, 1);
  });

  it('forward-fill kursu: transakcja w weekend bierze ostatni kurs ≤ data', async () => {
    mockHistory([
      { date: '2024-03-01', close: 4.0 }, // ostatni punkt przed datą tx (05)
      { date: '2024-03-06', close: 5.0 },
    ]);
    const value = await lastPortfolioValue(usdBuy());
    expect(value).toBeCloseTo(1100, 1);
  });

  it('brak kursu ≤ data transakcji → fallback do księgowania w walucie notowania', async () => {
    mockHistory([{ date: '2024-03-06', close: 5.0 }]); // kurs dopiero PO dacie tx
    // Fallback: −100 USD (fantom, stare zachowanie) → 1000 PLN + (−100+100)×5.0 = 1000.
    const value = await lastPortfolioValue(usdBuy());
    expect(value).toBeCloseTo(1000, 1);
  });

  it('payment == quote → księgowanie jak dotąd (regresja)', async () => {
    mockHistory([
      { date: '2024-03-05', close: 4.0 },
      { date: '2024-03-06', close: 5.0 },
    ]);
    // Kupno rozliczone w USD (sub-konto USD): saldo USD −100, akcje +100 USD →
    // 1000 PLN + (−100+100)×5.0 = 1000.
    const value = await lastPortfolioValue(usdBuy({ paymentCurrency: 'USD' }));
    expect(value).toBeCloseTo(1000, 1);
  });
});

describe('computeCashBalances — rozliczenie w paymentCurrency', () => {
  it('fxRate: debet w paymentCurrency, bez wpisu w walucie notowania', () => {
    const balances = computeCashBalances([usdBuy({ fxRate: 4.0 })], [plnDeposit]);
    expect(balances['PLN']).toBeCloseTo(600);
    expect(balances['USD']).toBeUndefined();
  });

  it('bez fxRate: status quo — debet w walucie notowania (funkcja sync, bez kursów)', () => {
    const balances = computeCashBalances([usdBuy()], [plnDeposit]);
    expect(balances['PLN']).toBeCloseTo(1000);
    expect(balances['USD']).toBeCloseTo(-100);
  });

  it('sprzedaż z fxRate: uznanie w paymentCurrency', () => {
    const balances = computeCashBalances(
      [usdBuy({ side: 'S', fxRate: 4.0, date: '2024-03-07T10:00:00' })],
      [],
    );
    expect(balances['PLN']).toBeCloseTo(400);
    expect(balances['USD']).toBeUndefined();
  });
});
