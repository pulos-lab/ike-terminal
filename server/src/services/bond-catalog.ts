/**
 * Katalog obligacji dogrywanych ON-DEMAND (Etap 2 #167).
 *
 * Statyczny `BOND_MAP` (+ ręczne overrides) nie zawiera obligacji, których scraper nigdy
 * nie widział (wykupione/nienotowane w oknie przebiegu). Zamiast czekać na release, podczas
 * importu wykrywamy kody obligacji Catalyst spoza mapy, pobieramy ich detal z obligacje.pl
 * i zapisujemy w tabeli `bonds` w `price_history.db` (globalna, runtime-writable) oraz
 * rejestrujemy w warstwie runtime `bond-map` — bez deployu.
 *
 * Kolejność klasyfikacji: statyczny BOND_MAP/overrides → rejestr runtime (ta tabela) →
 * (dla nominału) inferBondNominal. Miss-cache chroni przed ponawianiem fetchy dla tokenów,
 * które nie są obligacjami.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { registerExtraBonds, isBondInstrument, findBondByTicker, type BondMapEntry } from 'shared';
import { fetchBondDetail, CATALYST_TICKER_RE } from './bond-detail.js';

/** Miss (token nie jest obligacją / brak strony) nie jest re-fetchowany przez 30 dni. */
const MISS_TTL_MS = 30 * 24 * 3600 * 1000;
/** Twardy limit fetchy obligacji na jeden import (ochrona przed patologicznym plikiem). */
const MAX_CANDIDATES_PER_IMPORT = 25;
const RESOLVE_CONCURRENCY = 3;

export interface BondCatalogOptions {
  dbFile?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export interface BondCatalog {
  /** Rozwiąż pojedynczy kod: DB → detal on-demand → upsert + rejestracja. null gdy nie-obligacja. */
  resolveBondOnDemand(ticker: string): Promise<BondMapEntry | null>;
  /** Wykryj kody obligacji spoza mapy w treści importu i rozwiąż je. Zwraca liczbę dograń. */
  resolveBondCandidatesFromContent(contents: string[]): Promise<number>;
  /** Załaduj zapisane obligacje do rejestru runtime (start serwera). Zwraca liczbę wpisów. */
  loadStoredBondsIntoRegistry(): number;
  getStoredBonds(): BondMapEntry[];
}

/**
 * Wyłuskaj z treści importu kandydatów na obligacje Catalyst: tokeny w kształcie kodu
 * (2-4 wielkie litery + 4 cyfry), których statyczna mapa/rejestr NIE zna. Czyste, testowalne.
 */
export function extractBondCandidates(...contents: string[]): string[] {
  const found = new Set<string>();
  for (const content of contents) {
    if (!content) continue;
    for (const token of content.split(/[^A-Za-z0-9]+/)) {
      const t = token.toUpperCase();
      if (CATALYST_TICKER_RE.test(t) && !isBondInstrument(t)) found.add(t);
    }
  }
  return [...found];
}

interface BondRow {
  ticker: string;
  isin: string | null;
  name: string | null;
  nominal: number;
  currency: string;
  maturity_date: string | null;
  segment: string;
  coupon_type: string | null;
  coupon_rate: number | null;
  series: string | null;
}

function rowToEntry(r: BondRow): BondMapEntry {
  return {
    isin: r.isin ?? '',
    ticker: r.ticker,
    name: r.name ?? r.ticker,
    nominal: r.nominal,
    currency: r.currency,
    maturityDate: r.maturity_date ?? '',
    segment: r.segment as BondMapEntry['segment'],
    ...(r.coupon_type ? { couponType: r.coupon_type as BondMapEntry['couponType'] } : {}),
    ...(r.coupon_rate != null ? { couponRate: r.coupon_rate } : {}),
    ...(r.series ? { series: r.series } : {}),
  };
}

export function createBondCatalog(options: BondCatalogOptions = {}): BondCatalog {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
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
        CREATE TABLE IF NOT EXISTS bonds (
          ticker TEXT PRIMARY KEY,
          isin TEXT,
          name TEXT,
          nominal REAL NOT NULL,
          currency TEXT NOT NULL,
          maturity_date TEXT,
          segment TEXT NOT NULL,
          coupon_type TEXT,
          coupon_rate REAL,
          series TEXT,
          source TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bond_lookup_misses (
          ticker TEXT PRIMARY KEY,
          fetched_at TEXT NOT NULL
        );
      `);
    }
    return db;
  }

  function getStoredBonds(): BondMapEntry[] {
    return (getDb().prepare('SELECT * FROM bonds').all() as BondRow[]).map(rowToEntry);
  }

  function loadStoredBondsIntoRegistry(): number {
    const bonds = getStoredBonds();
    if (bonds.length) registerExtraBonds(bonds);
    return bonds.length;
  }

  function getStored(ticker: string): BondMapEntry | null {
    const row = getDb().prepare('SELECT * FROM bonds WHERE ticker = ?').get(ticker) as
      | BondRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  function recentMiss(ticker: string): boolean {
    const row = getDb()
      .prepare('SELECT fetched_at FROM bond_lookup_misses WHERE ticker = ?')
      .get(ticker) as { fetched_at: string } | undefined;
    if (!row) return false;
    const ms = Date.parse(row.fetched_at);
    return Number.isFinite(ms) && now().getTime() - ms < MISS_TTL_MS;
  }

  function upsert(e: BondMapEntry): void {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO bonds
           (ticker, isin, name, nominal, currency, maturity_date, segment,
            coupon_type, coupon_rate, series, source, fetched_at)
         VALUES
           (@ticker, @isin, @name, @nominal, @currency, @maturity_date, @segment,
            @coupon_type, @coupon_rate, @series, @source, @fetched_at)`,
      )
      .run({
        ticker: e.ticker,
        isin: e.isin || null,
        name: e.name || null,
        nominal: e.nominal,
        currency: e.currency,
        maturity_date: e.maturityDate || null,
        segment: e.segment,
        coupon_type: e.couponType ?? null,
        coupon_rate: e.couponRate ?? null,
        series: e.series ?? null,
        source: 'obligacje.pl',
        fetched_at: now().toISOString(),
      });
  }

  function recordMiss(ticker: string): void {
    getDb()
      .prepare('INSERT OR REPLACE INTO bond_lookup_misses (ticker, fetched_at) VALUES (?, ?)')
      .run(ticker, now().toISOString());
  }

  async function resolveBondOnDemand(tickerRaw: string): Promise<BondMapEntry | null> {
    const ticker = tickerRaw.toUpperCase().trim();
    if (!CATALYST_TICKER_RE.test(ticker)) return null;
    // Już znana (statyczny BOND_MAP / rejestr) — nie fetchujemy.
    if (isBondInstrument(ticker)) return findBondByTicker(ticker);
    const stored = getStored(ticker);
    if (stored) {
      registerExtraBonds([stored]);
      return stored;
    }
    if (recentMiss(ticker)) return null;
    const detail = await fetchBondDetail(ticker, { fetchFn });
    if (!detail) {
      recordMiss(ticker);
      return null;
    }
    upsert(detail);
    registerExtraBonds([detail]);
    return detail;
  }

  async function resolveBondCandidatesFromContent(contents: string[]): Promise<number> {
    const candidates = extractBondCandidates(...contents).slice(0, MAX_CANDIDATES_PER_IMPORT);
    let resolved = 0;
    for (let i = 0; i < candidates.length; i += RESOLVE_CONCURRENCY) {
      const batch = candidates.slice(i, i + RESOLVE_CONCURRENCY);
      const results = await Promise.all(batch.map((t) => resolveBondOnDemand(t)));
      resolved += results.filter(Boolean).length;
    }
    return resolved;
  }

  return {
    resolveBondOnDemand,
    resolveBondCandidatesFromContent,
    loadStoredBondsIntoRegistry,
    getStoredBonds,
  };
}

let defaultCatalog: BondCatalog | null = null;

/** Domyślny singleton (produkcja) — `price_history.db` + globalny fetch. */
export function getBondCatalog(): BondCatalog {
  if (!defaultCatalog) defaultCatalog = createBondCatalog();
  return defaultCatalog;
}
