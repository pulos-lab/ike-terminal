import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external services BEFORE importing the resolver
vi.mock('../ticker-search.js', () => ({
  searchYahoo: vi.fn(),
  validateStooq: vi.fn(),
  searchStooqByName: vi.fn(),
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn(),
}));
vi.mock('../sector-resolver.js', () => ({
  resolveSector: vi.fn().mockResolvedValue({ supersector: null, subsector: null }),
}));

import { resolveIsin } from '../isin-resolver.js';
import * as tickerSearch from '../ticker-search.js';

describe('resolveIsin — full integration for SEVENET-NC trap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SEVENET-NC z REAL Polish ISIN PLSEVNT00018 → zwraca NC entry mimo że Yahoo zwraca SEV.WA bez OHLC', async () => {
    // Pułapka: Yahoo zwraca SEV.WA dla ISIN PLSEVNT00018 ale bez aktualnych OHLC
    // (Yahoo indeksuje symbol, ale nie pobiera cen NC). Resolver musi to wyłapać
    // przez wczesny tryNcOfflineGuard PRZED Yahoo lookup.
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'SEV.WA', name: '', exchange: '' },
    ]);

    const result = await resolveIsin('PLSEVNT00018', 'SEVENET-NC', 'PLN');

    expect(result).toEqual({
      isin: 'PLSEVNT00018',
      ticker: 'SEV.WA',
      name: 'SEVENET',
      exchange: 'NC',
      currency: 'PLN',
      priceSource: 'stooq',
    });

    // Gwarancja że Yahoo nie został wywołany — guard przerwał wcześniej
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
    expect(tickerSearch.validateStooq).not.toHaveBeenCalled();
  });

  it('SEVENET-NC z PSEUDO-ISIN (mBank/XTB style) też → NC entry', async () => {
    // Pseudo-ISIN scenario (mBank zapisuje 'SEVENET' jako ISIN dla NC stock)
    const result = await resolveIsin('SEVENET', 'SEVENET-NC', 'PLN');
    expect(result?.exchange).toBe('NC');
    expect(result?.ticker).toBe('SEV.WA');
    expect(result?.priceSource).toBe('stooq');
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
  });

  it('LEGIMI-NC trap → NC entry (regression dla bug znalezionego na prodzie)', async () => {
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'LEG.WA', name: 'Legimi', exchange: '' },
    ]);

    const result = await resolveIsin('PLLGIMI00029', 'LEGIMI-NC', 'PLN');
    expect(result?.exchange).toBe('NC');
    expect(result?.ticker).toBe('LEG.WA');
    expect(result?.name).toBe('LEGIMI');
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
  });

  it('GPW big-cap (CDR z mBank pseudo-ISIN) NIE jest klasyfikowany jako NC', async () => {
    // CDR (CD Projekt) jest na GPW, nie NC. paperName bez -NC → guard NIE odpala.
    (tickerSearch.validateStooq as any).mockResolvedValue({
      symbol: 'CDR.WA',
      name: 'CD Projekt',
    });
    const result = await resolveIsin('CDR', 'CDR', 'PLN');
    expect(result?.exchange).toBe('GPW');
    expect(result?.ticker).toBe('CDR.WA');
  });
});
