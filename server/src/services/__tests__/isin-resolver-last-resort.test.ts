import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock zewnętrznych źródeł PRZED importem resolvera (jak w isin-resolver-integration).
vi.mock('../ticker-search.js', () => ({
  searchYahoo: vi.fn(),
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

import { resolveIsin, buildProvisionalStub } from '../isin-resolver.js';
import * as tickerSearch from '../ticker-search.js';
import * as yahoo from '../yahoo-finance.js';

const search = tickerSearch.searchYahoo as unknown as ReturnType<typeof vi.fn>;
const price = yahoo.fetchYahooPrice as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  search.mockReset();
  price.mockReset();
});

/**
 * „Ostatnia deska ratunku" dla polskich tickerów brała `byIsinRetry[0]` BEZ
 * walidacji — dokładnie wzorzec `[0]`, który ticker-match miał wyeliminować.
 * Yahoo potrafi błędnie dopasować nawet realny ISIN (US75960P1049 → Remitly
 * zamiast Reliance Global), a przy niedostępnym katalogu BR ta gałąź była
 * jedynym wyjściem dla realnych PL ISIN-ów.
 */
describe('resolveIsin — ostatnia deska ratunku (polski ticker)', () => {
  it('niewiarygodne [0] → null (stub + self-heal), nie cudza spółka', async () => {
    // Yahoo na każde zapytanie oddaje niepowiązany papier.
    search.mockResolvedValue([{ symbol: 'RELY', name: 'Remitly Global, Inc.', exchange: 'NMS' }]);

    const entry = await resolveIsin('PLTSQGM00016', 'TSGAMES', 'PLN');

    expect(entry).toBeNull();
  });

  it('wiarygodne trafienie przechodzi — zagraniczny listing polskiej spółki (obca waluta OK)', async () => {
    search.mockResolvedValue([
      { symbol: 'ZZZZ', name: 'Totally Different Corp', exchange: 'NMS' },
      { symbol: '1HQ.SG', name: 'Ten Square Games S.A.', exchange: 'SES' },
    ]);
    price.mockResolvedValue({ price: 1.0, currency: 'SGD' });

    const entry = await resolveIsin('PLTSQGM00016', 'TEN SQUARE GAMES', 'PLN');

    // CELOWO bez guardu waluty: listing w SGD dla transakcji w PLN jest legalny.
    expect(entry?.ticker).toBe('1HQ.SG');
  });
});

describe('resolveIsin — prefer-plausible na ścieżce realnych ISIN-ów', () => {
  it('[0] niewiarygodne, dalszy kandydat pasuje → bierzemy kandydata, nie [0]', async () => {
    // Scenariusz z genezy ticker-match, ale na ścieżce realnego ISIN-u
    // (dotąd niewalidowanej): [0] = dystrybutor stali, [1] = właściwa spółka.
    search.mockResolvedValue([
      { symbol: 'RS', name: 'Reliance, Inc.', exchange: 'NYQ' },
      { symbol: 'RELI', name: 'Reliance Global Group, Inc.', exchange: 'NMS' },
    ]);
    price.mockResolvedValue({ price: 2.28, currency: 'USD' });

    const entry = await resolveIsin('US75960P1049', 'RELIANCE GLOBAL GROUP', 'USD');

    expect(entry?.ticker).toBe('RELI');
  });

  it('żaden kandydat niewiarygodny → fallback do [0] (pokrycie bez regresji)', async () => {
    // Nazwy brokerów bywają nie do pogodzenia z Yahoo — ścieżka realnych
    // ISIN-ów pozostaje niewalidowana twardo, zmienia się tylko WYBÓR.
    search.mockResolvedValue([{ symbol: 'ODDX', name: 'Some Unrelated Fund', exchange: 'NYQ' }]);
    price.mockResolvedValue({ price: 10, currency: 'USD' });

    const entry = await resolveIsin('US0000000099', 'ACME INDUSTRIAL HOLDINGS', 'USD');

    expect(entry?.ticker).toBe('ODDX');
  });
});

describe('buildProvisionalStub — waluta z transakcji zamiast hardcode PLN', () => {
  it('PLN → GPW/stooq (dotychczasowe zachowanie)', () => {
    const stub = buildProvisionalStub({ isin: 'AUTO_X', paperName: 'SPÓŁKA', currency: 'PLN' });
    expect(stub).toMatchObject({
      ticker: 'SPÓŁKA',
      name: 'SPÓŁKA',
      exchange: 'GPW',
      currency: 'PLN',
      priceSource: 'stooq',
    });
  });

  it('obca waluta → OTHER/yahoo + waluta z transakcji (nie „polski" stub)', () => {
    const stub = buildProvisionalStub({ isin: 'US123', paperName: 'ACME CORP', currency: 'usd' });
    expect(stub).toMatchObject({ exchange: 'OTHER', currency: 'USD', priceSource: 'yahoo' });
  });

  it('brak waluty → bezpieczny default PLN', () => {
    const stub = buildProvisionalStub({ isin: 'X', paperName: 'Y', currency: '' });
    expect(stub.currency).toBe('PLN');
    expect(stub.exchange).toBe('GPW');
  });
});
