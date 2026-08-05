import NodeCache from 'node-cache';
import { config } from '../config.js';

const cache = new NodeCache({
  stdTTL: config.cache.priceTtl,
  checkperiod: 120,
  // Świadoma decyzja: BEZ klonowania przy odczycie.
  //
  // Domyślne `useClones: true` robi deep-clone przy KAŻDYM `get`. Dla ceny live
  // (mały obiekt) to bez znaczenia, ale serie historyczne to tablice o tysiącach
  // punktów, a `computePortfolioHistory` czyta je dla każdego tickera, każdej
  // pary FX i benchmarku przy każdym przeliczeniu — klonowanie było tam
  // najdroższą pojedynczą operacją cache'u.
  //
  // Kontrakt dla wołających: wartość z `getCached` jest WSPÓŁDZIELONA — nie wolno
  // jej mutować w miejscu (sort/push/splice). Wszyscy dzisiejsi konsumenci
  // historii tylko czytają (przepisanie do Map / filter / map); pilnuje tego
  // asercja na referencji w `price-cache.test.ts`.
  useClones: false,
});

export function getCached<T>(key: string): T | undefined {
  return cache.get<T>(key);
}

export function setCached<T>(key: string, value: T, ttl?: number): void {
  cache.set(key, value, ttl || config.cache.priceTtl);
}

/**
 * Statystyki cache'u do diagnostyki adminowej.
 *
 * Świadomie NIE ustawiamy `maxKeys`: NodeCache po przekroczeniu limitu rzuca
 * `ECACHEFULL` z `set()`, czyli zamienilibyśmy potencjalny wzrost pamięci na
 * wyjątki na ścieżce cen. Najpierw pomiar (ten endpoint), decyzja o limicie —
 * jeśli w ogóle — po zobaczeniu realnej kardynalności na produkcji.
 */
export function getCacheStats(): { keys: number; hits: number; misses: number } {
  const stats = cache.getStats();
  return { keys: cache.keys().length, hits: stats.hits, misses: stats.misses };
}
