import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TickerSearchResult } from 'shared';

// ── Mocki źródeł ────────────────────────────────────────────────────────────

const brSearchMock = vi.fn<(q: string) => Promise<TickerSearchResult[]>>();
vi.mock('../biznesradar-catalog.js', () => ({
  getBrCatalogService: () => ({
    warmUp: async () => {},
    search: brSearchMock,
    close: () => {},
  }),
}));

const getAllTickersMock = vi.fn<(portfolioId?: string) => unknown[]>();
vi.mock('../../db/ticker-map-repo.js', () => ({
  getAllTickers: (portfolioId?: string) => getAllTickersMock(portfolioId),
}));

vi.mock('../yahoo-auth.js', () => ({
  getYahooAuth: async () => null,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { searchTickers } = await import('../ticker-search.js');

function yahooResponse(quotes: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ quotes }),
  } as unknown as Response;
}

beforeEach(() => {
  brSearchMock.mockReset().mockResolvedValue([]);
  getAllTickersMock.mockReset().mockReturnValue([]);
  fetchMock.mockReset().mockResolvedValue(yahooResponse([]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchTickers — merge local → katalog BR → Yahoo', () => {
  it('scala trzy źródła; dedup po symbolu z priorytetem local > BR > Yahoo', async () => {
    getAllTickersMock.mockReturnValue([
      {
        ticker: 'KGH.WA',
        name: 'KGHM (lokalny)',
        isin: 'PLKGHM000017',
        exchange: 'GPW',
        currency: 'PLN',
      },
    ]);
    brSearchMock.mockResolvedValue([
      {
        symbol: 'KGH.WA',
        name: 'KGHM POLSKA MIEDŹ SPÓŁKA AKCYJNA',
        exchange: 'GPW',
        currency: 'PLN',
      },
      { symbol: 'AIT.WA', name: 'AITON CALDWELL SPÓŁKA AKCYJNA', exchange: 'NC', currency: 'PLN' },
    ]);
    fetchMock.mockResolvedValue(
      yahooResponse([
        {
          symbol: 'KGH.WA',
          longname: 'KGHM Polska Miedz S.A.',
          quoteType: 'EQUITY',
          exchDisp: 'Warsaw',
        },
        { symbol: 'KGHXF', longname: 'KGHM ADR', quoteType: 'EQUITY', exchDisp: 'OTC' },
      ]),
    );

    const results = await searchTickers('kgh', 'pf-1');
    const kgh = results.filter((r) => r.symbol === 'KGH.WA');
    expect(kgh).toHaveLength(1);
    expect(kgh[0]!.name).toBe('KGHM (lokalny)'); // wpis lokalny wygrywa dedup
    expect(results.map((r) => r.symbol)).toContain('AIT.WA'); // NC z katalogu BR
    expect(results.map((r) => r.symbol)).toContain('KGHXF'); // zagranica z Yahoo
  });

  it('spółka NC z katalogu BR trafia do wyników mimo braku w Yahoo', async () => {
    brSearchMock.mockResolvedValue([
      { symbol: 'AIT.WA', name: 'AITON CALDWELL SPÓŁKA AKCYJNA', exchange: 'NC', currency: 'PLN' },
    ]);

    const results = await searchTickers('aiton-test-nc');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ symbol: 'AIT.WA', exchange: 'NC', currency: 'PLN' });
  });

  it('przekazuje portfolioId do lokalnej ticker_map', async () => {
    await searchTickers('pid-test', 'pf-123');
    expect(getAllTickersMock).toHaveBeenCalledWith('pf-123');
  });

  it('Yahoo: filtr quoteType EQUITY/ETF (indeksy, fundusze, krypto odpadają)', async () => {
    fetchMock.mockResolvedValue(
      yahooResponse([
        { symbol: 'AAPL', longname: 'Apple Inc.', quoteType: 'EQUITY', exchDisp: 'NASDAQ' },
        { symbol: 'SPY', longname: 'SPDR S&P 500', quoteType: 'ETF', exchDisp: 'NYSEArca' },
        { symbol: '^GSPC', shortname: 'S&P 500', quoteType: 'INDEX', exchDisp: 'SNP' },
        { symbol: 'BTC-USD', shortname: 'Bitcoin', quoteType: 'CRYPTOCURRENCY', exchDisp: 'CCC' },
        { symbol: 'VFIAX', shortname: 'Vanguard 500', quoteType: 'MUTUALFUND', exchDisp: 'Nasdaq' },
      ]),
    );

    const symbols = (await searchTickers('typ-filter-test')).map((r) => r.symbol);
    expect(symbols).toContain('AAPL');
    expect(symbols).toContain('SPY');
    expect(symbols).not.toContain('^GSPC');
    expect(symbols).not.toContain('BTC-USD');
    expect(symbols).not.toContain('VFIAX');
  });

  it('cache per-query obejmuje tylko Yahoo — źródła lokalne liczone na żywo', async () => {
    fetchMock.mockResolvedValue(
      yahooResponse([
        { symbol: 'CDR.WA', longname: 'CD Projekt', quoteType: 'EQUITY', exchDisp: 'Warsaw' },
      ]),
    );
    await searchTickers('cache-test', 'pf-a');
    await searchTickers('cache-test', 'pf-b');

    expect(fetchMock).toHaveBeenCalledTimes(1); // Yahoo z cache przy drugim wywołaniu
    expect(brSearchMock).toHaveBeenCalledTimes(2); // BR liczony na żywo
    expect(getAllTickersMock).toHaveBeenNthCalledWith(1, 'pf-a');
    expect(getAllTickersMock).toHaveBeenNthCalledWith(2, 'pf-b'); // wynik NIE jest globalnie cache'owany
  });

  it('awaria Yahoo nie zabija podpowiedzi z pozostałych źródeł', async () => {
    fetchMock.mockRejectedValue(new Error('yahoo down'));
    brSearchMock.mockResolvedValue([
      { symbol: 'PKN.WA', name: 'ORLEN SPÓŁKA AKCYJNA', exchange: 'GPW', currency: 'PLN' },
    ]);

    const results = await searchTickers('orlen-fail-test');
    expect(results.map((r) => r.symbol)).toContain('PKN.WA');
  });
});
