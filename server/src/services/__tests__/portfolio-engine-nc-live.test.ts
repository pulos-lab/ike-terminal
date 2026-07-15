import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction, TickerMapEntry } from 'shared';

// Mock zewnętrznych fetcherów PRZED importem silnika
vi.mock('../stooq.js', () => ({
  fetchStooqPrice: vi.fn().mockResolvedValue(null),
  fetchStooqPreviousClose: vi.fn().mockResolvedValue(null),
  fetchStooqHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../biznesradar.js', () => ({
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

import { computeOpenPositions } from '../portfolio-engine.js';
import * as stooq from '../stooq.js';
import * as biznesradar from '../biznesradar.js';
import * as yahoo from '../yahoo-finance.js';

/**
 * Wycena live NC: biznesradar główne źródło (Stooq live CSV padł ~03.2026),
 * Stooq zapas, ostatnia cena tx jako fallback ostateczny (priceManual).
 * Ta sama kolejność co /api/prices/live — silnik był pominięty przy rolloutcie
 * biznesradaru i pozycje NC wisiały na cenie transakcyjnej.
 */

const EXC_ENTRY: TickerMapEntry = {
  isin: 'PLEXCLL00021',
  ticker: 'EXC',
  name: 'Excellence',
  exchange: 'NC',
  currency: 'PLN',
  priceSource: 'stooq',
};

function ncTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    date: '2025-11-03T10:00:00',
    paperName: 'EXCELLENCE',
    isin: EXC_ENTRY.isin,
    quantity: 1000,
    side: 'K',
    price: 0.5,
    value: 500,
    commission: 1.9,
    total: 501.9,
    currency: 'PLN',
    paymentCurrency: 'PLN',
    category: 'stock',
    source: 'bossa',
    ...overrides,
  };
}

const tickerMap = new Map([[EXC_ENTRY.isin, EXC_ENTRY]]);

/**
 * resetAllMocks zdejmuje też mockResolvedValue z poprzednich testów
 * (clearAllMocks zostawiał implementacje → przeciek kursu między testami);
 * po resecie przywracamy kontraktowe domyślne (fetchery zwracają null, nie undefined).
 */
function resetFetcherMocks() {
  vi.resetAllMocks();
  (biznesradar.fetchBiznesradarPrice as any).mockResolvedValue(null);
  (stooq.fetchStooqPrice as any).mockResolvedValue(null);
  (stooq.fetchStooqPreviousClose as any).mockResolvedValue(null);
  (stooq.fetchStooqHistory as any).mockResolvedValue([]);
  (yahoo.fetchYahooPrice as any).mockResolvedValue(null);
  (yahoo.fetchFxRate as any).mockResolvedValue(null);
  (yahoo.fetchYahooHistory as any).mockResolvedValue([]);
  (yahoo.fetchYahooHistoryDirect as any).mockResolvedValue(null);
  (yahoo.fetchYahooSplitEvents as any).mockResolvedValue([]);
}

describe('computeOpenPositions — wycena live NC', () => {
  beforeEach(resetFetcherMocks);

  it('biznesradar jest głównym źródłem (Stooq nie jest wołany, gdy BR ma kurs)', async () => {
    (biznesradar.fetchBiznesradarPrice as any).mockResolvedValue(0.595);
    (stooq.fetchStooqPreviousClose as any).mockResolvedValue(0.58);

    const { positions } = await computeOpenPositions([ncTx()], tickerMap, []);

    expect(positions).toHaveLength(1);
    expect(positions[0].currentPrice).toBe(0.595);
    expect(positions[0].priceManual).toBeUndefined();
    expect(positions[0].dailyChangePct).toBeCloseTo(((0.595 - 0.58) / 0.58) * 100, 6);
    expect(stooq.fetchStooqPrice).not.toHaveBeenCalled();
  });

  it('biznesradar null → zapas Stooq', async () => {
    (biznesradar.fetchBiznesradarPrice as any).mockResolvedValue(null);
    (stooq.fetchStooqPrice as any).mockResolvedValue(0.61);

    const { positions } = await computeOpenPositions([ncTx()], tickerMap, []);

    expect(positions[0].currentPrice).toBe(0.61);
    expect(positions[0].priceManual).toBeUndefined();
  });

  it('oba źródła null → ostatnia cena tx (priceManual) i BEZ dailyChangePct', async () => {
    // prevClose ze Stooq history jest dostępny — ale zmiana dzienna liczona
    // z ceny transakcyjnej vs prevClose z innego źródła to nie jest żadna
    // „zmiana dzienna", więc musi zostać null.
    (stooq.fetchStooqPreviousClose as any).mockResolvedValue(0.58);

    const { positions } = await computeOpenPositions([ncTx()], tickerMap, []);

    expect(positions[0].currentPrice).toBe(0.5);
    expect(positions[0].priceManual).toBe(true);
    expect(positions[0].dailyChangePct).toBeNull();
  });
});

// ── GPW: Yahoo główne, biznesradar zapas (tylko .WA) ────────────────────────

const CDR_ENTRY: TickerMapEntry = {
  isin: 'PLOPTTC00011',
  ticker: 'CDR.WA',
  name: 'CD Projekt',
  exchange: 'GPW',
  currency: 'PLN',
  priceSource: 'yahoo',
};

const AAPL_ENTRY: TickerMapEntry = {
  isin: 'US0378331005',
  ticker: 'AAPL',
  name: 'Apple Inc.',
  exchange: 'NASDAQ',
  currency: 'USD',
  priceSource: 'yahoo',
};

function gpwTx(overrides: Partial<Transaction> = {}): Transaction {
  return ncTx({
    paperName: 'CD PROJEKT',
    isin: CDR_ENTRY.isin,
    quantity: 10,
    price: 200,
    value: 2000,
    total: 2001.9,
    ...overrides,
  });
}

describe('computeOpenPositions — wycena live GPW (zapas biznesradar)', () => {
  beforeEach(resetFetcherMocks);

  it('Yahoo ma kurs → biznesradar nie jest wołany', async () => {
    (yahoo.fetchYahooPrice as any).mockResolvedValue({
      price: 231.2,
      currency: 'PLN',
      previousClose: 228.0,
    });

    const { positions } = await computeOpenPositions(
      [gpwTx()],
      new Map([[CDR_ENTRY.isin, CDR_ENTRY]]),
      [],
      undefined,
      { skipSplitDetection: true },
    );

    expect(positions[0].currentPrice).toBe(231.2);
    expect(biznesradar.fetchBiznesradarPrice).not.toHaveBeenCalled();
  });

  it('Yahoo null → zapas biznesradar; dailyChangePct null (brak prevClose)', async () => {
    (biznesradar.fetchBiznesradarPrice as any).mockResolvedValue(231.2);

    const { positions } = await computeOpenPositions(
      [gpwTx()],
      new Map([[CDR_ENTRY.isin, CDR_ENTRY]]),
      [],
      undefined,
      { skipSplitDetection: true },
    );

    expect(positions[0].currentPrice).toBe(231.2);
    expect(positions[0].priceManual).toBeUndefined();
    // biznesradar nie daje poprzedniego zamknięcia — lepszy brak zmiany
    // dziennej niż wartość liczona z mieszanych źródeł
    expect(positions[0].dailyChangePct).toBeNull();
    expect(biznesradar.fetchBiznesradarPrice).toHaveBeenCalledWith('CDR.WA');
  });

  it('Yahoo i biznesradar null → ostatnia cena tx (priceManual)', async () => {
    const { positions } = await computeOpenPositions(
      [gpwTx()],
      new Map([[CDR_ENTRY.isin, CDR_ENTRY]]),
      [],
      undefined,
      { skipSplitDetection: true },
    );

    expect(positions[0].currentPrice).toBe(200);
    expect(positions[0].priceManual).toBe(true);
  });

  it('zagraniczny ticker (nie .WA) z Yahoo null → biznesradar NIE jest wołany', async () => {
    const { positions } = await computeOpenPositions(
      [gpwTx({ isin: AAPL_ENTRY.isin, paperName: 'APPLE', currency: 'USD' })],
      new Map([[AAPL_ENTRY.isin, AAPL_ENTRY]]),
      [],
      undefined,
      { skipSplitDetection: true },
    );

    expect(positions[0].priceManual).toBe(true);
    expect(biznesradar.fetchBiznesradarPrice).not.toHaveBeenCalled();
  });
});
