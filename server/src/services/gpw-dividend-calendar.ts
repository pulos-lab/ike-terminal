/**
 * Kalendarz dywidend GPW + NewConnect scrape'owany z dwóch publicznych stron HTML:
 *
 *  1. stockwatch.pl/dywidendy           — autorytatywne ex-date / kwota / status / stopa,
 *                                         ale identyfikuje spółki SKRÓTEM GPW (bez tickera).
 *  2. biznesradar.pl/dywidendy (+ /dywidendy/newconnect) — dostarcza ticker (= baza Yahoo,
 *                                         np. 1AT → 1AT.WA) i dzień wypłaty; daty "z prawem"
 *                                         bywają zaszumione, więc przy konflikcie wygrywa
 *                                         stockwatch.
 *
 * Semantyka dat:
 *  - stockwatch "Notowanie bez dyw." to wprost ex-date (pierwsza sesja bez prawa).
 *  - biznesradar "Ostatnie notowanie z prawem" to ex-date − 1 sesja; dla rekordów znanych
 *    tylko z biznesradar przybliżamy ex-date jako następny dzień roboczy (pomijamy weekendy;
 *    święta GPW NIE są obsługiwane — akceptowalne przybliżenie, bo dotyczy wyłącznie wierszy
 *    bez pokrycia w stockwatch).
 *
 * Grzeczność: maks. 3 requesty HTTP na dobę (3 strony, sekwencyjnie, 1 s przerwy),
 * odświeżanie lazy ≤1×/24 h za pojedynczym współdzielonym promise; przy totalnej awarii
 * trzymamy stare wiersze i ponawiamy najwcześniej po 1 h. NIGDY nie ma requestów per-ticker.
 */
import * as cheerio from 'cheerio';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import type { UpcomingDividend } from 'shared';

// ── Typy ────────────────────────────────────────────────────────────────────

export type GpwDividendStatus = 'proponowana' | 'uchwalona' | 'wypłacona';

export interface GpwCalendarEntry {
  /** Baza tickera Yahoo (bez `.WA`), z biznesradar; null = wiersz znany tylko ze stockwatch. */
  ticker: string | null;
  /** Skrót GPW (uppercase) — klucz łączenia obu źródeł. */
  shortName: string;
  amountPln: number;
  /** YYYY-MM-DD — pierwsza sesja bez prawa do dywidendy. */
  exDate: string | null;
  payDate: string | null;
  status: GpwDividendStatus | null;
  /** Stopa dywidendy w procentach (stockwatch "Stopa", np. 1.21). */
  yieldPct: number | null;
  source: 'stockwatch' | 'biznesradar' | 'merged';
}

// ── Daty ────────────────────────────────────────────────────────────────────

const POLISH_MONTHS: Record<string, string> = {
  sty: '01',
  lut: '02',
  mar: '03',
  kwi: '04',
  maj: '05',
  cze: '06',
  lip: '07',
  sie: '08',
  wrz: '09',
  paź: '10',
  lis: '11',
  gru: '12',
};

/**
 * Parsuje datę w formacie ISO (`2026-08-18`) lub polskim skrócie (`24 cze 26`).
 * `bd.` / pusty tekst → null. Daty spoza okna wiarygodności [now−2 lata, now+3 lata]
 * → null (stockwatch potrafi publikować placeholdery typu 2062-08-10).
 */
export function parsePolishDate(text: string, now: Date = new Date()): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t === 'bd.' || t === 'bd') return null;

  let iso: string | null = null;
  const isoMatch = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    iso = t;
  } else {
    const plMatch = t.match(/^(\d{1,2}) (\p{L}{3}) (\d{2})$/u);
    if (plMatch) {
      const month = POLISH_MONTHS[plMatch[2].toLowerCase()];
      if (!month) return null;
      iso = `20${plMatch[3]}-${month}-${plMatch[1].padStart(2, '0')}`;
    }
  }
  if (!iso) return null;

  const year = parseInt(iso.slice(0, 4));
  const nowYear = now.getFullYear();
  if (year < nowYear - 2 || year > nowYear + 3) return null;
  return iso;
}

/**
 * Następny dzień roboczy po `iso` (pomija sobotę/niedzielę; święta GPW nieobsługiwane —
 * patrz komentarz na górze pliku). Używane do przeliczenia biznesradarowego
 * "ostatnie notowanie z prawem" na ex-date.
 */
export function nextTradingDayApprox(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().split('T')[0];
}

// ── Parsery (czyste funkcje, bez I/O) ───────────────────────────────────────

function parseCommaDecimal(text: string): number | null {
  const m = text
    .replace(/\s+/g, ' ')
    .trim()
    .match(/^(\d+(?:,\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

const STATUS_VALUES: GpwDividendStatus[] = ['proponowana', 'uchwalona', 'wypłacona'];

function normalizeStatus(text: string): GpwDividendStatus | null {
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (t === 'rekomendowana') return 'proponowana';
  return STATUS_VALUES.find((s) => s === t) ?? null;
}

/**
 * stockwatch.pl/dywidendy — `table#DividendsTab`, komórki:
 * 0: skrót spółki (link), 1: za okres, 2: status + `div.stcm` z dniem wypłaty,
 * 3: kwota PLN (przecinek), 4: stopa %, 5: ustalenie prawa, 6: notowanie bez dyw. (= ex-date),
 * 7: data WZA. Wiersze niekompletne/nieparsowalne są pomijane.
 */
export function parseStockwatch(html: string, now: Date = new Date()): GpwCalendarEntry[] {
  const $ = cheerio.load(html);
  const entries: GpwCalendarEntry[] = [];

  $('#DividendsTab tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 8) return; // nagłówek (th) lub wiersz uszkodzony

    const shortName = $(cells[0]).text().trim().toUpperCase();
    if (!shortName) return;

    const statusCell = $(cells[2]);
    const payDate = parsePolishDate(statusCell.find('.stcm').text(), now);
    const statusText = statusCell.clone().find('.stcm, .bubbly').remove().end().text();
    const status = normalizeStatus(statusText);

    const amountPln = parseCommaDecimal($(cells[3]).text());
    if (amountPln === null) return;

    const yieldMatch = $(cells[4])
      .text()
      .trim()
      .match(/^(\d+(?:,\d+)?)\s*%$/);
    const yieldPct = yieldMatch ? parseFloat(yieldMatch[1].replace(',', '.')) : null;

    const exDate = parsePolishDate($(cells[6]).text(), now);

    entries.push({
      ticker: null,
      shortName,
      amountPln,
      exDate,
      payDate,
      status,
      yieldPct,
      source: 'stockwatch',
    });
  });

  return entries;
}

/**
 * biznesradar.pl/dywidendy (GPW i NewConnect — identyczny markup) — wiersze pierwszej
 * `.table` z linkiem `a[href^="/dywidenda/"]` w pierwszej komórce:
 * 0: `TICKER (SKRÓT)` (czasem sam ticker bez nawiasów, np. MOL), 1: rok, 2: data WZA,
 * 3: ostatnie notowanie z prawem (`13 lip 26` | `bd.`), 4: dzień wypłaty, 5: kwota `4,50 PLN`,
 * 6: stopa (premium, ignorowana), 7: status (`rekomendowana`/`uchwalona`/`wypłacona`/pusty).
 */
export function parseBiznesradar(html: string, now: Date = new Date()): GpwCalendarEntry[] {
  const $ = cheerio.load(html);
  const entries: GpwCalendarEntry[] = [];

  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 8) return;
    const link = $(cells[0]).find('a[href^="/dywidenda/"]');
    if (link.length === 0) return;

    const linkText = link.text().replace(/\s+/g, ' ').trim();
    const m = linkText.match(/^(\S+)\s*\((.+)\)$/);
    const ticker = (m ? m[1] : linkText).toUpperCase();
    const shortName = (m ? m[2] : linkText).trim().toUpperCase();
    if (!ticker) return;

    const amountPln = parseCommaDecimal($(cells[5]).text());
    if (amountPln === null) return;

    const lastWithRight = parsePolishDate($(cells[3]).text(), now);
    const exDate = lastWithRight ? nextTradingDayApprox(lastWithRight) : null;
    const payDate = parsePolishDate($(cells[4]).text(), now);
    const status = normalizeStatus($(cells[7]).text());

    entries.push({
      ticker,
      shortName,
      amountPln,
      exDate,
      payDate,
      status,
      yieldPct: null,
      source: 'biznesradar',
    });
  });

  return entries;
}

/**
 * Łączy oba źródła po skrócie GPW. Gdy spółka występuje w obu: kwota/ex-date/status/stopa
 * ze stockwatch (autorytatywne — zweryfikowany realny konflikt VOXEL, gdzie biznesradar
 * podawał zaszumione "z prawem"), ticker z biznesradar, dzień wypłaty = stockwatch ?? biznesradar.
 * Rozbieżność kwot → zostaje stockwatch + console.warn. Wiersze jednoźródłowe przechodzą bez zmian.
 */
export function mergeCalendars(
  stockwatch: GpwCalendarEntry[],
  biznesradar: GpwCalendarEntry[],
): GpwCalendarEntry[] {
  const bySkrot = new Map<string, GpwCalendarEntry>();
  for (const entry of biznesradar) {
    bySkrot.set(entry.shortName, entry);
  }

  const merged: GpwCalendarEntry[] = [];
  for (const sw of stockwatch) {
    const br = bySkrot.get(sw.shortName);
    if (!br) {
      merged.push(sw);
      continue;
    }
    bySkrot.delete(sw.shortName);
    // Preferencja stockwatch — ale zerowa/ujemna kwota to brak danych, nie
    // autorytatywna wartość (realny przypadek: MOL — stockwatch 0, biznesradar 3.27).
    const amountPln = sw.amountPln > 0 ? sw.amountPln : br.amountPln;
    if (sw.amountPln > 0 && Math.abs(sw.amountPln - br.amountPln) > 0.001) {
      console.warn(
        `[gpw-dividend-calendar] Rozbieżność kwoty dla ${sw.shortName}: ` +
          `stockwatch ${sw.amountPln} vs biznesradar ${br.amountPln} — zostaje stockwatch`,
      );
    }
    merged.push({
      ticker: br.ticker,
      shortName: sw.shortName,
      amountPln,
      exDate: sw.exDate,
      payDate: sw.payDate ?? br.payDate,
      status: sw.status,
      yieldPct: sw.yieldPct,
      source: 'merged',
    });
  }
  for (const br of bySkrot.values()) {
    merged.push(br);
  }
  return merged;
}

/**
 * Mapuje wpis kalendarza na UpcomingDividend dla pozycji portfela.
 * Zwraca null gdy nic nie jest "w toku": uwzględniamy wpis, gdy ex-date jest dziś/później
 * LUB wypłata jeszcze nie nastąpiła (payDate >= today przy minionym/nieznanym ex-date).
 * Wpisy `wypłacona` z minionymi datami odpadają właśnie na tym warunku.
 */
export function upcomingFromCalendarEntry(
  entry: GpwCalendarEntry,
  pos: { ticker: string; paperName: string; shares: number },
  today: string,
): UpcomingDividend | null {
  const isUpcoming = entry.exDate !== null && entry.exDate >= today;
  const isPendingPayment =
    entry.payDate !== null &&
    entry.payDate >= today &&
    (entry.exDate === null || entry.exDate < today);
  if (!isUpcoming && !isPendingPayment) return null;

  return {
    ticker: pos.ticker,
    name: pos.paperName,
    // exDate null zdarza się tylko w gałęzi isPendingPayment (wtedy payDate != null).
    exDividendDate: entry.exDate ?? entry.payDate!,
    paymentDate: entry.payDate,
    estimatedAmount: Math.round(entry.amountPln * pos.shares * 100) / 100,
    currency: 'PLN',
    shares: pos.shares,
    dividendPerShare: entry.amountPln,
    dividendYield: entry.yieldPct,
    status: entry.status ?? undefined,
    source: 'gpw-calendar',
  };
}

// ── Serwis: persystencja + odświeżanie ──────────────────────────────────────

const STOCKWATCH_URL = 'https://www.stockwatch.pl/dywidendy';
const BIZNESRADAR_GPW_URL = 'https://www.biznesradar.pl/dywidendy/';
const BIZNESRADAR_NC_URL = 'https://www.biznesradar.pl/dywidendy/newconnect';

// Ten sam UA co server/scripts/scrape-gpw-sectors.ts.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // ≤1×/24h
const RETRY_INTERVAL_MS = 60 * 60 * 1000; // po totalnej awarii: ponów najwcześniej po 1h

export interface GpwCalendarMaps {
  byTicker: Map<string, GpwCalendarEntry>;
  byShortName: Map<string, GpwCalendarEntry>;
}

export interface GpwDividendCalendarServiceOptions {
  fetchFn?: typeof fetch;
  dbFile?: string;
  now?: () => Date;
  /** Przerwa między requestami (default 1000 ms; testy podają 0). */
  politenessDelayMs?: number;
}

export interface GpwDividendCalendarService {
  getCalendar(): Promise<GpwCalendarMaps>;
  close(): void;
}

interface CalendarRow {
  short_name: string;
  ticker: string | null;
  amount_pln: number;
  ex_date: string | null;
  pay_date: string | null;
  status: string | null;
  yield_pct: number | null;
  source: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGpwDividendCalendarService(
  options: GpwDividendCalendarServiceOptions = {},
): GpwDividendCalendarService {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const politenessDelayMs = options.politenessDelayMs ?? 1000;
  const dbFile = options.dbFile ?? path.join(config.dataDir, 'price_history.db');

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
      db.exec(`
        CREATE TABLE IF NOT EXISTS gpw_dividend_calendar (
          short_name TEXT PRIMARY KEY,
          ticker TEXT,
          amount_pln REAL NOT NULL,
          ex_date TEXT,
          pay_date TEXT,
          status TEXT,
          yield_pct REAL,
          source TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS gpw_dividend_fetch_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }
    return db;
  }

  function getStateMs(key: string): number | null {
    const row = getDb()
      .prepare('SELECT value FROM gpw_dividend_fetch_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    if (!row) return null;
    const ms = Date.parse(row.value);
    return Number.isFinite(ms) ? ms : null;
  }

  function setState(key: string, isoTimestamp: string): void {
    getDb()
      .prepare('INSERT OR REPLACE INTO gpw_dividend_fetch_state (key, value) VALUES (?, ?)')
      .run(key, isoTimestamp);
  }

  async function fetchPage(url: string): Promise<string> {
    const resp = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return await resp.text();
  }

  async function fetchSource(
    url: string,
    parser: (html: string, now: Date) => GpwCalendarEntry[],
  ): Promise<GpwCalendarEntry[]> {
    try {
      const html = await fetchPage(url);
      return parser(html, now());
    } catch (err) {
      console.warn(`[gpw-dividend-calendar] Nie udało się pobrać ${url}:`, err);
      return [];
    }
  }

  /** Sekwencyjne pobranie 3 stron z przerwami; partial-merge gdy któreś źródło padnie. */
  async function doRefresh(): Promise<void> {
    setState('last_attempt', now().toISOString());

    const stockwatchEntries = await fetchSource(STOCKWATCH_URL, parseStockwatch);
    await sleep(politenessDelayMs);
    const brGpw = await fetchSource(BIZNESRADAR_GPW_URL, parseBiznesradar);
    await sleep(politenessDelayMs);
    const brNc = await fetchSource(BIZNESRADAR_NC_URL, parseBiznesradar);
    const biznesradarEntries = [...brGpw, ...brNc];

    if (stockwatchEntries.length === 0 && biznesradarEntries.length === 0) {
      // Totalna awaria — zostają stare wiersze; last_attempt już ustawione, więc kolejna
      // próba nastąpi najwcześniej za RETRY_INTERVAL_MS.
      console.warn(
        '[gpw-dividend-calendar] Wszystkie źródła zawiodły — serwuję poprzednie dane (retry ≥1h)',
      );
      return;
    }

    const merged = mergeCalendars(stockwatchEntries, biznesradarEntries);
    const database = getDb();
    const fetchedAt = now().toISOString();
    const insert = database.prepare(
      `INSERT OR REPLACE INTO gpw_dividend_calendar
         (short_name, ticker, amount_pln, ex_date, pay_date, status, yield_pct, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      database.prepare('DELETE FROM gpw_dividend_calendar').run();
      for (const e of merged) {
        insert.run(
          e.shortName,
          e.ticker,
          e.amountPln,
          e.exDate,
          e.payDate,
          e.status,
          e.yieldPct,
          e.source,
          fetchedAt,
        );
      }
    })();
    setState('last_success', fetchedAt);
  }

  function refresh(): Promise<void> {
    if (!inFlightRefresh) {
      inFlightRefresh = doRefresh().finally(() => {
        inFlightRefresh = null;
      });
    }
    return inFlightRefresh;
  }

  function loadMaps(): GpwCalendarMaps {
    const rows = getDb()
      .prepare(
        `SELECT short_name, ticker, amount_pln, ex_date, pay_date, status, yield_pct, source
         FROM gpw_dividend_calendar`,
      )
      .all() as CalendarRow[];

    const byTicker = new Map<string, GpwCalendarEntry>();
    const byShortName = new Map<string, GpwCalendarEntry>();
    for (const row of rows) {
      const entry: GpwCalendarEntry = {
        ticker: row.ticker,
        shortName: row.short_name,
        amountPln: row.amount_pln,
        exDate: row.ex_date,
        payDate: row.pay_date,
        status: (row.status as GpwDividendStatus | null) ?? null,
        yieldPct: row.yield_pct,
        source: row.source as GpwCalendarEntry['source'],
      };
      byShortName.set(entry.shortName, entry);
      if (entry.ticker) byTicker.set(entry.ticker, entry);
    }
    return { byTicker, byShortName };
  }

  return {
    async getCalendar(): Promise<GpwCalendarMaps> {
      const nowMs = now().getTime();
      const lastSuccess = getStateMs('last_success');
      const lastAttempt = getStateMs('last_attempt');

      const isStale = lastSuccess === null || nowMs - lastSuccess > REFRESH_INTERVAL_MS;
      const canAttempt = lastAttempt === null || nowMs - lastAttempt > RETRY_INTERVAL_MS;

      if (isStale && canAttempt) {
        await refresh();
      }
      return loadMaps();
    },
    close(): void {
      db?.close();
      db = null;
    },
  };
}

// ── Domyślna instancja (singleton) używana przez endpoint ──────────────────

let defaultService: GpwDividendCalendarService | null = null;

export function getGpwDividendCalendarService(): GpwDividendCalendarService {
  if (!defaultService) {
    defaultService = createGpwDividendCalendarService();
  }
  return defaultService;
}
