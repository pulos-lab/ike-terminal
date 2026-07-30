/**
 * Globalna tabela zdarzeń spin-off (`spinoff_events` w price_history.db) zasilana
 * scraperem stockanalysis.com/actions/spinoffs — szkielet 1:1 z
 * `gpw-dividend-calendar.ts`: lazy refresh ≤1×/24h za współdzielonym in-flight
 * promise, przy porażce stare wiersze zostają a retry następuje najwcześniej po 1h.
 *
 * Struktura źródła (skalibrowana na REALNYM HTML-u strony, fixture w testach):
 * tabela [Date | Parent | New Stock | Parent Company | New Company] — tickery
 * rodzica i dziecka w dedykowanych kolumnach (link `/stocks/<t>/` albo goły
 * tekst), markup SvelteKit SSR z szumem komentarzy `<!--[!-->` (cheerio .text()
 * go ignoruje). Strona NIE podaje ratio dystrybucji.
 *
 * Ratio uzupełnia osobny krok: `sec-ratio-resolver` (EDGAR full-text search po
 * formularzach 8-K rodzica i 10-12B dziecka — oficjalne filingi zawierają wprost
 * "1 share of X for every Y shares"). Do czasu jednoznacznego ratio zdarzenie ma
 * `ratio = NULL` i NIE jest kandydatem do aplikacji (getEvents zwraca tylko
 * kompletne wiersze; getPendingRatioEvents służy sygnalizacji w UI). Lepiej
 * czekać niż zgadywać — błędne ratio = błędna liczba akcji w portfelu.
 */
import * as cheerio from 'cheerio';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import type { SpinOffMapEntry } from 'shared';
import { resolveSpinoffRatioFromSec, type SecRatioResolution } from './sec-ratio-resolver.js';

// ── Typy ────────────────────────────────────────────────────────────────────

export interface SpinoffEventRow {
  parentTicker: string;
  parentName: string | null;
  childTicker: string;
  childName: string | null;
  exDate: string; // YYYY-MM-DD
  /** Akcje dziecka za 1 akcję rodzica; null = jeszcze nierozwiązane (SEC). */
  ratio: number | null;
  /** Skąd pochodzi ratio (URL filingu SEC) — audyt. */
  ratioSourceUrl: string | null;
}

/** Zdarzenie wykryte, ale czekające na ratio — do sygnalizacji w UI/logach. */
export interface SpinoffPendingEvent {
  parentTicker: string;
  childTicker: string;
  childName: string | null;
  exDate: string;
}

// ── Parser (czysta funkcja, bez I/O) ────────────────────────────────────────

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/** Parsuje daty "Jul 1, 2026" / "July 1, 2026" / ISO "2026-07-01" → ISO lub null. */
export function parseUsDate(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return t;
  const us = t.match(/^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/);
  if (!us) return null;
  const month = MONTHS[us[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  return `${us[3]}-${month}-${us[2].padStart(2, '0')}`;
}

const TICKER_RE = /^[A-Z0-9]{1,6}(?:\.[A-Z]{1,3})?$/;

/**
 * Parsuje stronę spin-offów stockanalysis. Tabela rozpoznawana po nagłówkach
 * zawierających "date" + "parent" + "new stock"; indeksy kolumn po nazwach.
 * Wiersze bez poprawnej daty/tickerów lub z datą poza oknem wiarygodności
 * (±2 lata) są pomijane i zliczane w `skipped`. Ratio NIE występuje na stronie —
 * wszystkie zdarzenia wychodzą z `ratio: null` (uzupełnia je sec-ratio-resolver).
 */
export function parseStockanalysisSpinoffs(
  html: string,
  now: Date = new Date(),
): { events: SpinoffEventRow[]; skipped: number } {
  const $ = cheerio.load(html);
  const events: SpinoffEventRow[] = [];
  let skipped = 0;

  let table: cheerio.Cheerio<never> | null = null;
  $('table').each((_, el) => {
    if (table) return;
    const headers = $(el)
      .find('th')
      .map((__, th) => $(th).text().trim().toLowerCase())
      .get();
    if (
      headers.some((h) => h.includes('date')) &&
      headers.some((h) => h === 'parent' || h === 'old symbol') &&
      headers.some((h) => h.includes('new stock') || h.includes('new symbol'))
    ) {
      table = $(el) as cheerio.Cheerio<never>;
    }
  });
  if (!table) return { events, skipped };

  const headers = ($(table) as ReturnType<typeof $>)
    .find('th')
    .map((_, th) => $(th).text().trim().toLowerCase())
    .get();
  const dateIdx = headers.findIndex((h) => h.includes('date'));
  const parentIdx = headers.findIndex((h) => h === 'parent' || h === 'old symbol');
  const childIdx = headers.findIndex((h) => h.includes('new stock') || h.includes('new symbol'));
  const parentNameIdx = headers.findIndex((h) => h.includes('parent company'));
  const childNameIdx = headers.findIndex((h) => h.includes('new company'));

  const nowYear = now.getFullYear();

  ($(table) as ReturnType<typeof $>).find('tbody tr, tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length <= Math.max(dateIdx, parentIdx, childIdx)) return; // nagłówek

    // .text() zjada linki <a> i komentarze SSR — zostaje czysty ticker/tekst
    const exDate = parseUsDate($(cells[dateIdx]).text());
    const parentTicker = $(cells[parentIdx]).text().trim().toUpperCase();
    const childTicker = $(cells[childIdx]).text().trim().toUpperCase();

    if (!exDate || !TICKER_RE.test(parentTicker) || !TICKER_RE.test(childTicker)) {
      skipped++;
      return;
    }
    // Okno wiarygodności dat (placeholdery/śmieci odpadają)
    const year = parseInt(exDate.slice(0, 4));
    if (year < nowYear - 2 || year > nowYear + 2) {
      skipped++;
      return;
    }

    const nameAt = (idx: number): string | null =>
      idx >= 0 && cells.length > idx ? $(cells[idx]).text().trim() || null : null;

    events.push({
      parentTicker,
      parentName: nameAt(parentNameIdx),
      childTicker,
      childName: nameAt(childNameIdx),
      exDate,
      ratio: null,
      ratioSourceUrl: null,
    });
  });

  return { events, skipped };
}

// ── Serwis: persystencja + odświeżanie ──────────────────────────────────────

const SPINOFFS_URL_BASE = 'https://stockanalysis.com/actions/spinoffs';

// Ten sam UA co gpw-dividend-calendar / scrape-gpw-sectors.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // ≤1×/24h
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // po awarii: ponów najwcześniej po 1h
/** Maks. liczba zdarzeń, dla których jeden refresh próbuje rozwiązać ratio z SEC. */
const MAX_RATIO_LOOKUPS_PER_REFRESH = 5;
/** Po tylu nieudanych próbach odpuszczamy ratio (rotacja i tak wraca do wiersza co kilka dni). */
const MAX_RATIO_ATTEMPTS = 20;
/** Zdarzenia starsze niż tyle dni od ex-date nie są już odpytywane w SEC. */
const RATIO_LOOKUP_MAX_AGE_DAYS = 90;

export interface SpinoffEventsServiceOptions {
  fetchFn?: typeof fetch;
  dbFile?: string;
  now?: () => Date;
  /** Wstrzykiwalny resolver ratio (testy); default: SEC EDGAR. */
  ratioResolver?: (event: {
    parentTicker: string;
    parentName: string | null;
    childTicker: string;
    childName: string | null;
    exDate: string;
  }) => Promise<SecRatioResolution | null>;
}

export interface SpinoffEventsService {
  /** Kompletne zdarzenia (z ratio) jako kandydaci appliera. Lazy refresh ≤1×/24h. */
  getEvents(): Promise<SpinOffMapEntry[]>;
  /** Zdarzenia czekające na ratio — czysty odczyt z DB (bez sieci). */
  getPendingRatioEvents(): SpinoffPendingEvent[];
  close(): void;
}

interface EventDbRow {
  parent_ticker: string;
  parent_name: string | null;
  child_ticker: string;
  child_name: string | null;
  ex_date: string;
  ratio: number | null;
  ratio_source_url: string | null;
}

export function createSpinoffEventsService(
  options: SpinoffEventsServiceOptions = {},
): SpinoffEventsService {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const dbFile = options.dbFile ?? path.join(config.dataDir, 'price_history.db');
  const ratioResolver =
    options.ratioResolver ?? ((event) => resolveSpinoffRatioFromSec(event, fetchFn));

  let db: Database.Database | null = null;
  let inFlightRefresh: Promise<void> | null = null;

  function getDb(): Database.Database {
    if (!db) {
      if (dbFile !== ':memory:') {
        const dir = path.dirname(dbFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      db = new Database(dbFile);
      db.pragma('journal_mode = WAL');
      // Wczesny kształt tabeli (gałąź przed-deployowa) miał ratio NOT NULL i brak
      // kolumn nazw/źródła — to tabela-cache, więc przy wykryciu starego kształtu
      // po prostu przebudowujemy (dane odtworzy najbliższy refresh).
      const cols = db.prepare(`PRAGMA table_info(spinoff_events)`).all() as Array<{
        name: string;
        notnull: number;
      }>;
      const ratioCol = cols.find((c) => c.name === 'ratio');
      const isLegacyShape =
        cols.length > 0 && (ratioCol?.notnull === 1 || !cols.some((c) => c.name === 'parent_name'));
      if (isLegacyShape) {
        db.exec('DROP TABLE IF EXISTS spinoff_events;');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS spinoff_events (
          parent_ticker TEXT NOT NULL,
          parent_name TEXT,
          child_ticker TEXT NOT NULL,
          child_name TEXT,
          ex_date TEXT NOT NULL,
          ratio REAL,
          ratio_source_url TEXT,
          fetched_at TEXT NOT NULL,
          ratio_attempts INTEGER NOT NULL DEFAULT 0,
          last_ratio_attempt TEXT,
          PRIMARY KEY (parent_ticker, ex_date)
        );
        CREATE TABLE IF NOT EXISTS spinoff_events_fetch_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      // Migracja istniejących baz: kolumny rotacji prób ratio (dodane osobno,
      // bo CREATE TABLE IF NOT EXISTS nie dotyka tabeli, która już jest).
      const shape = new Set(
        (db.prepare(`PRAGMA table_info(spinoff_events)`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!shape.has('ratio_attempts')) {
        db.exec('ALTER TABLE spinoff_events ADD COLUMN ratio_attempts INTEGER NOT NULL DEFAULT 0');
      }
      if (!shape.has('last_ratio_attempt')) {
        db.exec('ALTER TABLE spinoff_events ADD COLUMN last_ratio_attempt TEXT');
      }
    }
    return db;
  }

  function getStateMs(key: string): number | null {
    const row = getDb()
      .prepare('SELECT value FROM spinoff_events_fetch_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    if (!row) return null;
    const ms = Date.parse(row.value);
    return Number.isFinite(ms) ? ms : null;
  }

  function setState(key: string, isoTimestamp: string): void {
    getDb()
      .prepare('INSERT OR REPLACE INTO spinoff_events_fetch_state (key, value) VALUES (?, ?)')
      .run(key, isoTimestamp);
  }

  /**
   * Krok 2 refreshu: uzupełnij ratio z SEC dla wierszy z ratio IS NULL.
   *
   * Kolejność ROTACYJNA (najdawniej próbowane pierwsze, nigdy nieproszone na
   * samym początku — w SQLite NULL sortuje się przed wartościami). Wcześniejsze
   * `ORDER BY ex_date DESC LIMIT 5` powodowało, że przy ≥5 zaległych zdarzeniach
   * te starsze nie dostawały już NIGDY kolejnej próby: na prodzie 5 najstarszych
   * z 10 wisiało nietkniętych, a 5 najnowszych było odpytywanych codziennie.
   *
   * Dwie bramki ograniczają jałowe odpytywanie EDGAR-a: zdarzenia starsze niż
   * RATIO_LOOKUP_MAX_AGE_DAYS (filing dawno by już był) i te po
   * MAX_RATIO_ATTEMPTS próbach są odpuszczane.
   */
  async function resolveMissingRatios(): Promise<void> {
    const maxAge = new Date(now());
    maxAge.setDate(maxAge.getDate() - RATIO_LOOKUP_MAX_AGE_DAYS);
    const maxAgeStr = maxAge.toISOString().split('T')[0];

    const pending = getDb()
      .prepare(
        `SELECT parent_ticker, parent_name, child_ticker, child_name, ex_date
         FROM spinoff_events
         WHERE ratio IS NULL AND ex_date >= ? AND ratio_attempts < ?
         ORDER BY last_ratio_attempt ASC, ex_date DESC LIMIT ?`,
      )
      .all(maxAgeStr, MAX_RATIO_ATTEMPTS, MAX_RATIO_LOOKUPS_PER_REFRESH) as Array<{
      parent_ticker: string;
      parent_name: string | null;
      child_ticker: string;
      child_name: string | null;
      ex_date: string;
    }>;

    for (const row of pending) {
      // Licznik podbijany PRZED próbą — inaczej resolver wywracający się w kółko
      // (timeout, HTTP 500 EDGAR-a) nigdy nie wyczerpałby limitu prób.
      getDb()
        .prepare(
          `UPDATE spinoff_events
             SET ratio_attempts = ratio_attempts + 1, last_ratio_attempt = ?
           WHERE parent_ticker = ? AND ex_date = ?`,
        )
        .run(now().toISOString(), row.parent_ticker, row.ex_date);
      try {
        const resolved = await ratioResolver({
          parentTicker: row.parent_ticker,
          parentName: row.parent_name,
          childTicker: row.child_ticker,
          childName: row.child_name,
          exDate: row.ex_date,
        });
        if (resolved) {
          getDb()
            .prepare(
              `UPDATE spinoff_events SET ratio = ?, ratio_source_url = ?
               WHERE parent_ticker = ? AND ex_date = ?`,
            )
            .run(resolved.ratio, resolved.sourceUrl, row.parent_ticker, row.ex_date);
          console.log(
            `[spinoff-events] Ratio ${row.parent_ticker}→${row.child_ticker}: ` +
              `${resolved.ratio} (źródło: ${resolved.sourceUrl})`,
          );
        } else {
          console.log(
            `[spinoff-events] Ratio ${row.parent_ticker}→${row.child_ticker}: brak ` +
              `jednoznacznego wyniku w SEC — zdarzenie czeka (retry przy kolejnym refreshu)`,
          );
        }
      } catch (err) {
        console.warn(
          `[spinoff-events] Ratio lookup ${row.parent_ticker}→${row.child_ticker} padł:`,
          err,
        );
      }
    }
  }

  async function doRefresh(): Promise<void> {
    setState('last_attempt', now().toISOString());

    const year = now().getFullYear();
    const url = `${SPINOFFS_URL_BASE}/${year}/`;
    let events: SpinoffEventRow[] = [];
    try {
      const resp = await fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      const html = await resp.text();
      const parsed = parseStockanalysisSpinoffs(html, now());
      events = parsed.events;
      if (parsed.skipped > 0) {
        console.log(
          `[spinoff-events] ${url}: ${events.length} zdarzeń, ${parsed.skipped} wierszy pominiętych`,
        );
      }
    } catch (err) {
      // Stare wiersze zostają; last_attempt już ustawione → retry ≥1h.
      console.warn(`[spinoff-events] Nie udało się pobrać ${url}:`, err);
      return;
    }

    // Upsert NIE nadpisuje już rozwiązanego ratio (strona go nie zna — nadpisanie
    // cofałoby wynik resolvera SEC do NULL-a przy każdym refreshu).
    const database = getDb();
    const fetchedAt = now().toISOString();
    const insert = database.prepare(
      `INSERT INTO spinoff_events
         (parent_ticker, parent_name, child_ticker, child_name, ex_date, ratio,
          ratio_source_url, fetched_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(parent_ticker, ex_date) DO UPDATE SET
         parent_name = excluded.parent_name,
         child_ticker = excluded.child_ticker,
         child_name = excluded.child_name,
         fetched_at = excluded.fetched_at`,
    );
    database.transaction(() => {
      for (const e of events) {
        insert.run(e.parentTicker, e.parentName, e.childTicker, e.childName, e.exDate, fetchedAt);
      }
    })();
    setState('last_success', fetchedAt);

    // Krok 2: SEC ratio dla zdarzeń bez ratio (awarie nie psują refreshu)
    await resolveMissingRatios();
  }

  function refresh(): Promise<void> {
    if (!inFlightRefresh) {
      inFlightRefresh = doRefresh().finally(() => {
        inFlightRefresh = null;
      });
    }
    return inFlightRefresh;
  }

  function loadCompleteEvents(): SpinOffMapEntry[] {
    const rows = getDb()
      .prepare(
        `SELECT parent_ticker, parent_name, child_ticker, child_name, ex_date, ratio,
                ratio_source_url
         FROM spinoff_events WHERE ratio IS NOT NULL AND ratio > 0`,
      )
      .all() as EventDbRow[];
    return rows.map((r) => ({
      parentTicker: r.parent_ticker,
      childTicker: r.child_ticker,
      childName: r.child_name ?? undefined,
      exDate: r.ex_date,
      ratio: r.ratio!,
      source: r.ratio_source_url ?? undefined,
    }));
  }

  return {
    async getEvents(): Promise<SpinOffMapEntry[]> {
      const nowMs = now().getTime();
      const lastSuccess = getStateMs('last_success');
      const lastAttempt = getStateMs('last_attempt');

      const isStale = lastSuccess === null || nowMs - lastSuccess > REFRESH_INTERVAL_MS;
      const canAttempt = lastAttempt === null || nowMs - lastAttempt > RETRY_INTERVAL_MS;

      if (isStale && canAttempt) {
        await refresh();
      }
      return loadCompleteEvents();
    },
    getPendingRatioEvents(): SpinoffPendingEvent[] {
      const rows = getDb()
        .prepare(
          `SELECT parent_ticker, child_ticker, child_name, ex_date
           FROM spinoff_events WHERE ratio IS NULL`,
        )
        .all() as Array<{
        parent_ticker: string;
        child_ticker: string;
        child_name: string | null;
        ex_date: string;
      }>;
      return rows.map((r) => ({
        parentTicker: r.parent_ticker,
        childTicker: r.child_ticker,
        childName: r.child_name,
        exDate: r.ex_date,
      }));
    },
    close(): void {
      db?.close();
      db = null;
    },
  };
}

// ── Domyślna instancja (singleton) używana przez applier ───────────────────

let defaultService: SpinoffEventsService | null = null;

export function getSpinoffEventsService(): SpinoffEventsService {
  if (!defaultService) {
    defaultService = createSpinoffEventsService();
  }
  return defaultService;
}
