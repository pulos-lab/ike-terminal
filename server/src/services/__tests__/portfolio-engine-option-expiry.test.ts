import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction, TickerMapEntry, OptionContract } from 'shared';

// Mock zewnętrznych fetcherów PRZED importem silnika
vi.mock('../stooq.js', () => ({
  fetchStooqPrice: vi.fn().mockResolvedValue(null),
  fetchStooqPreviousClose: vi.fn().mockResolvedValue(null),
  fetchStooqHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn().mockResolvedValue(null),
  fetchFxRate: vi.fn().mockResolvedValue(4.0),
  fetchYahooHistory: vi.fn().mockResolvedValue([]),
  fetchYahooHistoryDirect: vi.fn().mockResolvedValue(null),
  fetchYahooSplitEvents: vi.fn().mockResolvedValue([]),
}));

import { computeOpenPositions, computeClosedTrades } from '../portfolio-engine.js';
import { expireOptions, resolveOptionExpirySettlements } from '../option-expiry-transform.js';
import * as yahoo from '../yahoo-finance.js';

/**
 * Auto-domknięcie opcji po terminie wygaśnięcia (bez wiersza Ep/Ex/A z brokera).
 * Kontrakt bazowy: DKNG 20MAY22 60.0 P (expiry 2022-05-20, dawno po terminie względem „dziś").
 */
const ISIN = 'OPT:DKNG220520P00060000';
const CONTRACT: OptionContract = {
  isin: ISIN,
  occTicker: 'DKNG220520P00060000',
  underlying: 'DKNG',
  expiry: '2022-05-20',
  strike: 60,
  optionType: 'P',
  multiplier: 100,
  currency: 'USD',
};
const ENTRY: TickerMapEntry = {
  isin: ISIN,
  ticker: 'DKNG220520P00060000',
  name: 'DKNG 20MAY22 60.0 P',
  exchange: 'OTHER',
  currency: 'USD',
  priceSource: 'yahoo',
};
const contracts = new Map([[ISIN, CONTRACT]]);
const tickerMap = new Map([[ISIN, ENTRY]]);
const TODAY = '2026-07-15';

function tx(o: Partial<Transaction> = {}): Transaction {
  return {
    date: '2021-11-04T10:05:18',
    paperName: 'DKNG 20MAY22 60.0 P',
    isin: ISIN,
    quantity: 1,
    side: 'S',
    price: 16.32,
    value: 1632,
    commission: 0.68,
    total: 1631.32,
    currency: 'USD',
    paymentCurrency: 'USD',
    category: 'option',
    source: 'ibkr',
    ...o,
  };
}
const openOpts = { skipSplitDetection: true, optionContracts: contracts };

beforeEach(() => {
  vi.clearAllMocks();
  (yahoo.fetchFxRate as any).mockResolvedValue(4.0);
  (yahoo.fetchYahooPrice as any).mockResolvedValue(null);
  (yahoo.fetchYahooHistory as any).mockResolvedValue([]);
  (yahoo.fetchYahooSplitEvents as any).mockResolvedValue([]);
});

describe('expireOptions — transform (jednostkowo)', () => {
  it('5) nie wygasło jeszcze (asOf < expiry) → brak syntetyka', () => {
    const out = expireOptions([tx()], contracts, '2022-01-01');
    expect(out).toHaveLength(1);
  });

  it('guard) realny Ep w dniu wygaśnięcia → brak syntetyka (bez podwójnego zamknięcia)', () => {
    const withEp = [
      tx(),
      tx({ date: '2022-05-20T16:20:00', side: 'K', price: 0, value: 0, total: 0, commission: 0 }),
    ];
    const out = expireOptions(withEp, contracts, TODAY);
    expect(out).toHaveLength(2); // bez dostrzyknięcia
  });

  it('6) idempotencja — transform na własnym wyjściu nie dodaje drugiego zamknięcia', () => {
    const once = expireOptions([tx()], contracts, TODAY, new Map([[ISIN, 0]]));
    expect(once).toHaveLength(2); // open + syntetyczne K
    const twice = expireOptions(once, contracts, TODAY, new Map([[ISIN, 0]]));
    expect(twice).toHaveLength(2);
  });

  it('8) częściowe zamknięcie przed terminem → syntetyk domyka resztę', () => {
    const txs = [
      tx({ quantity: 5, value: 5 * 1632, total: 5 * 1631.32 }),
      tx({ date: '2022-03-01T10:00:00', side: 'K', quantity: 2, price: 5, value: 10, total: 10 }),
    ];
    const out = expireOptions(txs, contracts, TODAY, new Map([[ISIN, 0]]));
    const synth = out.find((t) => t.syntheticOrigin);
    expect(synth).toMatchObject({ side: 'K', quantity: 3, price: 0, total: 0 });
  });

  it('brak kontraktu (metadanych) → nie ruszamy pozycji', () => {
    const out = expireOptions([tx()], new Map(), TODAY);
    expect(out).toHaveLength(1);
  });
});

describe('computeOpenPositions — opcje po terminie znikają z otwartych', () => {
  it('1) long OTM bez zamknięcia → pozycja auto-domknięta (0 otwartych)', async () => {
    const { positions } = await computeOpenPositions(
      [tx({ side: 'K', price: 2.25, value: 225, total: 225.27, commission: 0.27 })],
      tickerMap,
      [],
      undefined,
      openOpts,
    );
    expect(positions).toHaveLength(0);
  });

  it('2a) short OTM bez zamknięcia → pozycja auto-domknięta (0 otwartych)', async () => {
    const { positions } = await computeOpenPositions([tx()], tickerMap, [], undefined, openOpts);
    expect(positions).toHaveLength(0);
  });
});

describe('computeClosedTrades — auto-domknięte round-tripy z realnym P/L', () => {
  it('2b) short OTM → wygaśnięcie po 0: zysk = premia − prowizja', () => {
    const trades = computeClosedTrades([tx()], tickerMap, [], [], [], contracts, new Map());
    expect(trades).toHaveLength(1);
    expect(trades[0].isShort).toBe(true);
    expect(trades[0].profitLoss).toBeCloseTo(1631.32, 2); // (16.32−0)×100 − 0.68
    expect(trades[0].category).toBe('option');
  });

  it('3a) short ITM → zamknięcie po wartości wewnętrznej', () => {
    // intrinsic 15 (put 60, bazowy 45) → P/L = (16.32 − 15) × 100 − 0.68 = 131.32
    const trades = computeClosedTrades(
      [tx()],
      tickerMap,
      [],
      [],
      [],
      contracts,
      new Map([[ISIN, 15]]),
    );
    expect(trades).toHaveLength(1);
    expect(trades[0].profitLoss).toBeCloseTo(131.32, 2);
  });

  it('3b) long ITM → zamknięcie po wartości wewnętrznej', () => {
    // kup 2.25, intrinsic 15 → P/L = (15 − 2.25) × 100 − 0.27 = 1274.73
    const trades = computeClosedTrades(
      [tx({ side: 'K', price: 2.25, value: 225, total: 225.27, commission: 0.27 })],
      tickerMap,
      [],
      [],
      [],
      contracts,
      new Map([[ISIN, 15]]),
    );
    expect(trades).toHaveLength(1);
    expect(trades[0].profitLoss).toBeCloseTo(1274.73, 2);
  });

  it('4) guard: realny Ep obecny → dokładnie 1 zamknięcie (nie 2)', () => {
    const trades = computeClosedTrades(
      [
        tx(),
        tx({ date: '2022-05-20T16:20:00', side: 'K', price: 0, value: 0, total: 0, commission: 0 }),
      ],
      tickerMap,
      [],
      [],
      [],
      contracts,
      new Map(),
    );
    expect(trades).toHaveLength(1);
    expect(trades[0].profitLoss).toBeCloseTo(1631.32, 2);
  });

  it('7) re-import supersedes: realny Ep zamyka, syntetyk się nie odpala', () => {
    const only = computeClosedTrades([tx()], tickerMap, [], [], [], contracts, new Map());
    expect(only).toHaveLength(1); // syntetyk
    const withReal = computeClosedTrades(
      [
        tx(),
        tx({ date: '2022-05-20T16:20:00', side: 'K', price: 0, value: 0, total: 0, commission: 0 }),
      ],
      tickerMap,
      [],
      [],
      [],
      contracts,
      new Map(),
    );
    expect(withReal).toHaveLength(1); // realny, nie zdublowany
  });
});

describe('resolveOptionExpirySettlements — wartość wewnętrzna w dniu wygaśnięcia', () => {
  it('bierze ostatni close ≤ expiry i liczy intrinsic (put)', async () => {
    (yahoo.fetchYahooHistory as any).mockResolvedValue([
      { date: '2022-05-18', close: 50 },
      { date: '2022-05-20', close: 44 },
      { date: '2022-05-23', close: 40 }, // po expiry — ignorowane
    ]);
    const m = await resolveOptionExpirySettlements([tx()], contracts, TODAY);
    // put 60, close 44 → max(60−44,0) = 16
    expect(m.get(ISIN)).toBeCloseTo(16, 6);
  });

  it('skaluje kurs o splity bazowego PO wygaśnięciu (Yahoo skorygowane → skala strike)', async () => {
    (yahoo.fetchYahooHistory as any).mockResolvedValue([{ date: '2022-05-20', close: 5 }]);
    (yahoo.fetchYahooSplitEvents as any).mockResolvedValue([{ date: '2023-01-01', ratio: 10 }]);
    const m = await resolveOptionExpirySettlements([tx()], contracts, TODAY);
    // close 5 × scale 10 = 50 → put 60 intrinsic max(60−50,0) = 10
    expect(m.get(ISIN)).toBeCloseTo(10, 6);
  });

  it('brak notowań bazowego → brak wpisu (fallback 0 w transformie)', async () => {
    (yahoo.fetchYahooHistory as any).mockResolvedValue([]);
    const m = await resolveOptionExpirySettlements([tx()], contracts, TODAY);
    expect(m.has(ISIN)).toBe(false);
  });
});
