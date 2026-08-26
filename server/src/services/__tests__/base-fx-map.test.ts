import { describe, it, expect } from 'vitest';
import { buildBaseToPlnMap } from '../portfolio-views.js';

/** Snapshot FX silnika: waluta → mnożnik do waluty BAZOWEJ portfela. */
function day(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe('buildBaseToPlnMap', () => {
  it('odwraca mnożnik PLN→base na kurs base→PLN', () => {
    // Portfel USD przy USDPLN = 4: silnik zapisuje PLN→USD = 0.25.
    const fx = new Map([['2025-01-02', day({ PLN: 0.25, USD: 1 })]]);
    expect(buildBaseToPlnMap(fx)).toEqual({ '2025-01-02': 4 });
  });

  it('dla portfela PLN-owego kurs wychodzi 1', () => {
    const fx = new Map([['2025-01-02', day({ PLN: 1, USD: 4 })]]);
    expect(buildBaseToPlnMap(fx)).toEqual({ '2025-01-02': 1 });
  });

  it('pomija dni bez sensownego wpisu zamiast zapisywać 1', () => {
    // Cichy fallback na 1 potraktowałby walutę obcą jak złotówki — lepiej zostawić
    // lukę, którą konsument wypełni ostatnim znanym kursem.
    const fx = new Map([
      ['2025-01-01', day({ USD: 1 })],
      ['2025-01-02', day({ PLN: 0 })],
      ['2025-01-03', day({ PLN: -0.25 })],
      ['2025-01-04', day({ PLN: 0.2 })],
    ]);
    expect(buildBaseToPlnMap(fx)).toEqual({ '2025-01-04': 5 });
  });

  it('pusty snapshot daje pustą mapę', () => {
    expect(buildBaseToPlnMap(new Map())).toEqual({});
  });
});
