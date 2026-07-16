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
/**
 * Listing GPW GlobalConnect (zagraniczne spółki notowane na GPW w PLN) —
 * w katalogu BDM są nieodróżnialne od zwykłych spółek GPW, a w podpowiedziach
 * tylko mylą (AAPL.WA obok prawdziwego AAPL z NASDAQ). Strona listingu jest
 * renderowana server-side i służy jako zbiór wykluczeń.
 */
const GLOBALCONNECT_URL = 'https://www.biznesradar.pl/gielda/akcje_globalconnect';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // ≤1×/24h
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // po awarii: ponów najwcześniej po 1h
/** Przerwa grzecznościowa między katalogiem a stroną GC (wzorzec z gpw-dividend-calendar). */
const POLITENESS_DELAY_MS = 1_000;
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

/**
 * Ticker → nazwa NC ze statycznej mapy — rozróżnienie NC vs GPW.
 * Samo trafienie tickera NIE wystarcza: kody bywają reużywane między rynkami
 * (ORL = Orlen na GPW, ale w mapie NC ORZLOPONY) — klasyfikujemy NC tylko gdy
 * nazwa z katalogu potwierdza wpis mapy (ta sama reguła co buildEntry
 * w isin-resolverze).
 */
const NC_NAME_BY_TICKER = new Map(
  NC_TICKER_MAP.map((e) => [e.ticker.toUpperCase(), e.name.toUpperCase()]),
);

function isNcCatalogEntry(e: BrCatalogEntry): boolean {
  const ncName = NC_NAME_BY_TICKER.get(e.ticker);
  if (!ncName) return false;
  const name = e.name.toUpperCase();
  const short = e.shortName.toUpperCase();
  return (
    name.includes(ncName) ||
    ncName.includes(name) ||
    (short.length >= 3 && (short.includes(ncName) || ncName.includes(short)))
  );
}

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
    exchange: isNcCatalogEntry(e) ? 'NC' : 'GPW',
    currency: 'PLN',
  };
}

/**
 * Parser strony listingu GlobalConnect (czysta funkcja): tickery z linków
 * `/notowania/<TICKER>` (slug == ticker dla wpisów GC). Zwraca zbiór wykluczeń.
 */
export function parseGcTickers(html: string): Set<string> {
  const tickers = new Set<string>();
  for (const m of html.matchAll(/href="\/notowania\/([0-9A-Za-z-]+)"/g)) {
    tickers.add(m[1].toUpperCase());
  }
  return tickers;
}

/**
 * Normalizacja do porównań nazw: uppercase, bez polskich znaków (Ł→L, NFD),
 * tylko [A-Z0-9 ]. Nazwy brokerów są ASCII ("KGHM POLSKA MIEDZ"), katalog BR
 * ma pełne nazwy z diakrytykami ("KGHM POLSKA MIEDŹ SPÓŁKA AKCYJNA").
 */
function normalizeForMatch(s: string): string {
  return s
    .toUpperCase()
    .replace(/Ł/g, 'L')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Weryfikacja nazwy przy dopasowaniu po tickerze (reguła z dawnego
 * validateStooq): dokładna równość LUB jedna nazwa zaczyna się od pierwszych
 * 4 znaków drugiej (obie ≥4 znaki). Chroni przed fałszywymi trafieniami
 * skróconych kandydatów (np. "MOL" = MOL Magyar, nie Molecure).
 */
function namesOverlap(expected: string, actual: string): boolean {
  const e = normalizeForMatch(expected);
  const a = normalizeForMatch(actual);
  if (!e || !a) return false;
  if (e === a) return true;
  const minLen = Math.min(e.length, a.length);
  if (minLen < 4) return false;
  return a.startsWith(e.substring(0, 4)) || e.startsWith(a.substring(0, 4));
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
  politenessDelayMs?: number;
}

export interface BrCatalogService {
  /** Dopasowania z katalogu (lazy refresh w tle; nigdy nie rzuca). */
  search(query: string): Promise<TickerSearchResult[]>;
  /**
   * Dokładne dopasowanie tickera (dla isin-resolvera — następca validateStooq).
   * `expectedName` włącza weryfikację nazwy (ochrona skróconych kandydatów
   * przed fałszywymi trafieniami). Zwraca null też gdy katalog niedostępny.
   */
  findByTicker(ticker: string, expectedName?: string): Promise<TickerSearchResult | null>;
  /**
   * Konserwatywne dopasowanie po nazwie spółki (następca searchStooqByName):
   * dokładny skrót lub prefiks nazwy/skrótu. Zwraca najlepsze trafienie.
   */
  findByName(name: string): Promise<TickerSearchResult | null>;
  close(): void;
}

export function createBrCatalogService(options: BrCatalogServiceOptions = {}): BrCatalogService {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const dbFile = options.dbFile ?? path.join(config.dataDir, 'price_history.db');
  const coldStartWaitMs = options.coldStartWaitMs ?? COLD_START_WAIT_MS;
  const politenessDelayMs = options.politenessDelayMs ?? POLITENESS_DELAY_MS;

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

  async function fetchPage(url: string): Promise<string> {
    const resp = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return await resp.text();
  }

  async function doRefresh(): Promise<void> {
    setState('last_attempt', now().toISOString());
    try {
      const rawEntries = parseBrCatalog(await fetchPage(CATALOG_URL));
      if (rawEntries.length < MIN_PLAUSIBLE_ENTRIES) {
        throw new Error(`podejrzanie mało wpisów (${rawEntries.length}) — nie nadpisuję katalogu`);
      }

      // Wykluczenie GlobalConnect. Awaria strony GC = awaria całego odświeżenia
      // (stary katalog zostaje, retry ≥1h) — inaczej złamalibyśmy niezmiennik
      // "katalog w bazie jest wolny od GC".
      await new Promise((resolve) => setTimeout(resolve, politenessDelayMs));
      const gcTickers = parseGcTickers(await fetchPage(GLOBALCONNECT_URL));
      if (gcTickers.size < 5) {
        throw new Error(
          `podejrzanie mało tickerów GlobalConnect (${gcTickers.size}) — możliwa zmiana strony`,
        );
      }
      const entries = rawEntries.filter((e) => !gcTickers.has(e.ticker));

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

  /**
   * Index gotowy do przeszukania (lazy load z DB + refresh gdy stale).
   * Zimny start (pusta baza): daj fetchowi krótką szansę, potem nie blokuj —
   * refresh i tak dokończy się w tle (single-flight). Pusta tablica = katalog
   * (jeszcze) niedostępny.
   */
  async function ensureIndex(): Promise<BrCatalogEntry[]> {
    if (index === null) loadIndexFromDb();
    const refresh = refreshIfDue();
    if (refresh && index !== null && index.length === 0) {
      await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, coldStartWaitMs))]);
    }
    return index ?? [];
  }

  return {
    async search(query: string): Promise<TickerSearchResult[]> {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      try {
        const entries = await ensureIndex();
        if (entries.length === 0) return searchNcStatic(query);
        return entries
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

    async findByTicker(ticker: string, expectedName?: string): Promise<TickerSearchResult | null> {
      const base = ticker
        .trim()
        .toUpperCase()
        .replace(/\.(WA|NC)$/, '');
      if (!base) return null;
      try {
        const entries = await ensureIndex();
        const hit = entries.find((e) => e.ticker === base);
        if (!hit) return null;
        if (expectedName) {
          // Furtka tożsamości tickera: user podał sam kod ("CDR", "ORL.WA") —
          // wtedy dokładne trafienie kodu JEST potwierdzeniem, nazwy nie ma z czym
          // porównywać. Weryfikacja nazwy chroni tylko kandydatów obciętych/
          // aliasowanych (expectedName ≠ kod trafionego wpisu).
          const expectedTicker = expectedName
            .trim()
            .toUpperCase()
            .replace(/\.(WA|NC)$/, '');
          const isTickerItself = expectedTicker === hit.ticker;
          if (
            !isTickerItself &&
            !namesOverlap(expectedName, hit.name) &&
            !namesOverlap(expectedName, hit.shortName)
          ) {
            return null;
          }
        }
        return toResult(hit);
      } catch (err) {
        console.warn('[biznesradar-catalog] findByTicker failed:', err);
        return null;
      }
    },

    async findByName(name: string): Promise<TickerSearchResult | null> {
      const q = normalizeForMatch(name);
      if (q.length < 3) return null;
      try {
        const entries = await ensureIndex();
        let best: { e: BrCatalogEntry; score: number } | null = null;
        for (const e of entries) {
          const short = normalizeForMatch(e.shortName);
          const full = normalizeForMatch(e.name);
          let score = 0;
          if (short && short === q) score = 3;
          else if (full.startsWith(q)) score = 2;
          else if (short && short.startsWith(q)) score = 1;
          if (score > (best?.score ?? 0)) best = { e, score };
        }
        return best ? toResult(best.e) : null;
      } catch (err) {
        console.warn('[biznesradar-catalog] findByName failed:', err);
        return null;
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
