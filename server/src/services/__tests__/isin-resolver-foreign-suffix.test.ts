import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocki PRZED importem resolvera (ESM: statyczne importy wykonują się wcześniej).
vi.mock('../ticker-search.js', () => ({
  searchYahoo: vi.fn(),
  fetchYahooSymbolInfo: vi.fn(),
}));
const findByTicker = vi.fn();
const findByName = vi.fn();
vi.mock('../biznesradar-catalog.js', () => ({
  getBrCatalogService: () => ({
    warmUp: vi.fn().mockResolvedValue(undefined),
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
import * as yahooFinance from '../yahoo-finance.js';

const price = (currency: string, value = 100) => ({
  price: value,
  currency,
  previousClose: value,
  timestamp: 0,
});

/**
 * GENEZA (zgłoszenie 2026-08-23): pozycja `SMSN.UK` z XTB (GDR Samsunga na
 * londyńskim IOB) nie została rozpoznana. Sufiks `.UK` dawał etykietę GBP,
 * a papier notowany jest w USD; wyszukiwarka Yahoo na zapytanie `SMSN.L`
 * podsuwała sąsiedni listing, więc guard waluty odrzucał trafienie. Gdy
 * `resolveTradeCurrency` zapisał zamiast tego walutę KONTA (PLN), papier w
 * ogóle nie docierał do gałęzi zagranicznej.
 */
describe('resolveIsin — pseudo-ISIN z sufiksem giełdy zagranicznej', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByTicker.mockResolvedValue(null);
    findByName.mockResolvedValue(null);
    (tickerSearch.searchYahoo as any).mockResolvedValue([]);
    (tickerSearch.fetchYahooSymbolInfo as any).mockResolvedValue(null);
    (yahooFinance.fetchYahooPrice as any).mockResolvedValue(null);
  });

  it('SMSN.L z etykietą GBP (z sufiksu .UK) → wpis w USD prosto z notowania', async () => {
    (yahooFinance.fetchYahooPrice as any).mockResolvedValue(price('USD', 1300));
    (tickerSearch.fetchYahooSymbolInfo as any).mockResolvedValue({
      name: 'Samsung Electronics Co Ltd GDR',
      exchange: 'LSE',
    });

    const result = await resolveIsin('SMSN.L', 'SMSN.L', 'GBP');

    expect(result?.ticker).toBe('SMSN.L');
    expect(result?.name).toBe('Samsung Electronics Co Ltd GDR');
    expect(result?.currency).toBe('USD');
    expect(result?.exchange).toBe('OTHER');
    expect(result?.priceSource).toBe('yahoo');
    // Symbol jest już kanoniczny — wyszukiwarka nie jest potrzebna.
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
  });

  it('SMSN.L z etykietą PLN (waluta KONTA) NIE wpada w gałąź polską', async () => {
    (yahooFinance.fetchYahooPrice as any).mockResolvedValue(price('USD', 1300));
    (tickerSearch.fetchYahooSymbolInfo as any).mockResolvedValue({
      name: 'Samsung Electronics Co Ltd GDR',
      exchange: 'LSE',
    });

    const result = await resolveIsin('SMSN.L', 'SMSN.L', 'PLN');

    expect(result?.ticker).toBe('SMSN.L');
    expect(result?.currency).toBe('USD');
    // Gałąź polska akceptuje wyłącznie listingi .WA — tu nie ma czego szukać.
    expect(findByTicker).not.toHaveBeenCalled();
    expect(findByName).not.toHaveBeenCalled();
  });

  it('nazwa i giełda są ustawiane od razu (dla exchange=OTHER backfill nazw już tu nie zajrzy)', async () => {
    (yahooFinance.fetchYahooPrice as any).mockResolvedValue(price('USD'));
    (tickerSearch.fetchYahooSymbolInfo as any).mockResolvedValue({
      name: 'Samsung Electronics Co Ltd GDR',
      exchange: 'LSE',
    });

    const result = await resolveIsin('SMSN.L', 'SMSN.L', 'PLN');

    expect(result?.name).toBe('Samsung Electronics Co Ltd GDR');
    expect(tickerSearch.fetchYahooSymbolInfo).toHaveBeenCalledWith('SMSN.L');
  });

  it('ETF w USD na LSE (ISAC.L przy etykiecie GBP) → USD, bez zgadywania z sufiksu', async () => {
    (yahooFinance.fetchYahooPrice as any).mockResolvedValue(price('USD', 92.5));
    (tickerSearch.fetchYahooSymbolInfo as any).mockResolvedValue({
      name: 'iShares MSCI ACWI UCITS ETF',
      exchange: 'LSE',
    });

    const result = await resolveIsin('ISAC.L', 'ISAC.L', 'GBP');

    expect(result?.ticker).toBe('ISAC.L');
    expect(result?.currency).toBe('USD');
  });

  it('notowanie w pensach (GBX) przy etykiecie GBP jest akceptowane', async () => {
    (yahooFinance.fetchYahooPrice as any).mockResolvedValue(price('GBp', 812));
    (tickerSearch.fetchYahooSymbolInfo as any).mockResolvedValue({
      name: 'Vodafone Group Plc',
      exchange: 'LSE',
    });

    const result = await resolveIsin('VOD.L', 'VOD.L', 'GBP');

    expect(result?.ticker).toBe('VOD.L');
    expect(result?.currency).toBe('GBp');
  });

  it('alias notacji brokera z sufiksem (NOVOB → NOVO-B.CO) też idzie wprost, waluta DKK', async () => {
    (yahooFinance.fetchYahooPrice as any).mockResolvedValue(price('DKK', 420));
    (tickerSearch.fetchYahooSymbolInfo as any).mockResolvedValue({
      name: 'Novo Nordisk A/S',
      exchange: 'CPH',
    });

    const result = await resolveIsin('NOVOB', 'NOVOB', 'DKK');

    expect(result?.ticker).toBe('NOVO-B.CO');
    expect(result?.currency).toBe('DKK');
  });

  it('brak notowania dla symbolu → cofka do wyszukiwarki z PEŁNYMI guardami', async () => {
    // fetchYahooPrice(SMSN.L) = null (symbol nieznany Yahoo) → Strategy 1.
    // Wyszukiwarka podsuwa sąsiedni listing SMSN.IL w USD, transakcja jest w GBP
    // → trafienie NIE jest dokładne, więc guard waluty je odrzuca.
    (yahooFinance.fetchYahooPrice as any).mockImplementation(async (ticker: string) =>
      ticker === 'SMSN.IL' ? price('USD', 1300) : null,
    );
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'SMSN.IL', name: 'Samsung Electronics Co Ltd GDR', exchange: 'IOB' },
    ]);

    const result = await resolveIsin('SMSN.L', 'SMSN.L', 'GBP');

    expect(result).toBeNull();
    expect(tickerSearch.searchYahoo).toHaveBeenCalled();
  });

  it('goły symbol bez sufiksu (PLTR) nie uruchamia bezpośredniego sprawdzenia', async () => {
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'PLTR', name: 'Palantir Technologies Inc.', exchange: 'NMS' },
    ]);
    (yahooFinance.fetchYahooPrice as any).mockResolvedValue(price('USD', 25));

    const result = await resolveIsin('PLTR', 'PLTR', 'USD');

    expect(result?.ticker).toBe('PLTR');
    expect(tickerSearch.searchYahoo).toHaveBeenCalled();
    expect(tickerSearch.fetchYahooSymbolInfo).not.toHaveBeenCalled();
  });

  it('polski listing (.WA) zostaje w gałęzi polskiej', async () => {
    findByTicker.mockResolvedValue({
      symbol: 'JSW.WA',
      name: 'JASTRZĘBSKA SPÓŁKA WĘGLOWA',
      exchange: 'GPW',
      currency: 'PLN',
    });

    const result = await resolveIsin('JSW.WA', 'JSW.WA', 'PLN');

    expect(result?.ticker).toBe('JSW.WA');
    expect(result?.currency).toBe('PLN');
    expect(tickerSearch.fetchYahooSymbolInfo).not.toHaveBeenCalled();
  });

  it('kropka w symbolu CFD nie jest sufiksem giełdy — bezpośrednie sprawdzenie się nie odpala', async () => {
    // „WTI" i „CASH" nie są kodami giełd Yahoo, więc `OIL.WTI` / `HK.CASH` nie
    // trafiają w listę sufiksów; dodatkowo chroni je guard `cfdKnown`.
    // Rozpoznanie CFD idzie osobną gałęzią (`resolveUnknownIsins`, mapa CFD).
    await resolveIsin('OIL.WTI', 'OIL.WTI', 'USD');

    expect(tickerSearch.fetchYahooSymbolInfo).not.toHaveBeenCalled();
    expect(yahooFinance.fetchYahooPrice).not.toHaveBeenCalledWith('OIL.WTI');
  });
});
