import type { TickerMapEntry } from './types.js';

/**
 * Seed ticker map — intentionally empty.
 * Ticker resolution happens automatically during import via Stooq/Yahoo APIs.
 * Existing portfolios retain their resolved tickers in their SQLite databases.
 */
export const TICKER_MAP: TickerMapEntry[] = [];

export const ISIN_TO_TICKER = new Map(TICKER_MAP.map(e => [e.isin, e]));
export const TICKER_TO_ENTRY = new Map(TICKER_MAP.map(e => [e.ticker, e]));
