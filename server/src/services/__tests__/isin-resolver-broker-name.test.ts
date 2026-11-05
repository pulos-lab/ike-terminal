import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock zewnętrznych źródeł PRZED importem resolvera (jak w isin-resolver-foreign-alias).
vi.mock('../ticker-search.js', () => ({
  searchYahoo: vi.fn(),
  fetchYahooSymbolInfo: vi.fn(),
}));
vi.mock('../biznesradar-catalog.js', () => ({
  getBrCatalogService: () => ({
    warmUp: vi.fn().mockResolvedValue(undefined),
    findByTicker: vi.fn(),
    findByName: vi.fn(),
    search: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn(),
}));
vi.mock('../sector-resolver.js', () => ({
  resolveSector: vi.fn().mockResolvedValue({ supersector: null, subsector: null, country: null }),
}));

import { resolveIsin } from '../isin-resolver.js';
import * as tickerSearch from '../ticker-search.js';
import * as yahoo from '../yahoo-finance.js';

const search = tickerSearch.searchYahoo as unknown as ReturnType<typeof vi.fn>;
const price = yahoo.fetchYahooPrice as unknown as ReturnType<typeof vi.fn>;

/**
 * Odpowiedzi wyszukiwarki to ZAPIS ŻYWYCH WYWOŁAŃ z 2026-11-05 (zgłoszenie
 * „Bossa nie rozpoznaje TSM"): Yahoo nie indeksuje ISIN-u ADR-a TSMC, a nazwy
 * z Bossy w żadnej postaci z „Ltd" nie zna.
 */
const TSM_HITS = [
  { symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing Company Limited', exchange: 'NYSE' },
  {
    symbol: '2330.TW',
    name: 'Taiwan Semiconductor Manufacturing Company Limited',
    exchange: 'Taiwan',
  },
];

describe('resolveIsin — skrócona nazwa papieru z Bossy (ADR TSMC)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    price.mockResolvedValue({ price: 380.5, currency: 'USD' });
  });

  it.each(['PLN', 'USD'])(
    'US8740391003 „Taiwan Semi.Manufa.Ltd ADR" (transakcja w %s) → TSM',
    async (currency) => {
      search.mockImplementation(async (q: string) => (q === 'TAIWAN SEMI MANUFA' ? TSM_HITS : []));

      const result = await resolveIsin('US8740391003', 'Taiwan Semi.Manufa.Ltd ADR', currency);

      expect(result?.ticker).toBe('TSM');
      expect(result?.currency).toBe('USD');
      expect(search).toHaveBeenCalledWith('TAIWAN SEMI MANUFA');
    },
  );

  it('oczyszczona nazwa NIE bierze [0], gdy nazwa trafienia się nie zgadza', async () => {
    // Luźniejsze zapytanie ma wyłącznie ścieżkę walidowaną — cudza spółka na
    // pierwszym miejscu wyników nie może przejść, nawet przy realnym ISIN-ie.
    search.mockImplementation(async (q: string) =>
      q === 'TAIWAN SEMI MANUFA'
        ? [{ symbol: 'TSMX', name: 'Direxion Daily TSM Bull 2X ETF', exchange: 'NASDAQ' }]
        : [],
    );

    const result = await resolveIsin('US8740391003', 'Taiwan Semi.Manufa.Ltd ADR', 'PLN');

    expect(result).toBeNull();
  });

  it('nazwa, którą Yahoo zna wprost, nie generuje dodatkowego zapytania', async () => {
    search.mockImplementation(async (q: string) =>
      q === 'US67066G1040'
        ? [{ symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ' }]
        : [],
    );

    const result = await resolveIsin('US67066G1040', 'NVIDIA Corporation', 'PLN');

    expect(result?.ticker).toBe('NVDA');
    expect(search).toHaveBeenCalledTimes(1);
  });
});
