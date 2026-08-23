import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock zewnętrznych źródeł PRZED importem resolvera (jak w isin-resolver-integration).
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

import { resolveIsin, lookupForeignAlias } from '../isin-resolver.js';
import * as tickerSearch from '../ticker-search.js';
import * as yahoo from '../yahoo-finance.js';

const search = tickerSearch.searchYahoo as unknown as ReturnType<typeof vi.fn>;
const price = yahoo.fetchYahooPrice as unknown as ReturnType<typeof vi.fn>;

/**
 * Wszystkie odpowiedzi Yahoo poniżej to ZAPIS ŻYWYCH WYWOŁAŃ z 2026-08-06,
 * zebranych przy diagnozie zgłoszenia „GOOGC.US bez kursu" (portfel prod z 7,5 szt.
 * GOOGC kupowanymi 2025-02..2026-07, ostatnia po 326,49 USD — czyli klasa C).
 */
describe('lookupForeignAlias — notacja klasy akcji u brokera', () => {
  it('GOOGC → GOOG (Alphabet klasa C; Yahoo trzyma ją pod gołym symbolem)', () => {
    expect(lookupForeignAlias('GOOGC')).toBe('GOOG');
  });

  it('łapie też symbol z sufiksem kraju — import uniwersalny go NIE obcina', () => {
    expect(lookupForeignAlias('GOOGC.US')).toBe('GOOG');
  });

  it('klasy akcji z myślnikiem u Yahoo: BRKB → BRK-B, BFB → BF-B, BRKA → BRK-A', () => {
    expect(lookupForeignAlias('BRKB')).toBe('BRK-B');
    expect(lookupForeignAlias('BFB')).toBe('BF-B');
    expect(lookupForeignAlias('BRKA')).toBe('BRK-A');
  });

  it('NOVOB.CO → NOVO-B.CO (7 portfeli na prodzie bez ceny)', () => {
    // Sufiks XTB .DK mapujemy na .CO, ale Yahoo trzyma tę akcję pod NOVO-B.CO.
    // Klucz działa i na sam symbol, i na wersję z sufiksem — bazę sprawdzamy osobno.
    expect(lookupForeignAlias('NOVOB')).toBe('NOVO-B.CO');
    expect(lookupForeignAlias('NOVOB.CO')).toBe('NOVO-B.CO');
  });

  it('nie rusza rebrandingu z FOREIGN_TICKER_ALIASES (RELI → EZRA)', () => {
    expect(lookupForeignAlias('RELI')).toBe('EZRA');
  });

  it('nieznany symbol → undefined (bez zgadywania)', () => {
    expect(lookupForeignAlias('AAPL')).toBeUndefined();
  });
});

describe('resolveIsin — GOOGC (zgłoszenie użytkownika 2026-08-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pyta Yahoo od razu o GOOG i zwraca notowanie z NASDAQ w USD', async () => {
    search.mockResolvedValue([{ symbol: 'GOOG', name: 'Alphabet Inc.', exchange: 'NasdaqGS' }]);
    price.mockResolvedValue({ price: 360.13, currency: 'USD' });

    const result = await resolveIsin('GOOGC', 'GOOGC', 'USD');

    expect(search).toHaveBeenCalledWith('GOOG');
    expect(result?.ticker).toBe('GOOG');
    expect(result?.currency).toBe('USD');
  });

  it('BEZ aliasu: chilijski GOOGCL.SN jest odrzucany, wpis zostaje nierozwiązany', async () => {
    // Realna odpowiedź Yahoo na „GOOGC" — jedyne trafienia to Santiago (CLP).
    // Odrzuca je już pickPlausible (GOOGC ≠ GOOGCL), guard waluty jest drugą linią.
    search.mockResolvedValue([
      { symbol: 'GOOGCL.SN', name: 'Alphabet Inc.', exchange: 'Santiago Stock Exchange' },
      { symbol: 'GOOGCL1.SN', name: 'ALPHABET INC.', exchange: 'Santiago Stock Exchange' },
    ]);
    price.mockResolvedValue({ price: 344490, currency: 'CLP' });

    // Symbol spoza mapy aliasów, żeby wymusić ścieżkę bez aliasu.
    const result = await resolveIsin('GOOGZ', 'GOOGZ', 'USD');

    expect(result).toBeNull();
  });
});

describe('resolveIsin — guard waluty dla trafień nie-dokładnych', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BRKB → odrzuca wiedeński BRKB.VI w EUR przy transakcji w USD', async () => {
    // Sedno luki: symbolMatches przepuszcza „BRKB" → „BRKB.VI" przez startsWith(q + '.'),
    // więc bez guardu portfel dostawał 449,15 EUR zamiast 518,85 USD za BRK-B.
    search.mockResolvedValue([
      { symbol: 'BRKB.VI', name: 'Berkshire Hathaway Inc.', exchange: 'Vienna' },
    ]);
    price.mockResolvedValue({ price: 449.15, currency: 'EUR' });

    // Zapytanie idzie aliasem (BRK-B), ale udajemy, że Yahoo oddaje tylko listing wiedeński.
    const result = await resolveIsin('BRKB', 'BRKB', 'USD');

    expect(result).toBeNull();
  });

  it('trafienie DOKŁADNE przechodzi nawet przy innej walucie (dual-listing to nie pomyłka)', async () => {
    search.mockResolvedValue([{ symbol: 'ASML.AS', name: 'ASML Holding N.V.', exchange: 'AMS' }]);
    price.mockResolvedValue({ price: 700, currency: 'EUR' });

    const result = await resolveIsin('ASML.AS', 'ASML.AS', 'USD');

    expect(result?.ticker).toBe('ASML.AS');
    expect(result?.currency).toBe('EUR');
  });

  it('GBX vs GBP to ta sama waluta — guard nie może tego odrzucić', async () => {
    search.mockResolvedValue([{ symbol: 'SHEL.L', name: 'Shell plc', exchange: 'LSE' }]);
    price.mockResolvedValue({ price: 2800, currency: 'GBp' });

    const result = await resolveIsin('SHEL', 'SHEL', 'GBP');

    expect(result?.ticker).toBe('SHEL.L');
  });

  it('brak ceny z Yahoo nie jest dowodem niezgodności — wpis przechodzi', async () => {
    search.mockResolvedValue([{ symbol: 'XYZ.VI', name: 'Xyz Corp', exchange: 'Vienna' }]);
    price.mockResolvedValue(null);

    const result = await resolveIsin('XYZ', 'Xyz Corp', 'USD');

    expect(result?.ticker).toBe('XYZ.VI');
  });
});
