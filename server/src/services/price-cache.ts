import NodeCache from 'node-cache';
import { config } from '../config.js';

const cache = new NodeCache({
  stdTTL: config.cache.priceTtl,
  checkperiod: 120,
});

export function getCachedPrice(key: string): number | undefined {
  return cache.get<number>(key);
}

export function setCachedPrice(key: string, price: number, ttl?: number): void {
  cache.set(key, price, ttl || config.cache.priceTtl);
}

export function getCached<T>(key: string): T | undefined {
  return cache.get<T>(key);
}

export function setCached<T>(key: string, value: T, ttl?: number): void {
  cache.set(key, value, ttl || config.cache.priceTtl);
}

export function clearCache(): void {
  cache.flushAll();
}
