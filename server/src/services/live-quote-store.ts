/**
 * Persystencja ostatniej znanej ceny live (wszystkie źródła).
 *
 * Problem: cena live żyła wyłącznie w NodeCache. Po restarcie procesu (deploy,
 * crash) cache był pusty, a jeśli źródło akurat nie odpowiadało, silnik schodził
 * na cenę z OSTATNIEJ TRANSAKCJI — wartość portfela cofała się o miesiące bez
 * żadnego sygnału poza dyskretnym `priceManual`.
 *
 * Ten store daje pośredni szczebel: „ostatnia cena, jaką realnie widzieliśmy",
 * ze znacznikiem czasu, żeby UI mógł powiedzieć „kurs z 01.08 17:05".
 *
 * ŚWIADOMIE OSOBNA TABELA, nie `price_history`. Tamta jest źródłem dziennych
 * zamknięć dla TWR i wykresu; wpisanie tam ceny śróddziennej fałszowałoby
 * historię (reguła „ostatnia data ≤3 dni = cache świeży" serwowałaby ją potem
 * jako oficjalne zamknięcie). Tabela `price_cache` per portfel też odpada —
 * cena rynkowa jest wspólna dla wszystkich najemców, nie prywatna dla portfela.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import type { YahooMarketState } from './yahoo-quotes.js';

/** Notowanie zapisane w store + kiedy je pobrano. */
export interface StoredQuote {
  price: number;
  currency: string;
  previousClose: number | null;
  marketState: YahooMarketState | null;
  quoteTime: number | null;
  /** ISO — moment pobrania (nie moment notowania). */
  fetchedAt: string;
}

export interface QuoteUpsert {
  ticker: string;
  price: number;
  currency: string;
  previousClose?: number | null;
  marketState?: YahooMarketState | null;
  quoteTime?: number | null;
  /** 'yahoo-v7' | 'yahoo-v8' | 'biznesradar' | 'stockwatch' | … */
  source: string;
}

export interface LiveQuoteStore {
  upsert(quotes: QuoteUpsert[]): void;
  get(ticker: string, maxAgeDays?: number): StoredQuote | null;
  getMany(tickers: string[], maxAgeDays?: number): Map<string, StoredQuote>;
}

export interface LiveQuoteStoreOptions {
  dbFile?: string;
  now?: () => Date;
}

/**
 * Domyślny limit wieku odczytu. Bez niego zdelistowany albo zepsuty ticker
 * pokazywałby archaiczny kurs jako aktualny — gorzej niż dzisiejszy fallback,
 * bo cicho i bez końca. 5 dni kalendarzowych przechodzi przez weekend i święta.
 */
const DEFAULT_MAX_AGE_DAYS = 5;

interface QuoteRow {
  ticker: string;
  price: number;
  currency: string;
  previous_close: number | null;
  market_state: string | null;
  quote_time: number | null;
  fetched_at: string;
}

function rowToQuote(row: QuoteRow): StoredQuote {
  return {
    price: row.price,
    currency: row.currency,
    previousClose: row.previous_close,
    marketState: (row.market_state as YahooMarketState | null) ?? null,
    quoteTime: row.quote_time,
    fetchedAt: row.fetched_at,
  };
}

export function createLiveQuoteStore(options: LiveQuoteStoreOptions = {}): LiveQuoteStore {
  const now = options.now ?? (() => new Date());
  // Write-through siedzi w każdym źródle cen, więc dowolny test dotykający
  // ścieżki cenowej pisałby do PRAWDZIWEJ price_history.db (i czytał stamtąd
  // w kolejnych testach — cichy wyciek stanu). Pod vitestem domyślnie pamięć;
  // testy store'a i tak podają dbFile jawnie.
  const defaultFile = process.env.VITEST
    ? ':memory:'
    : path.join(config.dataDir, 'price_history.db');
  const dbFile = options.dbFile ?? defaultFile;
  let db: Database.Database | null = null;

  function getDb(): Database.Database {
    if (!db) {
      if (dbFile !== ':memory:') {
        const dir = path.dirname(dbFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      db = new Database(dbFile);
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS live_quotes (
          ticker         TEXT PRIMARY KEY,
          price          REAL NOT NULL,
          currency       TEXT NOT NULL,
          previous_close REAL,
          market_state   TEXT,
          quote_time     INTEGER,
          source         TEXT NOT NULL,
          fetched_at     TEXT NOT NULL
        );
      `);
    }
    return db;
  }

  function cutoffIso(maxAgeDays: number): string {
    return new Date(now().getTime() - maxAgeDays * 86_400_000).toISOString();
  }

  return {
    upsert(quotes: QuoteUpsert[]): void {
      if (quotes.length === 0) return;
      try {
        const fetchedAt = now().toISOString();
        const stmt = getDb().prepare(`
          INSERT INTO live_quotes
            (ticker, price, currency, previous_close, market_state, quote_time, source, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ticker) DO UPDATE SET
            price = excluded.price,
            currency = excluded.currency,
            previous_close = excluded.previous_close,
            market_state = excluded.market_state,
            quote_time = excluded.quote_time,
            source = excluded.source,
            fetched_at = excluded.fetched_at
        `);
        const tx = getDb().transaction((rows: QuoteUpsert[]) => {
          for (const q of rows) {
            if (!q.ticker || !Number.isFinite(q.price) || q.price <= 0) continue;
            stmt.run(
              q.ticker,
              q.price,
              q.currency,
              q.previousClose ?? null,
              q.marketState ?? null,
              q.quoteTime ?? null,
              q.source,
              fetchedAt,
            );
          }
        });
        tx(quotes);
      } catch (err) {
        // Store jest wygodą, nie warunkiem działania — awaria zapisu nie może
        // wywalić wyceny portfela (siedzimy na gorącej ścieżce cen).
        console.error('[live-quotes] zapis nie powiódł się:', (err as Error).message);
      }
    },

    get(ticker: string, maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): StoredQuote | null {
      try {
        const row = getDb()
          .prepare('SELECT * FROM live_quotes WHERE ticker = ? AND fetched_at >= ?')
          .get(ticker, cutoffIso(maxAgeDays)) as QuoteRow | undefined;
        return row ? rowToQuote(row) : null;
      } catch (err) {
        console.error('[live-quotes] odczyt nie powiódł się:', (err as Error).message);
        return null;
      }
    },

    getMany(
      tickers: string[],
      maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
    ): Map<string, StoredQuote> {
      const out = new Map<string, StoredQuote>();
      if (tickers.length === 0) return out;
      try {
        const placeholders = tickers.map(() => '?').join(',');
        const rows = getDb()
          .prepare(
            `SELECT * FROM live_quotes WHERE ticker IN (${placeholders}) AND fetched_at >= ?`,
          )
          .all(...tickers, cutoffIso(maxAgeDays)) as QuoteRow[];
        for (const row of rows) out.set(row.ticker, rowToQuote(row));
      } catch (err) {
        console.error('[live-quotes] odczyt zbiorczy nie powiódł się:', (err as Error).message);
      }
      return out;
    },
  };
}

let defaultStore: LiveQuoteStore | null = null;
let testOverride: LiveQuoteStore | null = null;

/** Singleton produkcyjny (lazy — nie otwiera bazy przy imporcie modułu). */
export function getLiveQuoteStore(): LiveQuoteStore {
  if (testOverride) return testOverride;
  if (!defaultStore) defaultStore = createLiveQuoteStore();
  return defaultStore;
}

/** Testy podmieniają na instancję z ':memory:'; null przywraca default. */
export function setLiveQuoteStoreForTests(store: LiveQuoteStore | null): void {
  testOverride = store;
}
