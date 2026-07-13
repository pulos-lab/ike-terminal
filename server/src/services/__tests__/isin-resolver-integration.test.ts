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

  it('XTB-style SEVENET (paperName="SEV.WA", isin="SEV.WA") → NC (cross-check Stooq name)', async () => {
    // XTB importuje NC ticker jako "SEV.WA" (bez -NC suffix). Bez fix'a validateStooq
    // hardkodowało exchange='GPW'. Teraz cross-check z NC offline map name match.
    (tickerSearch.validateStooq as any).mockResolvedValue({
      symbol: 'SEV.WA',
      name: 'SEVENET',
    });
    const result = await resolveIsin('SEV.WA', 'SEV.WA', 'PLN');
    expect(result?.exchange).toBe('NC');
    expect(result?.ticker).toBe('SEV.WA');
    expect(result?.priceSource).toBe('stooq');
  });

  it('XTB-style Orlen (paperName="ORL.WA") → GPW (NC name nie matchuje Stooq name)', async () => {
    // Kolizja ticker code'u: ORL jest w NC map jako ORZLOPONY, ale na GPW to Orlen.
    // Stooq zwraca "Orlen" → NC name "ORZLOPONY" nie pasuje → klasyfikuj GPW.
    (tickerSearch.validateStooq as any).mockResolvedValue({
      symbol: 'ORL.WA',
      name: 'Orlen',
    });
    const result = await resolveIsin('ORL.WA', 'ORL.WA', 'PLN');
    expect(result?.exchange).toBe('GPW');
    expect(result?.ticker).toBe('ORL.WA');
  });

  it('DEGIRO SEVENET (real ISIN PLSEVNT00018, paperName="Sevenet S.A.") → NC (buildEntry override)', async () => {
    // DEGIRO ma real PL ISIN → Yahoo Strategy 1 first → Yahoo trap zwraca SEV.WA
    // Bez buildEntry override exchange byłoby hardkodowane GPW. Z override:
    // tickerBase "SEV" matchuje NC byTicker → NC entry name "SEVENET" matchuje
    // paperName "Sevenet S.A." → exchange override na NC.
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'SEV.WA', name: 'Sevenet S.A.', exchange: '' },
    ]);
    const result = await resolveIsin('PLSEVNT00018', 'Sevenet S.A.', 'PLN');
    expect(result?.exchange).toBe('NC');
    expect(result?.ticker).toBe('SEV.WA');
    expect(result?.priceSource).toBe('stooq');
  });

  it('DEGIRO Orlen (real ISIN PLPKN0000018, paperName="Orlen S.A.") → GPW (kolizja chroniona)', async () => {
    // Smoke test: kolizja ORL ticker code. NC ma ORZLOPONY, ale paperName/Yahoo
    // mówią "Orlen" → no substring match → zostaje GPW.
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'ORL.WA', name: 'Orlen', exchange: '' },
    ]);
    const result = await resolveIsin('PLPKN0000018', 'Orlen S.A.', 'PLN');
    expect(result?.exchange).toBe('GPW');
    expect(result?.ticker).toBe('ORL.WA');
  });

  it('PLASTBOX-FIX — sufiks -FIX jest stripowany, resolver szuka PLASTBOX', async () => {
    // Bossa sufiksuje instrumenty z ceną fixowaną: "-FIX" (jak "-NC-FIX" ale bez NC).
    // Bez stripowania cleanName = "PLASTBOX-FIX", resolver nie trafia do Yahoo/Stooq.
    // Testuje pseudo-ISIN (mBank/XTB style) — wtedy resolver używa cleanName do lookups.
    (tickerSearch.validateStooq as any).mockImplementation(async (query: string) => {
      if (query.toUpperCase().includes('PLASTBOX')) {
        return { symbol: 'PLX.WA', name: 'Plastbox' };
      }
      return undefined;
    });
    const result = await resolveIsin('PLASTBOX', 'PLASTBOX-FIX', 'PLN');
    expect(result?.ticker).toBe('PLX.WA');
    expect(result?.name).toBe('Plastbox');
    // Stooq powinien zostać wywołany z czystą nazwą (bez -FIX)
    const stooqCall = (tickerSearch.validateStooq as any).mock.calls[0]?.[0] as string | undefined;
    expect(stooqCall?.toUpperCase()).not.toContain('FIX');
    expect(stooqCall?.toUpperCase()).toContain('PLASTBOX');
  });
});
