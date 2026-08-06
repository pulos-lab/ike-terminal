import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction } from 'shared';

/**
 * Krypto/CFD w resolveUnknownIsins: brokerzy tacy jak Trade Republic trzymają w
 * kolumnie symbolu TICKER (np. „BTC"), nie ISIN, więc findCfdTicker(isin) chybia.
 * Fallback na nazwę papieru („Bitcoin" → klucz BITCOIN → BTC-USD) domyka lukę.
 * Gałąź CFD jest OFFLINE (statyczna mapa) — mockujemy DB i sieć, by test był czysty.
 */

const upsertTickerMapEntry = vi.fn();
const getTickerMap = vi.fn(() => new Map());
vi.mock('../../db/ticker-map-repo.js', () => ({
  getTickerMap: (...args: unknown[]) => getTickerMap(...(args as [])),
  upsertTickerMapEntry: (...args: unknown[]) => upsertTickerMapEntry(...(args as [])),
  isProvisionalStub: () => false,
}));
// Bezpieczniki: gałąź CFD nie rusza sieci — gdyby ruszyła, test by to wykrył.
vi.mock('../ticker-search.js', () => ({ searchYahoo: vi.fn() }));
vi.mock('../yahoo-finance.js', () => ({ fetchYahooPrice: vi.fn() }));
vi.mock('../biznesradar-catalog.js', () => ({
  getBrCatalogService: () => ({
    warmUp: vi.fn().mockResolvedValue(undefined),
    findByTicker: vi.fn(),
    findByName: vi.fn(),
    search: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock('../sector-resolver.js', () => ({
  resolveSector: vi.fn().mockResolvedValue({ supersector: null, subsector: null, country: null }),
}));

import { resolveUnknownIsins } from '../isin-resolver.js';
import * as tickerSearch from '../ticker-search.js';

function cryptoTx(overrides: Partial<Transaction>): Transaction {
  return {
    date: '2026-07-09T07:26:37.621Z',
    paperName: 'Bitcoin',
    isin: 'BTC',
    quantity: 0.020811,
    side: 'K',
    price: 240253.73,
    value: 4999.92,
    commission: 4,
    total: 5003.92,
    currency: 'PLN',
    category: 'cfd',
    source: 'generic',
    ...overrides,
  } as Transaction;
}

describe('resolveUnknownIsins — krypto CFD po nazwie (Trade Republic „BTC")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTickerMap.mockReturnValue(new Map());
  });

  it('ISIN „BTC" (nie-ISIN) rozwiązuje się przez nazwę „Bitcoin" → BTC-USD (USD)', async () => {
    const result = await resolveUnknownIsins([cryptoTx({})], 'pf-test');

    expect(result.unresolved).toHaveLength(0);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({
      isin: 'BTC',
      ticker: 'BTC-USD',
      currency: 'USD',
      priceSource: 'yahoo',
    });
    expect(upsertTickerMapEntry).toHaveBeenCalledWith(
      expect.objectContaining({ isin: 'BTC', ticker: 'BTC-USD' }),
      'pf-test',
    );
    // Gałąź CFD jest offline — żaden lookup sieciowy się nie odpalił.
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
  });

  it('nadal raportuje nieznany instrument CFD, gdy ani ISIN, ani nazwa nie trafiają w mapę', async () => {
    const result = await resolveUnknownIsins(
      [cryptoTx({ isin: 'ZZZ', paperName: 'Zupełnie Nieznany Coin' })],
      'pf-test',
    );
    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({ isin: 'ZZZ' });
  });
});
