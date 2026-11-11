import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock zewnętrznych źródeł PRZED importem resolvera (wzorzec isin-resolver-broker-name).
// OpenFIGI NIE jest mockowany jako moduł — idzie prawdziwy kod z wstrzykniętym
// fetch, który oddaje zapis żywej odpowiedzi.
vi.mock('../ticker-search.js', () => ({
  searchYahoo: vi.fn(),
  fetchYahooSymbolInfo: vi.fn(),
}));
vi.mock('../biznesradar-catalog.js', () => ({
  getBrCatalogService: () => ({
    warmUp: vi.fn().mockResolvedValue(undefined),
    findByTicker: vi.fn().mockResolvedValue(null),
    findByName: vi.fn().mockResolvedValue(null),
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
import { setOpenFigiDepsForTests } from '../openfigi.js';
import { createSourceGuard } from '../source-guard.js';
import * as tickerSearch from '../ticker-search.js';
import * as yahoo from '../yahoo-finance.js';

const search = tickerSearch.searchYahoo as unknown as ReturnType<typeof vi.fn>;
const symbolInfo = tickerSearch.fetchYahooSymbolInfo as unknown as ReturnType<typeof vi.fn>;
const price = yahoo.fetchYahooPrice as unknown as ReturnType<typeof vi.fn>;

/** Zapis żywej odpowiedzi OpenFIGI (2026-11-06) dla [US8740391003, US60744M1062]. */
const TSM_MBGL_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'openfigi-mapping-tsm-mbgl.json'),
  'utf-8',
);
const TSM_MBGL = JSON.parse(TSM_MBGL_RAW) as unknown[];
const JOB_INDEX: Record<string, number> = { US8740391003: 0, US60744M1062: 1 };

/** Fetch OpenFIGI: dla każdego zadania oddaje jego wynik z żywej odpowiedzi. */
const figiFetch = vi.fn(async (_url: string, init: RequestInit) => {
  const jobs = JSON.parse(init.body as string) as Array<{ idValue: string }>;
  const body = jobs.map((j) =>
    j.idValue in JOB_INDEX ? TSM_MBGL[JOB_INDEX[j.idValue]] : { warning: 'No identifier found.' },
  );
  return new Response(JSON.stringify(body), { status: 200 });
});

/** Yahoo zna symbole TSM i MBGL (dokładna zgodność) — tak jak na żywo 2026-11-06. */
const YAHOO_KNOWN: Record<string, { name: string; exchange: string }> = {
  TSM: { name: 'Taiwan Semiconductor Manufacturing Company Limited', exchange: 'NYQ' },
  MBGL: { name: 'Mobility Global, Inc.', exchange: 'NYQ' },
};

describe('resolveIsin — Strategy 1b: OpenFIGI, gdy Yahoo nie zna ISIN-u', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENFIGI = 'on';
    setOpenFigiDepsForTests({
      fetch: figiFetch as unknown as typeof fetch,
      now: () => Date.UTC(2026, 10, 6, 9, 0, 0),
      guard: createSourceGuard({ name: 'openfigi', now: () => Date.UTC(2026, 10, 6, 9, 0, 0) }),
    });
    // Yahoo po ISIN-ie (i po każdej nazwie) zwraca pustą listę — zmierzone dla US8740391003.
    search.mockResolvedValue([]);
    symbolInfo.mockImplementation(async (s: string) => YAHOO_KNOWN[s] ?? null);
    price.mockResolvedValue({ price: 380.5, currency: 'USD' });
  });

  afterAll(() => {
    setOpenFigiDepsForTests(null);
    process.env.OPENFIGI = 'off';
  });

  it.each(['PLN', 'USD'])(
    'US8740391003 rozpoznany BEZ nazwy od brokera (transakcja w %s)',
    async (cur) => {
      // Nazwa celowo bezużyteczna — rozpoznanie nie może od niej zależeć.
      const result = await resolveIsin('US8740391003', 'XXX', cur);

      expect(result?.ticker).toBe('TSM');
      expect(result?.name).toBe('Taiwan Semiconductor Manufacturing Company Limited');
      expect(result?.currency).toBe('USD');
      expect(result?.exchange).toBe('NYSE');
      // Jedno zapytanie do wyszukiwarki (po ISIN-ie) — szukanie po nazwie nie ruszyło.
      expect(search).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledWith('US8740391003');
      // Kolejność potwierdzenia: najpierw symbol w wyszukiwarce, potem cena.
      expect(symbolInfo).toHaveBeenCalledWith('TSM');
      expect(symbolInfo.mock.invocationCallOrder[0]).toBeLessThan(
        price.mock.invocationCallOrder[0],
      );
    },
  );

  it('US60744M1062 (spin-off MBGL) → MBGL', async () => {
    const result = await resolveIsin('US60744M1062', 'Mobility Global', 'USD');
    expect(result?.ticker).toBe('MBGL');
  });

  it('kandydat z OpenFIGI bez potwierdzenia w Yahoo NIE przechodzi — sama cena nie wystarcza', async () => {
    symbolInfo.mockResolvedValue(null);
    const result = await resolveIsin('US8740391003', 'XXX', 'USD');
    expect(result).toBeNull();
    expect(price).not.toHaveBeenCalledWith('TSM');
    // Resolver zszedł do Strategy 3 (po nazwie), która też nic nie dała.
    expect(search).toHaveBeenCalledWith('XXX');
  });

  it('OpenFIGI odcięty (429) → miękki miss, resolver idzie dalej po nazwie', async () => {
    figiFetch.mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }));
    search.mockImplementation(async (q: string) =>
      q === 'TAIWAN SEMI MANUFA'
        ? [
            {
              symbol: 'TSM',
              name: 'Taiwan Semiconductor Manufacturing Company Limited',
              exchange: 'NYSE',
            },
          ]
        : [],
    );
    const result = await resolveIsin('US8740391003', 'Taiwan Semi.Manufa.Ltd ADR', 'USD');
    expect(result?.ticker).toBe('TSM');
    expect(search).toHaveBeenCalledWith('TAIWAN SEMI MANUFA');
  });

  it('Yahoo zna ISIN → OpenFIGI nie jest pytany', async () => {
    search.mockImplementation(async (q: string) =>
      q === 'US67066G1040'
        ? [{ symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ' }]
        : [],
    );
    const result = await resolveIsin('US67066G1040', 'NVIDIA Corporation', 'USD');
    expect(result?.ticker).toBe('NVDA');
    expect(figiFetch).not.toHaveBeenCalled();
  });

  it('polski ISIN i pseudo-ISIN → OpenFIGI nie jest pytany (gałąź polska bez zmian)', async () => {
    await resolveIsin('PLPKN0000018', 'PKNORLEN', 'PLN');
    await resolveIsin('ETFSP500', 'ETFSP500', 'PLN');
    await resolveIsin('AAPL.US', 'AAPL', 'USD');
    expect(figiFetch).not.toHaveBeenCalled();
  });
});
