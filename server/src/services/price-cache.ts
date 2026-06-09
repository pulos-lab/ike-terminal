import NodeCache from 'node-cache';
import { config } from '../config.js';

const cache = new NodeCache({
  stdTTL: config.cache.priceTtl,
  checkperiod: 120,
});

export function getCached<T>(key: string): T | undefined {
  return cache.get<T>(key);
}

export function setCached<T>(key: string, value: T, ttl?: number): void {
  cache.set(key, value, ttl || config.cache.priceTtl);
}
