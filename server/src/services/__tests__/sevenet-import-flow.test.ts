import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseBossaTransactions } from '../../parsers/bossa-transactions.js';

vi.mock('../ticker-search.js', () => ({
  searchYahoo: vi.fn(),
  fetchYahooSymbolInfo: vi.fn(),
  validateStooq: vi.fn(),
  searchStooqByName: vi.fn(),
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn(),
}));
vi.mock('../sector-resolver.js', () => ({
  resolveSector: vi.fn().mockResolvedValue({ supersector: null, subsector: null, country: null }),
}));

import { resolveIsin } from '../isin-resolver.js';
import * as tickerSearch from '../ticker-search.js';

/**
 * E2E reprodukcja: parser → resolver dla SEVENET-NC.
 * Symuluje dokładnie to co Bossa CSV produkuje: paperName="SEVENET-NC",
 * isin="PLSEVNT00018". Sprawdza że pełen import flow zwraca poprawny NC entry.
 */
describe('SEVENET-NC import flow (Bossa parser + resolver)', () => {
  beforeEach(() => vi.clearAllMocks());

  const CSV =
    'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta\n' +
    '15.01.2024 10:00:00;SEVENET-NC;PLSEVNT00018;100;K;5.50;550.00;1.00;551.00;PLN\n';

  it('Bossa CSV row "SEVENET-NC;PLSEVNT00018" → parser produkuje paperName="SEVENET-NC"', () => {
    const result = parseBossaTransactions(CSV, 'test-batch');
    expect(result.data).toHaveLength(1);
    const tx = result.data[0];
    expect(tx.paperName).toBe('SEVENET-NC');
    expect(tx.isin).toBe('PLSEVNT00018');
  });

  it('Resolver na paperName="SEVENET-NC" z parsera → zwraca NC entry, NIE woła Yahoo', async () => {
    const result = parseBossaTransactions(CSV, 'test-batch');
    const tx = result.data[0];

    // Yahoo trap: gdyby resolver tu pytał, dostałby SEV.WA bez OHLC
    (tickerSearch.searchYahoo as any).mockResolvedValue([
      { symbol: 'SEV.WA', name: '', exchange: '' },
    ]);

    const entry = await resolveIsin(tx.isin, tx.paperName, tx.currency);

    // tryNcOfflineGuard MUSI przejąć i zwrócić NC
    expect(entry).toEqual({
      isin: 'PLSEVNT00018',
      ticker: 'SEV.WA',
      name: 'SEVENET',
      exchange: 'NC',
      currency: 'PLN',
      priceSource: 'stooq',
    });

    // Twardy assert: żadne external lookup nie zostało wywołane
    expect(tickerSearch.searchYahoo).not.toHaveBeenCalled();
    expect(tickerSearch.validateStooq).not.toHaveBeenCalled();
    expect(tickerSearch.searchStooqByName).not.toHaveBeenCalled();
  });
});
