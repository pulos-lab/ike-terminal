import { describe, it, expect } from 'vitest';
import { getCached, setCached, getCacheStats } from '../price-cache.js';

/**
 * Kontrakt `useClones: false` — dokumentacja świadomej decyzji dla przyszłych
 * czytelników. Klonowanie przy każdym odczycie było najdroższą operacją cache'u
 * (serie historyczne to tysiące punktów × każdy ticker przy każdym przeliczeniu
 * historii). Ceną jest zakaz mutowania odczytanej wartości w miejscu.
 */
describe('price-cache', () => {
  it('oddaje TĘ SAMĄ referencję (bez deep-clone przy odczycie)', () => {
    const series = [{ date: '2026-01-02', close: 10 }];
    setCached('test_series', series, 60);

    const first = getCached<typeof series>('test_series');
    const second = getCached<typeof series>('test_series');

    expect(first).toBe(series);
    expect(second).toBe(first);
  });

  it('statystyki raportują klucze i trafienia', () => {
    setCached('test_stats', 1, 60);
    getCached('test_stats');

    const stats = getCacheStats();
    expect(stats.keys).toBeGreaterThan(0);
    expect(stats.hits).toBeGreaterThan(0);
    expect(typeof stats.misses).toBe('number');
  });
});
