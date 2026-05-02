import type { TickerMapEntry } from './types.js';

/**
 * Seed ticker map — intentionally empty.
 * Ticker resolution happens automatically during import via Stooq/Yahoo APIs.
 * Existing portfolios retain their resolved tickers in their SQLite databases.
 */
export const TICKER_MAP: TickerMapEntry[] = [];
