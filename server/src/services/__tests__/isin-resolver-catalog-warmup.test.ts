import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection — `resolveUnknownIsins`
// otwiera bazę portfela, więc bez tego test pisałby do prawdziwego `data/` repo.
// Import modułu testowanego MUSI być dynamiczny (statyczny wykona się przed tą linią).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-warmup-'));

const warmUp = vi.fn();
const findByTicker = vi.fn();
const findByName = vi.fn();
const searchYahoo = vi.fn();

vi.mock('../ticker-search.js', () => ({
  searchYahoo: (...a: unknown[]) => searchYahoo(...a),
  fetchYahooSymbolInfo: vi.fn(),
}));
vi.mock('../biznesradar-catalog.js', () => ({
  getBrCatalogService: () => ({
    warmUp,
    findByTicker,
    findByName,
    search: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock('../yahoo-finance.js', () => ({ fetchYahooPrice: vi.fn().mockResolvedValue(null) }));
vi.mock('../sector-resolver.js', () => ({
  resolveSector: vi.fn().mockResolvedValue({ supersector: null, subsector: null, country: null }),
}));

/**
 * GENEZA (produkcja, 2026-08-06): import XTB potrafi trafić w ZIMNY katalog BR.
 * `ensureIndex` czeka wtedy najwyżej 2,5 s i zwraca pustą listę, a `findByTicker`
 * / `findByName` nie odróżniają „jeszcze nie wczytane" od „nie ma takiej spółki".
 * Ścieżka plików binarnych nie zapisuje stuba, więc wynik utrwala się jako pozycja
 * bez ceny. Katalog musi być gotowy ZANIM zacznie się rozpoznawanie.
 */
describe('resolveUnknownIsins — katalog rozgrzewany przed rozpoznaniem', () => {
  let resolveUnknownIsins: typeof import('../isin-resolver.js').resolveUnknownIsins;

  beforeAll(async () => {
    ({ resolveUnknownIsins } = await import('../isin-resolver.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    warmUp.mockResolvedValue(undefined);
    findByTicker.mockResolvedValue(null);
    findByName.mockResolvedValue(null);
    searchYahoo.mockResolvedValue([]);
  });

  const tx = (isin: string) =>
    ({
      date: '2025-01-02T00:00:00',
      paperName: isin,
      isin,
      quantity: 1,
      side: 'K',
      price: 10,
      value: 10,
      commission: 0,
      total: 10,
      currency: 'PLN',
      category: 'stock',
    }) as never;

  it('woła warmUp ZANIM odpyta katalog', async () => {
    const order: string[] = [];
    warmUp.mockImplementation(async () => void order.push('warmUp'));
    findByTicker.mockImplementation(async () => {
      order.push('findByTicker');
      return null;
    });

    await resolveUnknownIsins([tx('ALLEGRO')], 'warmup-order');

    expect(order[0]).toBe('warmUp');
    expect(order).toContain('findByTicker');
  });

  it('awaria katalogu nie przerywa rozpoznawania (best effort)', async () => {
    warmUp.mockRejectedValue(new Error('biznesradar down'));

    await expect(resolveUnknownIsins([tx('ALLEGRO')], 'warmup-fail')).resolves.toMatchObject({
      resolved: [],
    });
  });

  it('brak nieznanych ISIN-ów → nie rusza katalogu (bez zbędnego pobrania)', async () => {
    await resolveUnknownIsins([], 'warmup-noop');

    expect(warmUp).not.toHaveBeenCalled();
  });
});
