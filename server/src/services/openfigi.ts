/**
 * OpenFIGI (Bloomberg) jako źródło ISIN → ticker, NIEZALEŻNE OD NAZW.
 *
 * GENEZA (zgłoszenie 2026-11-05, Bossa „Taiwan Semi.Manufa.Ltd ADR"): wyszukiwarka
 * Yahoo nie indeksuje części ISIN-ów (`US8740391003` → `[]`), więc resolver spadał
 * do szukania po NAZWIE z pliku brokera, a ta bywa skrócona w sposób, którego
 * żadna heurystyka nie przewidzi. OpenFIGI mapuje ISIN wprost na listingi
 * (`exchCode` + `ticker`) — `US8740391003` → `US / TSM`, `US60744M1062` → `US / MBGL`.
 *
 * Wynik stąd jest KANDYDATEM, nie rozpoznaniem: resolver potwierdza go
 * `fetchYahooSymbolInfo` (dokładna zgodność symbolu) i dopiero wtedy pyta o cenę —
 * cena z chartu nie dowodzi, że symbol istnieje (patrz CLAUDE.md, `SMSN.L`).
 *
 * Prywatność: wysyłamy WYŁĄCZNIE ISIN (identyfikator papieru, nie dana osobowa) —
 * bez ilości, kwot ani nazw z pliku.
 *
 * Limity bez klucza (zmierzone 2026-11-06, nagłówek `ratelimit-policy: 25;w=60`):
 * 25 zapytań/min, do 10 zadań w zapytaniu. Opcjonalny `OPENFIGI_API_KEY` podnosi limit.
 * Wyłącznik: `OPENFIGI=off` (ustawiony w konfiguracji vitest — testy resolvera nie
 * mogą uderzać do sieci).
 */

import path from 'path';
import { config } from '../config.js';
import {
  createSourceGuard,
  createSqliteGuardStore,
  type GuardStateStore,
  type SourceGuard,
} from './source-guard.js';

const OPENFIGI_URL = 'https://api.openfigi.com/v3/mapping';
/** Max zadań w jednym zapytaniu bez klucza API. */
export const OPENFIGI_MAX_JOBS = 10;
const REQUEST_TIMEOUT_MS = 8_000;
const BUDGET_WINDOW_MS = 60_000;
/** Zapas pod limitem 25/min (inne procesy z tego IP, zegar serwera ≠ zegar OpenFIGI). */
const BUDGET_NO_KEY = 20;
/** Z kluczem limit to 25 zapytań / 6 s. */
const BUDGET_WITH_KEY = 200;
const CACHE_TTL_FOUND_MS = 24 * 60 * 60 * 1000;
/** „No identifier found" też zapamiętujemy — samoleczenie ponawia te same ISIN-y. */
const CACHE_TTL_NOT_FOUND_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5_000;

/** Jeden listing z odpowiedzi OpenFIGI (pola, których używamy). */
export interface FigiListing {
  ticker: string;
  exchCode: string;
  name: string;
  securityType?: string;
  marketSector?: string;
}

/** Kandydat na symbol Yahoo — do POTWIERDZENIA przez resolver. */
export interface FigiCandidate {
  /** Symbol w zapisie Yahoo (`TSM`, `BRK-B`, `SAP.DE`). */
  symbol: string;
  exchCode: string;
  /** Nazwa z OpenFIGI (wielkie litery, skróty Bloomberga) — tylko diagnostyka. */
  name: string;
  /** Listing na giełdzie macierzystej emitenta (kraj z prefiksu ISIN-u). */
  home: boolean;
}

/**
 * `exchCode` OpenFIGI → sufiks Yahoo + waluta notowania na tej giełdzie.
 *
 * TYLKO giełdy, gdzie przejście jest jednoznaczne — sprawdzone na żywo 2026-11-06
 * parą OpenFIGI → wyszukiwarka Yahoo (SAP → SAP.DE, ASML → ASML.AS, MC → MC.PA,
 * NESN → NESN.SW, ENEL → ENEL.MI, IBE → IBE.MC, ABI → ABI.BR, EBS → EBS.VI,
 * NOKIA → NOKIA.HE, EQNR → EQNR.OL, 7203 → 7203.T, BHP → BHP.AX).
 *
 * ŚWIADOMIE POMINIĘTE:
 *  - `LN`/`LI` (Londyn) — dwie linie notowań (`.L` vs `.IL`) i kilka walut jednego
 *    ETF-u (`CSPX` USD obok `CSP1`), więc kod giełdy nie wyznacza listingu;
 *  - `DC`/`SS` (Kopenhaga, Sztokholm) — inny zapis klasy akcji (`NOVOB` vs Yahoo
 *    `NOVO-B.CO`, `ERICB` vs `ERIC-B.ST`);
 *  - `CN`/`CT` (Kanada) — kompozyt vs TSX/TSXV, niezmierzone;
 *  - `PW` (Warszawa) — gałąź polska ma własny łańcuch (katalog BR) i tu jej nie ruszamy;
 *  - kompozyty niemieckie (`GR`, `GF`…) i europejskie MTF-y (`EO`, `X*`) — tickery
 *    w zapisie Bloomberga (`TSM1EUR`), których Yahoo nie zna.
 */
export const FIGI_EXCHANGES: Record<string, { suffix: string; currency: string }> = {
  US: { suffix: '', currency: 'USD' },
  GY: { suffix: '.DE', currency: 'EUR' },
  NA: { suffix: '.AS', currency: 'EUR' },
  FP: { suffix: '.PA', currency: 'EUR' },
  SW: { suffix: '.SW', currency: 'CHF' },
  IM: { suffix: '.MI', currency: 'EUR' },
  SM: { suffix: '.MC', currency: 'EUR' },
  BB: { suffix: '.BR', currency: 'EUR' },
  AV: { suffix: '.VI', currency: 'EUR' },
  FH: { suffix: '.HE', currency: 'EUR' },
  NO: { suffix: '.OL', currency: 'NOK' },
  JT: { suffix: '.T', currency: 'JPY' },
  AT: { suffix: '.AX', currency: 'AUD' },
};

/** Kraj z prefiksu ISIN-u → giełda macierzysta (tylko kraje z `FIGI_EXCHANGES`). */
const HOME_EXCHANGE_BY_COUNTRY: Record<string, string> = {
  US: 'US',
  DE: 'GY',
  NL: 'NA',
  FR: 'FP',
  CH: 'SW',
  IT: 'IM',
  ES: 'SM',
  BE: 'BB',
  AT: 'AV',
  FI: 'FH',
  NO: 'NO',
  JP: 'JT',
  AU: 'AT',
};

/** Ile kandydatów przekazujemy do potwierdzenia (każdy = zapytania do Yahoo). */
const MAX_CANDIDATES = 2;

/** Ticker Bloomberga w zapisie Yahoo; `null` = zapis, którego nie umiemy przenieść. */
function toYahooSymbol(ticker: string, exchCode: string): string | null {
  const t = ticker.trim().toUpperCase();
  // `MBGL*` (Meksyk), spacje, egzotyczne znaki — nie zgadujemy.
  if (!/^[A-Z0-9][A-Z0-9./]*$/.test(t)) return null;
  const ex = FIGI_EXCHANGES[exchCode];
  if (!ex) return null;
  if (exchCode === 'US') {
    // Klasa akcji: Bloomberg `BRK/B`, Yahoo `BRK-B` (zmierzone na żywo).
    return t.replace('/', '-');
  }
  // Poza USA zapis klasy akcji nie jest zmierzony — nie zgadujemy.
  if (t.includes('/')) return null;
  return `${t}${ex.suffix}`;
}

/**
 * Czysty wybór kandydatów z listingów OpenFIGI.
 *
 * Bierzemy pod uwagę giełdę macierzystą emitenta (kraj z ISIN-u) oraz — wyłącznie
 * przy transakcji w USD — linię amerykańską (ADR/OTC, którą handluje np. IBKR).
 * Pozostałe cross-listingi odpadają, choćby były w walucie transakcji: dla SAP-a
 * w EUR żywa odpowiedź zawiera też `IM 1SAP` (segment zagraniczny Borsa Italiana)
 * i `AV SAP` (Wiedeń) — ten sam emitent, ale drugorzędna linia notowań, a `SAPGF`
 * (OTC w USD) przy zakupie w EUR to cudza waluta. Kolejność: macierzysta w walucie
 * transakcji → macierzysta → US przy transakcji w USD.
 *
 * Kod giełdy z KILKOMA różnymi tickerami (`SW`: `SAP` obok `SAPEUR`) jest
 * niejednoznaczny i odpada w całości.
 */
export function selectFigiCandidates(
  isin: string,
  listings: FigiListing[],
  txCurrency: string,
): FigiCandidate[] {
  const home = HOME_EXCHANGE_BY_COUNTRY[isin.slice(0, 2).toUpperCase()];
  const currency = (txCurrency || '').toUpperCase();

  const tickersByExch = new Map<string, Set<string>>();
  const nameByExch = new Map<string, string>();
  for (const l of listings) {
    if (!l?.exchCode || !l?.ticker || !FIGI_EXCHANGES[l.exchCode]) continue;
    const set = tickersByExch.get(l.exchCode) ?? new Set<string>();
    set.add(l.ticker.trim().toUpperCase());
    tickersByExch.set(l.exchCode, set);
    if (!nameByExch.has(l.exchCode)) nameByExch.set(l.exchCode, l.name ?? '');
  }

  const ranked: Array<FigiCandidate & { rank: number; order: number }> = [];
  let order = 0;
  for (const [exchCode, tickers] of tickersByExch) {
    order += 1;
    if (tickers.size !== 1) continue;
    const symbol = toYahooSymbol([...tickers][0], exchCode);
    if (!symbol) continue;
    const isHome = exchCode === home;
    const currencyMatch = FIGI_EXCHANGES[exchCode].currency === currency;
    if (!isHome && !(exchCode === 'US' && currencyMatch)) continue;
    const rank = isHome && currencyMatch ? 0 : isHome ? 1 : 2;
    ranked.push({
      symbol,
      exchCode,
      name: nameByExch.get(exchCode) ?? '',
      home: isHome,
      rank,
      order,
    });
  }

  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_CANDIDATES)
    .map(({ symbol, exchCode, name, home: h }) => ({ symbol, exchCode, name, home: h }));
}

/**
 * Wynik parsowania odpowiedzi: mapa ISIN → listingi (`[]` = OpenFIGI nie zna
 * identyfikatora). `null` = koperta nierozpoznana (zmiana API).
 */
export function parseFigiMappingResponse(
  json: unknown,
  isins: string[],
): Map<string, FigiListing[]> | null {
  if (!Array.isArray(json) || json.length !== isins.length) return null;
  const out = new Map<string, FigiListing[]>();
  for (let i = 0; i < isins.length; i++) {
    const job = json[i] as { data?: unknown; warning?: unknown; error?: unknown } | null;
    if (!job || typeof job !== 'object') return null;
    if (Array.isArray(job.data)) {
      out.set(
        isins[i],
        job.data
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .filter((r) => typeof r.ticker === 'string' && typeof r.exchCode === 'string')
          .map((r) => ({
            ticker: r.ticker as string,
            exchCode: r.exchCode as string,
            name: typeof r.name === 'string' ? r.name : '',
            securityType: typeof r.securityType === 'string' ? r.securityType : undefined,
            marketSector: typeof r.marketSector === 'string' ? r.marketSector : undefined,
          })),
      );
    } else if (typeof job.warning === 'string') {
      // „No identifier found." — znany brak, nie błąd.
      out.set(isins[i], []);
    } else if (typeof job.error === 'string') {
      // Błąd pojedynczego zadania (np. nieprawidłowy identyfikator) — bez wyniku
      // dla tego ISIN-u, reszta zapytania jest ważna.
      continue;
    } else {
      return null;
    }
  }
  return out;
}

// ── Stan procesu: guard, budżet, cache ──────────────────────────────────────

interface Deps {
  fetch: typeof fetch;
  now: () => number;
  guard: SourceGuard | null;
}

const deps: Deps = { fetch: (...a) => fetch(...a), now: () => Date.now(), guard: null };
let defaultGuard: SourceGuard | null = null;
const requestTimes: number[] = [];
const cache = new Map<string, { listings: FigiListing[]; expiresAt: number }>();

/**
 * Guard źródła. 429/403/503 otwierają bezpiecznik (po 3 pod rząd, backoff 30 min),
 * ale BEZ maila do admina: OpenFIGI jest źródłem pomocniczym — jego niedostępność
 * oznacza tylko powrót do szukania po nazwie, a stan i tak widać w `/api/health`.
 */
export function createOpenFigiGuard(
  opts: { store?: GuardStateStore; now?: () => number } = {},
): SourceGuard {
  // Celowo BEZ `notify` — patrz komentarz wyżej.
  return createSourceGuard({ name: 'openfigi', store: opts.store, now: opts.now });
}

export function getOpenFigiGuard(): SourceGuard {
  if (deps.guard) return deps.guard;
  if (!defaultGuard) {
    defaultGuard = createOpenFigiGuard({
      store: createSqliteGuardStore('openfigi', path.join(config.dataDir, 'price_history.db')),
    });
  }
  return defaultGuard;
}

/** Testy: wstrzyknięcie fetch/zegara/guarda + wyczyszczenie cache i budżetu. */
export function setOpenFigiDepsForTests(overrides: Partial<Deps> | null): void {
  deps.fetch = overrides?.fetch ?? ((...a) => fetch(...a));
  deps.now = overrides?.now ?? (() => Date.now());
  deps.guard = overrides?.guard ?? null;
  requestTimes.length = 0;
  cache.clear();
}

function isEnabled(): boolean {
  return (process.env.OPENFIGI ?? '').toLowerCase() !== 'off';
}

/** Okno przesuwne: czy mieści się kolejne zapytanie (rezerwuje slot przy `true`). */
function takeBudgetSlot(nowMs: number): boolean {
  while (requestTimes.length && nowMs - requestTimes[0] >= BUDGET_WINDOW_MS) requestTimes.shift();
  const limit = process.env.OPENFIGI_API_KEY ? BUDGET_WITH_KEY : BUDGET_NO_KEY;
  if (requestTimes.length >= limit) return false;
  requestTimes.push(nowMs);
  return true;
}

function cacheSet(isin: string, listings: FigiListing[], nowMs: number): void {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  const ttl = listings.length > 0 ? CACHE_TTL_FOUND_MS : CACHE_TTL_NOT_FOUND_MS;
  cache.set(isin, { listings, expiresAt: nowMs + ttl });
}

/**
 * Listingi dla ISIN-ów (batch po 10). ISIN-a BRAK w wyniku = miękki miss
 * (wyłącznik, bezpiecznik, budżet, 429, timeout, błąd sieci) — wołający schodzi
 * do kolejnej strategii i NIC nie zapamiętujemy, więc samoleczenie spróbuje znowu.
 * `[]` = OpenFIGI odpowiedział, że identyfikatora nie zna.
 */
export async function lookupOpenFigi(isins: string[]): Promise<Map<string, FigiListing[]>> {
  const result = new Map<string, FigiListing[]>();
  if (!isEnabled()) return result;

  const nowMs = deps.now();
  const pending: string[] = [];
  for (const raw of isins) {
    const isin = raw.trim().toUpperCase();
    const hit = cache.get(isin);
    if (hit && hit.expiresAt > nowMs) result.set(isin, hit.listings);
    else if (!pending.includes(isin)) pending.push(isin);
  }

  const guard = getOpenFigiGuard();
  for (let i = 0; i < pending.length; i += OPENFIGI_MAX_JOBS) {
    const chunk = pending.slice(i, i + OPENFIGI_MAX_JOBS);
    if (guard.isBlocked() || !takeBudgetSlot(deps.now())) break;

    let resp: Response;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.OPENFIGI_API_KEY) headers['X-OPENFIGI-APIKEY'] = process.env.OPENFIGI_API_KEY;
      resp = await deps.fetch(OPENFIGI_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(chunk.map((idValue) => ({ idType: 'ID_ISIN', idValue }))),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout / sieć — miękki miss, bez wpływu na bezpiecznik.
      console.warn(`[openfigi] zapytanie nieudane (${(err as Error)?.name ?? 'error'}) — pomijam`);
      continue;
    }

    if (resp.status === 429 || resp.status === 403 || resp.status === 503) {
      guard.registerBlock();
      console.warn(`[openfigi] HTTP ${resp.status} — miękki miss, resolver idzie dalej`);
      break;
    }
    if (!resp.ok) {
      console.warn(`[openfigi] HTTP ${resp.status} — miękki miss`);
      continue;
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch {
      guard.registerParseMiss('mapping', { structural: true });
      continue;
    }
    const parsed = parseFigiMappingResponse(json, chunk);
    if (!parsed) {
      guard.registerParseMiss('mapping', { structural: true });
      continue;
    }
    guard.registerSuccess('mapping');
    const at = deps.now();
    for (const [isin, listings] of parsed) {
      cacheSet(isin, listings, at);
      result.set(isin, listings);
    }
  }
  return result;
}

/** Kandydaci na symbol Yahoo dla jednego ISIN-u (pusta lista = brak / miękki miss). */
export async function findOpenFigiCandidates(
  isin: string,
  txCurrency: string,
): Promise<FigiCandidate[]> {
  const key = isin.trim().toUpperCase();
  const listings = (await lookupOpenFigi([key])).get(key);
  if (!listings || listings.length === 0) return [];
  return selectFigiCandidates(key, listings, txCurrency);
}
