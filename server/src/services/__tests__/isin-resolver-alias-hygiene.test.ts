import { describe, it, expect, vi } from 'vitest';

// Mocki jak w pozostałych testach resolvera — import modułu nie może dotykać
// sieci ani realnych baz (tu i tak sprawdzamy same dane statyczne).
vi.mock('../ticker-search.js', () => ({ searchYahoo: vi.fn(), fetchYahooSymbolInfo: vi.fn() }));
vi.mock('../biznesradar-catalog.js', () => ({
  getBrCatalogService: () => ({
    warmUp: vi.fn().mockResolvedValue(undefined),
    findByTicker: vi.fn(),
    findByName: vi.fn(),
    search: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock('../yahoo-finance.js', () => ({ fetchYahooPrice: vi.fn() }));
vi.mock('../sector-resolver.js', () => ({
  resolveSector: vi.fn().mockResolvedValue({ supersector: null, subsector: null, country: null }),
}));

import { NC_TICKER_MAP } from 'shared';
import { STOOQ_ALIASES } from '../isin-resolver.js';

/**
 * GENEZA (zgłoszenie 2026-08-23): alias `SUN → MIG` (Sundragon → Military Group,
 * 2025) kierował Suntech — obecnego właściciela kodu `SUN` na NewConnect — na
 * cudzy papier. Kod tickera bywa RECYKLOWANY po delistingu, więc alias, którego
 * KLUCZ jest dziś żywym kodem, jest miną. Ten test pilnuje, żeby kolejny taki
 * wpis nie wszedł niezauważony.
 */
describe('STOOQ_ALIASES — higiena mapy aliasów', () => {
  /** Klucze, dla których alias jest POPRAWNY, a nieaktualny jest wpis w mapie NC. */
  const KNOWN_STALE_NC = new Set([
    '7FT', // 7Fit → One More Level (2020); scraper mapy NC nie odświeżył wpisu
  ]);

  const ncByTicker = new Map(NC_TICKER_MAP.map((e) => [e.ticker.toUpperCase(), e.name]));

  it('żaden klucz aliasu nie jest ŻYWYM kodem tickera w NC_TICKER_MAP', () => {
    const collisions = Object.keys(STOOQ_ALIASES)
      .filter((key) => ncByTicker.has(key.toUpperCase()))
      .filter((key) => !KNOWN_STALE_NC.has(key.toUpperCase()))
      .map((key) => `${key} → ${STOOQ_ALIASES[key]} (kod nosi dziś ${ncByTicker.get(key)})`);

    expect(collisions).toEqual([]);
  });

  it('SUN i SKN zniknęły z mapy — kody należą dziś do Suntechu i Sakany', () => {
    expect(STOOQ_ALIASES.SUN).toBeUndefined();
    expect(STOOQ_ALIASES.SKN).toBeUndefined();
    expect(ncByTicker.get('SUN')).toBe('SUNTECH');
    expect(ncByTicker.get('SKN')).toBe('SAKANA');
  });

  it('alias nie wskazuje sam na siebie i nie tworzy cyklu', () => {
    for (const [key, target] of Object.entries(STOOQ_ALIASES)) {
      expect(target).not.toBe(key);
      // Łańcuchy są dozwolone (IQP → PUN → RAE → GVT), cykle nie.
      const seen = new Set([key]);
      let current: string | undefined = target;
      while (current && !seen.has(current)) {
        seen.add(current);
        current = STOOQ_ALIASES[current];
      }
      expect(current, `cykl aliasów zaczynający się na ${key}`).toBeUndefined();
    }
  });
});
