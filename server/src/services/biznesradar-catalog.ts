/**
 * Katalog polskich instrumentów (GPW + NewConnect) z biznesradar.pl — źródło
 * podpowiedzi w wyszukiwarce tickerów (ticker-search).
 *
 * Powód: Yahoo search nie listuje NewConnect, a oba endpointy wyszukiwania
 * Stooqa są martwe (CSV `/q/l/` padł ~03.2026, `/cmp/` siedzi za anty-botowym
 * challengem JS — stan na 07.2026). Biznesradar nie ma wyszukiwarki
 * per-request: jego strona ładuje raz statyczny katalog wszystkich
 * instrumentów (`/service-data-short-js/1`, ~1,2 MB, serwowany z Varnisha
 * z `max-age=3600` — pobiera go każda przeglądarka każdego odwiedzającego).
 *
 * Strategia: JEDEN lazy fetch ≤1×/24h → persystencja w price_history.db
 * (restart/deploy w obrębie 24 h nie powtarza fetchu) → wyszukiwanie wyłącznie
 * na indexie w pamięci (zero żądań sieciowych per zapytanie). Po awarii fetchu
 * retry najwcześniej po 1 h (stale-while-error: stary katalog zostaje);
 * single-flight chroni przed równoległymi fetchami przy zimnym indexie.
 * Gdy katalog jest niedostępny i baza pusta, fallback = statyczna
 * NC_TICKER_MAP (pokrycie NewConnect działa zawsze, offline).
 *
 * Katalog BR nie rozróżnia GPW od NewConnect (oba = kod `BDM`) — rynek
 * ustalamy krzyżując ticker ze statyczną NC_TICKER_MAP. Wpisy delistowanych
 * spółek celowo zostają: przy ręcznym uzupełnianiu historycznych transakcji
 * to zaleta, nie szum.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { NC_TICKER_MAP } from 'shared';
import type { TickerSearchResult } from 'shared';
import { config } from '../config.js';

const CATALOG_URL = 'https://www.biznesradar.pl/service-data-short-js/1';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // ≤1×/24h
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // po awarii: ponów najwcześniej po 1h
/** Zimny start: nie każ użytkownikowi czekać na 1,2 MB dłużej niż to. */
const COLD_START_WAIT_MS = 2_500;
/**
 * Sanity: pełny katalog BDM ma ~5 tys. wpisów. Odpowiedź z mniej niż
 * MIN_PLAUSIBLE_ENTRIES traktujemy jak awarię (ucięty/zmieniony format),
 * żeby nie nadpisać dobrego katalogu śmieciem.
 */
const MIN_PLAUSIBLE_ENTRIES = 500;
/** Górny limit dopasowań zwracanych do merge'a w searchTickers. */
const MAX_MATCHES = 50;

/** Wpis katalogu po przefiltrowaniu do polskich akcji GPW/NC. */
export interface BrCatalogEntry {
  /** Ticker giełdowy, np. "AIT", "KGH" (bez sufiksu .WA). */
  ticker: string;
  /** Pełna nazwa spółki, np. "AITON CALDWELL SPÓŁKA AKCYJNA". */
  name: string;
  /** Skrót giełdowy stockwatch/bossa, np. "AITON" (bywa pusty). */
  shortName: string;
}

/** Tickery NewConnect ze statycznej mapy — rozróżnienie NC vs GPW. */
const NC_TICKERS = new Set(NC_TICKER_MAP.map((e) => e.ticker.toUpperCase()));

/**
 * Parser payloadu `service-data-short-js/1` (czysta funkcja, bez I/O).
 * Wejście: `var symbols = [{...},...];`. Zostają wyłącznie polskie akcje:
 * rynek `BDM`, z pełną nazwą (odcina indeksy typu WIG.GAMES5 z f=null)
 * i czystym tickerem (odcina serie typu BOS0735-K, TBSP.Index).
 * BDM zawiera też ~4 tys. serii obligacji Catalyst (ABE0227, DS0432…) —
 * 7-znakowe odpadają na długości, 6-znakowe na wzorcu serii
 * (1-2 znaki emitenta + 4 cyfry MMRR; realne spółki z cyframi jak 06N,
 * 11B, P24 mają cyfry w innym układzie).
 */
const BOND_SERIES_RE = /^[0-9A-Z]{1,2}\d{4}$/;

export function parseBrCatalog(js: string): BrCatalogEntry[] {
  const json = js
    .trim()
    .replace(/^var\s+symbols\s*=\s*/, '')
    .replace(/;\s*$/, '');
  const raw = JSON.parse(json) as Array<{
    s?: string;
    f?: string | null;
    m?: string | null;
    o?: string;
  }>;
  if (!Array.isArray(raw)) throw new Error('katalog BR: payload nie jest tablicą');
  const entries: BrCatalogEntry[] = [];
  for (const item of raw) {
    if (item?.o !== 'BDM') continue;
    const ticker = (item.s || '').toUpperCase();
    const name = (item.f || '').trim();
    if (!name || !/^[0-9A-Z]{2,6}$/.test(ticker) || BOND_SERIES_RE.test(ticker)) continue;
    entries.push({ ticker, name, shortName: (item.m || '').trim() });
  }
  return entries;
}

/**
 * Ranking dopasowania wewnątrz katalogu (przed globalnym relevanceScore
 * w searchTickers) — żeby cap MAX_MATCHES nigdy nie uciął trafienia
 * dokładnego na rzecz przypadkowego "contains".
 */
function matchScore(e: BrCatalogEntry, q: string): number {
  const ticker = e.ticker.toLowerCase();
  const short = e.shortName.toLowerCase();
  const name = e.name.toLowerCase();
  if (ticker === q || short === q) return 5;
  if (ticker.startsWith(q) || short.startsWith(q)) return 4;
  if (name.startsWith(q)) return 3;
  if (ticker.includes(q) || short.includes(q)) return 2;
  if (name.includes(q)) return 1;
  return 0;
}

function toResult(e: BrCatalogEntry): TickerSearchResult {
  return {
    symbol: `${e.ticker}.WA`,
    name: e.name,
    exchange: NC_TICKERS.has(e.ticker) ? 'NC' : 'GPW',
    currency: 'PLN',
  };
}

/** Fallback offline: sama statyczna mapa NC (ticker + skrócona nazwa). */
export function searchNcStatic(query: string): TickerSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return NC_TICKER_MAP.filter(
    (e) => e.ticker.toLowerCase().includes(q) || e.name.toLowerCase().includes(q),
  )
    .slice(0, MAX_MATCHES)
    .map((e) => ({
      symbol: `${e.ticker.toUpperCase()}.WA`,
      name: e.name,
      exchange: 'NC',
      currency: 'PLN',
    }));
}

export interface BrCatalogServiceOptions {
  fetchFn?: typeof fetch;
  now?: () => Date;
  /** Ścieżka bazy persystencji; ':memory:' w testach. */
  dbFile?: string;
  coldStartWaitMs?: number;
}

export interface BrCatalogService {
  /** Dopasowania z katalogu (lazy refresh w tle; nigdy nie rzuca). */
  search(query: string): Promise<TickerSearchResult[]>;
  close(): void;
}

export function createBrCatalogService(options: BrCatalogServiceOptions = {}): BrCatalogService {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const dbFile = options.dbFile ?? path.join(config.dataDir, 'price_history.db');
  const coldStartWaitMs = options.coldStartWaitMs ?? COLD_START_WAIT_MS;

  let db: Database.Database | null = null;
  let index: BrCatalogEntry[] | null = null; // null = jeszcze nie ładowany z DB
  let inFlightRefresh: Promise<void> | null = null;

  function getDb(): Database.Database {
    if (!db) {
      if (dbFile !== ':memory:') {
        const dir = path.dirname(dbFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      db = new Database(dbFile);
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS br_ticker_catalog (
          ticker TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          short_name TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS br_catalog_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }
    return db;
  }

  function getStateMs(key: string): number | null {
    const row = getDb().prepare('SELECT value FROM br_catalog_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return null;
    const ms = Date.parse(row.value);
    return Number.isFinite(ms) ? ms : null;
  }

  function setState(key: string, isoTimestamp: string): void {
    getDb()
      .prepare('INSERT OR REPLACE INTO br_catalog_state (key, value) VALUES (?, ?)')
      .run(key, isoTimestamp);
  }

  function loadIndexFromDb(): void {
    const rows = getDb()
      .prepare('SELECT ticker, name, short_name FROM br_ticker_catalog')
      .all() as Array<{ ticker: string; name: string; short_name: string }>;
    index = rows.map((r) => ({ ticker: r.ticker, name: r.name, shortName: r.short_name }));
  }

  async function doRefresh(): Promise<void> {
    setState('last_attempt', now().toISOString());
    try {
      const resp = await fetchFn(CATALOG_URL, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const entries = parseBrCatalog(await resp.text());
      if (entries.length < MIN_PLAUSIBLE_ENTRIES) {
        throw new Error(`podejrzanie mało wpisów (${entries.length}) — nie nadpisuję katalogu`);
      }
      const database = getDb();
      const insert = database.prepare(
        'INSERT OR REPLACE INTO br_ticker_catalog (ticker, name, short_name) VALUES (?, ?, ?)',
      );
      database.transaction(() => {
        database.prepare('DELETE FROM br_ticker_catalog').run();
        for (const e of entries) insert.run(e.ticker, e.name, e.shortName);
      })();
      setState('last_success', now().toISOString());
      index = entries;
    } catch (err) {
      // Stale-while-error: stary index/baza zostają; retry po RETRY_INTERVAL_MS.
      console.warn('[biznesradar-catalog] odświeżenie katalogu nie powiodło się:', err);
    }
  }

  /** Single-flight: równoległe wyszukiwania współdzielą jeden fetch. */
  function refreshIfDue(): Promise<void> | null {
    if (inFlightRefresh) return inFlightRefresh;
    const nowMs = now().getTime();
    const lastSuccess = getStateMs('last_success');
    const lastAttempt = getStateMs('last_attempt');
    const isStale = lastSuccess === null || nowMs - lastSuccess > REFRESH_INTERVAL_MS;
    const canAttempt = lastAttempt === null || nowMs - lastAttempt > RETRY_INTERVAL_MS;
    if (!isStale || !canAttempt) return null;
    inFlightRefresh = doRefresh().finally(() => {
      inFlightRefresh = null;
    });
    return inFlightRefresh;
  }

  return {
    async search(query: string): Promise<TickerSearchResult[]> {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      try {
        if (index === null) loadIndexFromDb();
        const refresh = refreshIfDue();
        if (refresh && index !== null && index.length === 0) {
          // Zimny start (pusta baza): daj fetchowi krótką szansę, potem nie blokuj —
          // refresh i tak dokończy się w tle (single-flight), fallback = mapa NC.
          await Promise.race([
            refresh,
            new Promise((resolve) => setTimeout(resolve, coldStartWaitMs)),
          ]);
        }
        if (index === null || index.length === 0) return searchNcStatic(query);
        return index
          .map((e) => ({ e, score: matchScore(e, q) }))
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_MATCHES)
          .map((m) => toResult(m.e));
      } catch (err) {
        // Wyszukiwarka nie może paść przez katalog (np. uszkodzona baza).
        console.warn('[biznesradar-catalog] search failed:', err);
        return searchNcStatic(query);
      }
    },
    close(): void {
      db?.close();
      db = null;
      index = null;
    },
  };
}

// ── Domyślna instancja (singleton) używana przez ticker-search ─────────────

let defaultService: BrCatalogService | null = null;

export function getBrCatalogService(): BrCatalogService {
  if (!defaultService) {
    defaultService = createBrCatalogService();
  }
  return defaultService;
}
