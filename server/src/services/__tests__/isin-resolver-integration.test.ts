import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external services BEFORE importing the resolver
vi.mock('../ticker-search.js', () => ({
  searchYahoo: vi.fn(),
}));
const findByTicker = vi.fn();
const findByName = vi.fn();
const warmUp = vi.fn().mockResolvedValue(undefined);
vi.mock('../biznesradar-catalog.js', () => ({
  getBrCatalogService: () => ({
    warmUp,
    findByTicker,
    findByName,
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

    // Gwarancja że Yahoo/katalog BR nie zostały wywołane — guard przerwał wcześniej
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
    expect(findByTicker).not.toHaveBeenCalled();
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
    findByTicker.mockResolvedValue({
      symbol: 'CDR.WA',
      name: 'CD PROJEKT RED SPÓŁKA AKCYJNA',
      exchange: 'GPW',
      currency: 'PLN',
    });
    const result = await resolveIsin('CDR', 'CDR', 'PLN');
    expect(result?.exchange).toBe('GPW');
    expect(result?.ticker).toBe('CDR.WA');
  });

  it('XTB-style SEVENET (paperName="SEV.WA", isin="SEV.WA") → NC (klasyfikacja katalogu BR)', async () => {
    // XTB importuje NC ticker jako "SEV.WA" (bez -NC suffix). Katalog BR sam
    // klasyfikuje NC (krzyżowanie z mapą NC + zgodność nazwy) — resolver ufa.
    findByTicker.mockResolvedValue({
      symbol: 'SEV.WA',
      name: 'SEVENET SPÓŁKA AKCYJNA',
      exchange: 'NC',
      currency: 'PLN',
    });
    const result = await resolveIsin('SEV.WA', 'SEV.WA', 'PLN');
    expect(result?.exchange).toBe('NC');
    expect(result?.ticker).toBe('SEV.WA');
    expect(result?.priceSource).toBe('stooq');
  });

  it('XTB-style Orlen (paperName="ORL.WA") → GPW (kolizję ORZLOPONY rozstrzyga katalog)', async () => {
    // Kolizja ticker code'u: ORL jest w NC map jako ORZLOPONY, ale na GPW to Orlen.
    // Katalog BR weryfikuje nazwę przy krzyżowaniu z mapą NC → zwraca GPW.
    findByTicker.mockResolvedValue({
      symbol: 'ORL.WA',
      name: 'ORLEN SPÓŁKA AKCYJNA',
      exchange: 'GPW',
      currency: 'PLN',
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
});

describe('resolveIsin — polski pseudo-ISIN vs zagraniczna kolizja tickera (katalog BR niedostępny)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Domyślnie: katalog BR niedostępny (zimny start, awaria BR), Yahoo zwraca zagraniczną kolizję.
    findByTicker.mockResolvedValue(null);
    findByName.mockResolvedValue(null);
  });

  it('XTB EXC.WA (Excellence NC) NIE łapie Exelon Corp — offline mapa NC wygrywa bez -NC', async () => {
    // Regresja zgłoszona z produ: EXC.WA/PLN był rozwiązywany na Exelon Corporation
    // (NASDAQ, USD, ~44 USD) gdy Stooq był rate-limitowany. Mapa NC ma EXC=EXCELLENC.
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'EXC', name: 'Exelon Corporation', exchange: 'NMS' },
    ]);
    const result = await resolveIsin('EXC.WA', 'EXC.WA', 'PLN');
    expect(result).toEqual({
      isin: 'EXC.WA',
      ticker: 'EXC.WA',
      name: 'EXCELLENC',
      exchange: 'NC',
      currency: 'PLN',
      priceSource: 'stooq',
    });
    // Yahoo nie może zdążyć zwrócić zagranicznego papieru — offline NC przerywa wcześniej.
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
  });

  it('XTB MNS.WA (Mennica Skarbowa NC) NIE łapie Monster Beverage', async () => {
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'MNST', name: 'Monster Beverage Corporation', exchange: 'NMS' },
    ]);
    const result = await resolveIsin('MNS.WA', 'MNS.WA', 'PLN');
    expect(result?.exchange).toBe('NC');
    expect(result?.ticker).toBe('MNS.WA');
    expect(result?.priceSource).toBe('stooq');
  });

  it('Polski pseudo-ISIN bez trafienia w NC i bez .WA z Yahoo → null (nie zagraniczny papier)', async () => {
    // Ticker spoza mapy NC. Stooq down, Yahoo zwraca tylko zagraniczny listing bez .WA.
    // Poprawnie: null (nierozwiązany) → przy następnym odświeżeniu Stooq rozwiąże na .WA.
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'ZZZ', name: 'Some Foreign Corp', exchange: 'NMS' },
    ]);
    const result = await resolveIsin('ZZZ.WA', 'ZZZ.WA', 'PLN');
    expect(result).toBeNull();
  });

  it('Polski pseudo-ISIN z hitem .WA z Yahoo (spoza NC) → nadal akceptowany jako GPW', async () => {
    // Guard nie może być zbyt agresywny: gdy Yahoo ma prawdziwy listing .WA, bierzemy go.
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'ABE.WA', name: 'AB S.A.', exchange: 'WSE' },
    ]);
    const result = await resolveIsin('ABE.WA', 'ABE.WA', 'PLN');
    expect(result?.ticker).toBe('ABE.WA');
    expect(result?.exchange).toBe('GPW');
    expect(result?.currency).toBe('PLN');
  });
});

describe('resolveIsin — sufiks -FIX i delisted GPW', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PLASTBOX-FIX (pseudo-ISIN) → sufiks -FIX stripowany, resolver szuka PLASTBOX', async () => {
    // Bossa sufiksuje instrumenty z ceną fixowaną: "-FIX" (jak "-NC-FIX" ale bez NC).
    // Bez stripowania cleanName = "PLASTBOX-FIX" i Stooq nie trafia.
    findByTicker.mockImplementation(async (query: string) => {
      if (query.toUpperCase().includes('PLASTBOX')) {
        return {
          symbol: 'PLX.WA',
          name: 'PLASTBOX SPÓŁKA AKCYJNA',
          exchange: 'GPW',
          currency: 'PLN',
        };
      }
      return null;
    });
    const result = await resolveIsin('PLASTBOX', 'PLASTBOX-FIX', 'PLN');
    expect(result?.ticker).toBe('PLX.WA');
    // Katalog odpytany czystą nazwą (bez -FIX)
    const brCall = findByTicker.mock.calls[0]?.[0] as string | undefined;
    expect(brCall?.toUpperCase()).not.toContain('FIX');
    expect(brCall?.toUpperCase()).toContain('PLASTBOX');
  });

  it('PLASTBOX-FIX z prawdziwym ISIN PLPSTBX00016 → delisted guard, ZERO requestów sieciowych', async () => {
    // PLASTBOX wycofany z GPW (2022) — Yahoo/Stooq nie mają danych. Statyczny guard
    // zwraca wpis bez żadnych zapytań.
    const result = await resolveIsin('PLPSTBX00016', 'PLASTBOX-FIX', 'PLN');
    expect(result).not.toBeNull();
    expect(result?.ticker).toBe('PLASTBOX');
    expect(result?.exchange).toBe('GPW');
    expect(result?.currency).toBe('PLN');
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
    expect(findByTicker).not.toHaveBeenCalled();
  });

  it('sufiks -FIX NIE psuje detekcji NewConnect (SEVENET-NC-FIX nadal NC)', async () => {
    // Regresja z odrzuconego podejścia: strip -NC w parserze wyłączał NC guard.
    // Tu resolver dostaje pełną nazwę z sufiksem i musi rozpoznać NC offline.
    const result = await resolveIsin('PLSEVNT00018', 'SEVENET-NC-FIX', 'PLN');
    expect(result?.exchange).toBe('NC');
    expect(result?.ticker).toBe('SEV.WA');
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
  });
});
