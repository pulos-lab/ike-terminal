/**
 * Persystencja kalendarza publikacji wyników w globalnej `price_history.db`.
 *
 * Dane nie są per-użytkownik (termin raportu CD Projektu jest ten sam dla wszystkich),
 * więc — jak `gpw_dividend_calendar` i `spinoff_events` — mieszkają w bazie współdzielonej,
 * a nie w bazach portfeli. Moduł jest czysto składowy: zero sieci, zero logiki domenowej.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../../config.js';
import type {
  EarningsConfidence,
  EarningsReportKind,
  EarningsSession,
  EarningsSource,
} from 'shared';

/** Rynek decyduje o źródle i o przestrzeni kluczy symboli — stąd jest częścią PK. */
export type EarningsMarket = 'US' | 'PL' | 'FOREIGN';

export interface EarningsRow {
  market: EarningsMarket;
  /** US: ticker Nasdaq (`AAPL`); PL: slug bankiera (`CDPROJEKT`); FOREIGN: ticker Yahoo (`ADS.DE`). */
  symbolKey: string;
  /** YYYY-MM-DD w kalendarzu rynku emitenta — bez konwersji stref (patrz UpcomingEarnings). */
  reportDate: string;
  confidence: EarningsConfidence;
  session: EarningsSession | null;
  fiscalLabel: string | null;
  reportKind: EarningsReportKind | null;
  source: EarningsSource;
  epsForecast: number | null;
}

/** Skąd wzięło się powiązanie naszego tickera ze symbolem źródła — do diagnostyki. */
export type SymbolResolvedBy =
  | 'nc-map'
  | 'ticker-is-slug'
  | 'name-is-slug'
  | 'name-index'
  | 'dividend-bridge'
  | 'sweep-name';

export interface SymbolMapping {
  symbolKey: string;
  resolvedBy: SymbolResolvedBy;
  confidence: number;
}

export interface EarningsStoreOptions {
  /** `:memory:` w testach. */
  dbFile?: string;
}

export interface EarningsStore {
  /**
   * Atomowa podmiana wierszy danego źródła w zakresie dat.
   * DELETE ograniczony do `source` + `market`, żeby zamiatanie US nie kasowało terminarza PL,
   * a przeszłość (do analizy „czy raport faktycznie wpadł") została nietknięta.
   * `toDate` domyka zakres — bez niego odświeżanie WYCINKA okna skasowałoby wszystko dalej.
   */
  replaceSource(
    source: EarningsSource,
    market: EarningsMarket,
    rows: EarningsRow[],
    opts: { fromDate: string; toDate?: string; fetchedAt: string },
  ): void;
  /**
   * Podmiana terminarza JEDNEJ spółki — dla źródeł odpytywanych per spółka (bankier),
   * gdzie kasowanie całego rynku wywaliłoby dane pozostałych spółek.
   */
  replaceSymbol(
    source: EarningsSource,
    market: EarningsMarket,
    symbolKey: string,
    rows: EarningsRow[],
    opts: { fromDate: string; fetchedAt: string },
  ): void;
  /** Wiersze o `report_date >= fromDate` dla podanych symboli, rosnąco po dacie. */
  getForSymbols(market: EarningsMarket, symbolKeys: string[], fromDate: string): EarningsRow[];
  countFrom(market: EarningsMarket, fromDate: string): number;
  getState(key: string): string | null;
  getStateMs(key: string): number | null;
  setState(key: string, value: string): void;
  getSymbolMapping(market: EarningsMarket, ticker: string): SymbolMapping | null;
  /** Wszystkie znane klucze symboli danego rynku — wejście dla odświeżania z timera. */
  getMappedSymbolKeys(market: EarningsMarket): string[];
  putSymbolMapping(
    market: EarningsMarket,
    ticker: string,
    mapping: SymbolMapping,
    verifiedAt: string,
  ): void;
  /** Sprzątanie wierszy starszych niż `beforeDate` — wołane przy okazji odświeżeń. */
  pruneBefore(beforeDate: string): void;
  /**
   * Most przez kalendarz dywidend: `gpw_dividend_calendar` (ta sama baza, inny serwis)
   * trzyma pary skrót↔ticker zebrane niezależnym scrapem. Zwraca null, gdy tabeli
   * jeszcze nie ma — kalendarz dywidend mógł nigdy nie wystartować.
   */
  lookupDividendShortName(tickerBase: string): string | null;
  close(): void;
}

interface DbRow {
  market: string;
  symbol_key: string;
  report_date: string;
  confidence: string;
  session: string | null;
  fiscal_label: string | null;
  report_kind: string | null;
  source: string;
  eps_forecast: number | null;
}

function toEarningsRow(row: DbRow): EarningsRow {
  return {
    market: row.market as EarningsMarket,
    symbolKey: row.symbol_key,
    reportDate: row.report_date,
    confidence: row.confidence as EarningsConfidence,
    session: (row.session as EarningsSession | null) ?? null,
    fiscalLabel: row.fiscal_label,
    reportKind: (row.report_kind as EarningsReportKind | null) ?? null,
    source: row.source as EarningsSource,
    epsForecast: row.eps_forecast,
  };
}

export function createEarningsStore(options: EarningsStoreOptions = {}): EarningsStore {
  const dbFile = options.dbFile ?? path.join(config.dataDir, 'price_history.db');
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
        CREATE TABLE IF NOT EXISTS earnings_calendar (
          market       TEXT NOT NULL,
          symbol_key   TEXT NOT NULL,
          report_date  TEXT NOT NULL,
          confidence   TEXT NOT NULL,
          session      TEXT,
          fiscal_label TEXT,
          report_kind  TEXT,
          source       TEXT NOT NULL,
          eps_forecast REAL,
          fetched_at   TEXT NOT NULL,
          PRIMARY KEY (market, symbol_key, report_date)
        );
        CREATE INDEX IF NOT EXISTS idx_earnings_date ON earnings_calendar(report_date);
        CREATE TABLE IF NOT EXISTS earnings_fetch_state (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS earnings_symbol_map (
          market      TEXT NOT NULL,
          ticker      TEXT NOT NULL,
          symbol_key  TEXT NOT NULL,
          resolved_by TEXT NOT NULL,
          confidence  REAL NOT NULL,
          verified_at TEXT NOT NULL,
          PRIMARY KEY (market, ticker)
        );
      `);
    }
    return db;
  }

  return {
    replaceSource(source, market, rows, opts) {
      const database = getDb();
      const insert = database.prepare(
        `INSERT OR REPLACE INTO earnings_calendar
           (market, symbol_key, report_date, confidence, session, fiscal_label,
            report_kind, source, eps_forecast, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      database.transaction(() => {
        if (opts.toDate) {
          database
            .prepare(
              'DELETE FROM earnings_calendar WHERE source = ? AND market = ? AND report_date >= ? AND report_date <= ?',
            )
            .run(source, market, opts.fromDate, opts.toDate);
        } else {
          database
            .prepare(
              'DELETE FROM earnings_calendar WHERE source = ? AND market = ? AND report_date >= ?',
            )
            .run(source, market, opts.fromDate);
        }
        for (const r of rows) {
          insert.run(
            r.market,
            r.symbolKey,
            r.reportDate,
            r.confidence,
            r.session,
            r.fiscalLabel,
            r.reportKind,
            r.source,
            r.epsForecast,
            opts.fetchedAt,
          );
        }
      })();
    },

    replaceSymbol(source, market, symbolKey, rows, opts) {
      const database = getDb();
      const key = symbolKey.toUpperCase();
      const insert = database.prepare(
        `INSERT OR REPLACE INTO earnings_calendar
           (market, symbol_key, report_date, confidence, session, fiscal_label,
            report_kind, source, eps_forecast, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      database.transaction(() => {
        database
          .prepare(
            'DELETE FROM earnings_calendar WHERE source = ? AND market = ? AND symbol_key = ? AND report_date >= ?',
          )
          .run(source, market, key, opts.fromDate);
        for (const r of rows) {
          insert.run(
            r.market,
            key,
            r.reportDate,
            r.confidence,
            r.session,
            r.fiscalLabel,
            r.reportKind,
            r.source,
            r.epsForecast,
            opts.fetchedAt,
          );
        }
      })();
    },

    getForSymbols(market, symbolKeys, fromDate) {
      if (symbolKeys.length === 0) return [];
      // SQLite ogranicza liczbę parametrów (domyślnie 32766) — porcjujemy z zapasem.
      const CHUNK = 500;
      const out: EarningsRow[] = [];
      const database = getDb();
      for (let i = 0; i < symbolKeys.length; i += CHUNK) {
        const chunk = symbolKeys.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = database
          .prepare(
            `SELECT market, symbol_key, report_date, confidence, session, fiscal_label,
                    report_kind, source, eps_forecast
             FROM earnings_calendar
             WHERE market = ? AND report_date >= ? AND symbol_key IN (${placeholders})
             ORDER BY report_date ASC`,
          )
          .all(market, fromDate, ...chunk) as DbRow[];
        out.push(...rows.map(toEarningsRow));
      }
      return out;
    },

    countFrom(market, fromDate) {
      const row = getDb()
        .prepare(
          'SELECT COUNT(*) AS n FROM earnings_calendar WHERE market = ? AND report_date >= ?',
        )
        .get(market, fromDate) as { n: number };
      return row.n;
    },

    getState(key) {
      const row = getDb()
        .prepare('SELECT value FROM earnings_fetch_state WHERE key = ?')
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },

    getStateMs(key) {
      const value = this.getState(key);
      if (!value) return null;
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    },

    setState(key, value) {
      getDb()
        .prepare('INSERT OR REPLACE INTO earnings_fetch_state (key, value) VALUES (?, ?)')
        .run(key, value);
    },

    getSymbolMapping(market, ticker) {
      const row = getDb()
        .prepare(
          'SELECT symbol_key, resolved_by, confidence FROM earnings_symbol_map WHERE market = ? AND ticker = ?',
        )
        .get(market, ticker.toUpperCase()) as
        | { symbol_key: string; resolved_by: string; confidence: number }
        | undefined;
      if (!row) return null;
      return {
        symbolKey: row.symbol_key,
        resolvedBy: row.resolved_by as SymbolResolvedBy,
        confidence: row.confidence,
      };
    },

    getMappedSymbolKeys(market) {
      const rows = getDb()
        .prepare('SELECT DISTINCT symbol_key FROM earnings_symbol_map WHERE market = ?')
        .all(market) as Array<{ symbol_key: string }>;
      return rows.map((r) => r.symbol_key);
    },

    putSymbolMapping(market, ticker, mapping, verifiedAt) {
      getDb()
        .prepare(
          `INSERT OR REPLACE INTO earnings_symbol_map
             (market, ticker, symbol_key, resolved_by, confidence, verified_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          market,
          ticker.toUpperCase(),
          mapping.symbolKey,
          mapping.resolvedBy,
          mapping.confidence,
          verifiedAt,
        );
    },

    pruneBefore(beforeDate) {
      getDb().prepare('DELETE FROM earnings_calendar WHERE report_date < ?').run(beforeDate);
    },

    lookupDividendShortName(tickerBase) {
      try {
        const row = getDb()
          .prepare('SELECT short_name FROM gpw_dividend_calendar WHERE UPPER(ticker) = ? LIMIT 1')
          .get(tickerBase.toUpperCase()) as { short_name: string } | undefined;
        return row?.short_name ?? null;
      } catch {
        return null; // tabela kalendarza dywidend jeszcze nie istnieje
      }
    },

    close() {
      db?.close();
      db = null;
    },
  };
}
