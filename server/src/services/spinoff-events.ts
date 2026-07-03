/**
 * Globalna tabela zdarzeń spin-off (`spinoff_events` w price_history.db) zasilana
 * scraperem stockanalysis.com/actions/spinoffs — szkielet 1:1 z
 * `gpw-dividend-calendar.ts`: lazy refresh ≤1×/24h za współdzielonym in-flight
 * promise, przy porażce stare wiersze zostają a retry następuje najwcześniej po 1h.
 *
 * Zasada pełnej automatyki bez ludzkiej weryfikacji ⇒ do tabeli trafiają WYŁĄCZNIE
 * wiersze z jednoznacznym ratio i tickerem rodzica (lepiej pominąć niż zmyślić) —
 * pominięcia są logowane. Dalsze guardy stoją w applierze (dziecko musi się
 * resolwować u dostawcy cen, alokacja z realnych cen z clampem, rodzic musi być
 * w portfelu na ex-date), więc nawet błędny wiersz nie wyczaruje pozycji z niczego.
 *
 * Format źródła: strona roczna stockanalysis.com/actions/spinoffs/<rok>/ z tabelą
 * [Date | Symbol | Company Name | ...tekst akcji]. Parser jest kontraktowany
 * fixture'em w testach; struktura żywej strony może dryfować — degradacja to
 * zero kandydatów (mapa statyczna działa dalej), nigdy błędne dane.
 */
import * as cheerio from 'cheerio';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import type { SpinOffMapEntry } from 'shared';

// ── Typy ────────────────────────────────────────────────────────────────────

export interface SpinoffEventRow {
  parentTicker: string;
  childTicker: string;
  childName: string | null;
  exDate: string; // YYYY-MM-DD
  ratio: number; // akcje dziecka za 1 akcję rodzica
  sourceUrl: string | null;
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

/**
 * Wyciąga ratio (akcje dziecka za 1 akcję rodzica) z tekstu opisu akcji.
 * Obsługiwane wzorce (case-insensitive):
 *  - "1 share ... for every 4 shares"  → 0.25
 *  - "ratio of 1:4" / "1-for-4"        → 0.25
 *  - "one share for each share"        → 1
 * Brak jednoznacznego wzorca → null (wiersz zostanie pominięty).
 */
export function parseSpinoffRatio(text: string): number | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ');

  // "X share(s) ... for every/each Y share(s)"
  const forEvery = t.match(
    /(\d+(?:\.\d+)?|one) shares? [^.]*?for (?:every|each) (\d+(?:\.\d+)?|one)? ?shares?/,
  );
  if (forEvery) {
    const num = forEvery[1] === 'one' ? 1 : parseFloat(forEvery[1]);
    const den = !forEvery[2] || forEvery[2] === 'one' ? 1 : parseFloat(forEvery[2]);
    if (num > 0 && den > 0) return num / den;
  }

  // "ratio of X:Y" / "X-for-Y"
  const pair = t.match(/(?:ratio of |)(\d+(?:\.\d+)?)\s*(?::|-for-)\s*(\d+(?:\.\d+)?)/);
  if (pair) {
    const num = parseFloat(pair[1]);
    const den = parseFloat(pair[2]);
    if (num > 0 && den > 0) return num / den;
  }

  return null;
}

/**
 * Wyciąga ticker rodzica z tekstu opisu ("spun off from S&P Global (SPGI)" /
 * "spun off from SPGI"). Wymagany jawny ticker (UPPERCASE 1-6 znaków, opcjonalny
 * suffix .XX) — sama nazwa spółki jest niejednoznaczna i wiersz odpada.
 */
export function parseSpinoffParentTicker(text: string): string | null {
  const m = text.match(/spun off from [^(.]*\(([A-Z0-9]{1,6}(?:\.[A-Z]{1,3})?)\)/i);
  if (m) return m[1].toUpperCase();
  const bare = text.match(/spun off from ([A-Z0-9]{1,6}(?:\.[A-Z]{1,3})?)(?:\s|,|\.|$)/);
  if (bare) return bare[1].toUpperCase();
  return null;
}

/**
 * Parsuje roczną stronę spin-offów. Szuka pierwszej tabeli z nagłówkami
 * zawierającymi "date" i "symbol"; kolumna symbolu = ticker DZIECKA (nowy walor),
 * tekst wiersza (nazwa/akcja) niesie rodzica i ratio. Wiersze bez jednoznacznego
 * (parent, ratio, date) są pomijane i zliczane w `skipped`.
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
    if (headers.some((h) => h.includes('date')) && headers.some((h) => h.includes('symbol'))) {
      table = $(el) as cheerio.Cheerio<never>;
    }
  });
  if (!table) return { events, skipped };

  const headers = ($(table) as ReturnType<typeof $>)
    .find('th')
    .map((_, th) => $(th).text().trim().toLowerCase())
    .get();
  const dateIdx = headers.findIndex((h) => h.includes('date'));
  const symbolIdx = headers.findIndex((h) => h.includes('symbol'));

  const nowYear = now.getFullYear();

  ($(table) as ReturnType<typeof $>).find('tbody tr, tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length <= Math.max(dateIdx, symbolIdx)) return; // nagłówek/uszkodzony

    const exDate = parseUsDate($(cells[dateIdx]).text());
    const childTicker = $(cells[symbolIdx]).text().trim().toUpperCase();
    const rowText = $(tr).text().replace(/\s+/g, ' ').trim();

    if (!exDate || !childTicker || !/^[A-Z0-9.]{1,10}$/.test(childTicker)) {
      skipped++;
      return;
    }
    // Okno wiarygodności dat (placeholdery/śmieci odpadają)
    const year = parseInt(exDate.slice(0, 4));
    if (year < nowYear - 2 || year > nowYear + 2) {
      skipped++;
      return;
    }

    const parentTicker = parseSpinoffParentTicker(rowText);
    const ratio = parseSpinoffRatio(rowText);
    if (!parentTicker || ratio === null) {
      skipped++; // niejednoznaczne — lepiej pominąć niż zmyślić
      return;
    }

    const childName =
      cells.length > symbolIdx + 1
        ? $(cells[symbolIdx + 1])
            .text()
            .trim() || null
        : null;

    events.push({
      parentTicker,
      childTicker,
      childName,
      exDate,
      ratio,
      sourceUrl: null,
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

export interface SpinoffEventsServiceOptions {
  fetchFn?: typeof fetch;
  dbFile?: string;
  now?: () => Date;
}

export interface SpinoffEventsService {
  /** Zwraca zdarzenia jako wpisy kandydatów appliera (source='table'). */
  getEvents(): Promise<SpinOffMapEntry[]>;
  close(): void;
}

interface EventDbRow {
  parent_ticker: string;
  child_ticker: string;
  child_name: string | null;
  ex_date: string;
  ratio: number;
  source_url: string | null;
}

export function createSpinoffEventsService(
  options: SpinoffEventsServiceOptions = {},
): SpinoffEventsService {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
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
        CREATE TABLE IF NOT EXISTS spinoff_events (
          parent_ticker TEXT NOT NULL,
          child_ticker TEXT NOT NULL,
          child_name TEXT,
          ex_date TEXT NOT NULL,
          ratio REAL NOT NULL,
          source_url TEXT,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (parent_ticker, ex_date)
        );
        CREATE TABLE IF NOT EXISTS spinoff_events_fetch_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
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
          `[spinoff-events] ${url}: ${events.length} zdarzeń, ${parsed.skipped} wierszy ` +
            `pominiętych (brak jednoznacznego rodzica/ratio — celowo nie zgadujemy)`,
        );
      }
    } catch (err) {
      // Stare wiersze zostają; last_attempt już ustawione → retry ≥1h.
      console.warn(`[spinoff-events] Nie udało się pobrać ${url}:`, err);
      return;
    }

    // Merge (INSERT OR REPLACE) zamiast delete-all: zdarzenia z poprzedniego roku
    // pozostają dostępne na przełomie lat; okno wiarygodności filtruje przy odczycie.
    const database = getDb();
    const fetchedAt = now().toISOString();
    const insert = database.prepare(
      `INSERT OR REPLACE INTO spinoff_events
         (parent_ticker, child_ticker, child_name, ex_date, ratio, source_url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (const e of events) {
        insert.run(
          e.parentTicker,
          e.childTicker,
          e.childName,
          e.exDate,
          e.ratio,
          e.sourceUrl ?? `${SPINOFFS_URL_BASE}/${year}/`,
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

  function loadEvents(): SpinOffMapEntry[] {
    const rows = getDb()
      .prepare(
        `SELECT parent_ticker, child_ticker, child_name, ex_date, ratio, source_url
         FROM spinoff_events`,
      )
      .all() as EventDbRow[];
    return rows.map((r) => ({
      parentTicker: r.parent_ticker,
      childTicker: r.child_ticker,
      childName: r.child_name ?? undefined,
      exDate: r.ex_date,
      ratio: r.ratio,
      source: r.source_url ?? undefined,
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
      return loadEvents();
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
