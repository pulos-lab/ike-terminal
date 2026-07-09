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

import {
  computePortfolioHistory,
  computeCashBalances,
  resolveSplitEventDates,
} from '../portfolio-engine.js';
import type { DetectedSplit } from 'shared';
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

describe('computePortfolioHistory — wycena pozycji krótkiej (PLN, bez FX)', () => {
  const PLN_ENTRY: TickerMapEntry = {
    isin: 'PLSHORT00001',
    ticker: 'SHRT.WA',
    name: 'Short SA',
    exchange: 'GPW',
    currency: 'PLN',
    priceSource: 'yahoo',
  };
  beforeEach(() => vi.clearAllMocks());

  it('krótka sprzedaż: zobowiązanie odejmowane, gotówka z proceeds nie zawyża wartości', async () => {
    // Deposit 1000 PLN; short 10 @ 50 (proceeds +500 → gotówka 1500).
    // Zobowiązanie odkupu −10×50 = −500 → wartość 1500 − 500 = 1000.
    // Błędny model (short pominięty w wycenie) zostawiał samą gotówkę 1500.
    const short: Transaction = {
      date: '2024-03-05T10:00:00',
      paperName: 'Short SA',
      isin: 'PLSHORT00001',
      quantity: 10,
      side: 'S',
      price: 50,
      value: 500,
      commission: 0,
      total: 500,
      currency: 'PLN',
      paymentCurrency: 'PLN',
      source: 'mbank',
    };
    const dep: CashOperation = {
      date: '2024-03-04T00:00:00',
      operationType: 'deposit',
      description: 'Zasilenie',
      amount: 1000,
      currency: 'PLN',
      source: 'mbank',
    };
    const { history } = await computePortfolioHistory(
      [short],
      [dep],
      new Map([[PLN_ENTRY.isin, PLN_ENTRY]]),
      'WIG',
      'none',
    );
    expect(history[history.length - 1].portfolioValue).toBeCloseTo(1000, 1);
  });
});

describe('resolveSplitEventDates — potwierdzanie kandydatów nieznanego ratio (Yahoo)', () => {
  const PSFE_ENTRY: TickerMapEntry = {
    isin: 'US70451T1088',
    ticker: 'PSFE',
    name: 'Paysafe',
    exchange: 'NYSE',
    currency: 'USD',
    priceSource: 'yahoo',
  };
  const tickerMap = new Map([[PSFE_ENTRY.isin, PSFE_ENTRY]]);

  // Kandydat 1:12 z detectSplits: rawRatio ≈ 1/12 (cena tx niżej niż skorygowana
  // przez Yahoo cena historyczna ×12), oznaczony needsConfirmation.
  function candidate(): DetectedSplit {
    return {
      ticker: 'PSFE',
      isin: 'US70451T1088',
      date: '2021-08-16',
      ratio: 1 / 12,
      txPrice: 4.2,
      providerPrice: 50.4,
      source: 'auto',
      needsConfirmation: true,
    };
  }

  beforeEach(() => {
    vi.mocked(yahoo.fetchYahooSplitEvents).mockReset();
  });

  it('stosuje realną datę i ratio z Yahoo gdy zdarzenie potwierdza kandydata', async () => {
    vi.mocked(yahoo.fetchYahooSplitEvents).mockResolvedValue([
      { date: '2021-12-13', ratio: 1 / 12 },
    ]);

    const resolved = await resolveSplitEventDates([candidate()], tickerMap);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].date).toBe('2021-12-13');
    expect(resolved[0].ratio).toBeCloseTo(1 / 12, 6);
  });

  it('ODRZUCA kandydata gdy Yahoo nie zna splitu (to był tylko ruch kursu)', async () => {
    vi.mocked(yahoo.fetchYahooSplitEvents).mockResolvedValue([]);

    const resolved = await resolveSplitEventDates([candidate()], tickerMap);

    expect(resolved).toHaveLength(0);
  });

  it('split o znanym ratio (bez needsConfirmation) przechodzi fallbackiem bez Yahoo', async () => {
    vi.mocked(yahoo.fetchYahooSplitEvents).mockResolvedValue([]);
    const known: DetectedSplit = { ...candidate(), ratio: 4, needsConfirmation: undefined };

    const resolved = await resolveSplitEventDates([known], tickerMap);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].date).toBe('2021-08-17'); // date + 1
    expect(resolved[0].ratio).toBe(4);
  });

  it('kolapsuje NADMIAROWE detekcje jednego splitu do pojedynczego zdarzenia Yahoo (EDU 1:10)', async () => {
    // detectSplits zgłasza po jednej detekcji 1:10 na KAŻDĄ transakcję sprzed splitu
    // (ceny historyczne Yahoo są już skorygowane ×10). Iloczyn heurystyk = 0.01, ale
    // realny split to jedno 1:10 — Yahoo jest autorytatywne i kolapsuje to do jednego.
    vi.mocked(yahoo.fetchYahooSplitEvents).mockResolvedValue([{ date: '2022-04-07', ratio: 0.1 }]);
    const dup: DetectedSplit[] = [
      { ...candidate(), date: '2021-08-12', ratio: 0.1, needsConfirmation: undefined },
      { ...candidate(), date: '2021-12-28', ratio: 0.1, needsConfirmation: undefined },
    ];

    const resolved = await resolveSplitEventDates(dup, tickerMap);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].date).toBe('2022-04-07');
    expect(resolved[0].ratio).toBeCloseTo(0.1, 6);
  });

  it('zaszumione ratio kandydata (LCID 0.105) potwierdza czyste 1:10 z Yahoo', async () => {
    vi.mocked(yahoo.fetchYahooSplitEvents).mockResolvedValue([{ date: '2025-09-02', ratio: 0.1 }]);
    const noisy: DetectedSplit[] = [
      { ...candidate(), date: '2021-07-21', ratio: 0.1054 },
      { ...candidate(), date: '2021-12-09', ratio: 0.113 },
    ];

    const resolved = await resolveSplitEventDates(noisy, tickerMap);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].date).toBe('2025-09-02');
    expect(resolved[0].ratio).toBeCloseTo(0.1, 6);
  });

  it('NIE stosuje niepowiązanego splitu Yahoo o innej skali/kierunku', async () => {
    // Kandydat sugeruje reverse ~1:12, a Yahoo ma tylko forward 2:1 — rozjazd
    // kierunku/skali → nie stosujemy (kandydat needsConfirmation zostaje odrzucony).
    vi.mocked(yahoo.fetchYahooSplitEvents).mockResolvedValue([{ date: '2023-01-01', ratio: 2 }]);

    const resolved = await resolveSplitEventDates([candidate()], tickerMap);

    expect(resolved).toHaveLength(0);
  });
});
