/**
 * Zbiorcze pobieranie cen live z Yahoo (`/v7/finance/quote?symbols=…`).
 *
 * Problem: każda cena live to był osobny request `/v8/finance/chart/{TICKER}`,
 * a pętla wyceny w portfolio-engine jest sekwencyjna — portfel z 40 pozycjami
 * na zimnym cache oznaczał 40 szeregowych round-tripów (~12 s). To wymuszało
 * długie TTL (1 h), co z kolei psuło świeżość w trakcie sesji.
 *
 * Rozwiązanie: JEDEN request na cały portfel. Dzięki temu TTL 15 min w sesji
 * kosztuje ~4 req/h zamiast dotychczasowych ~40 req/h — jednocześnie świeżej
 * i taniej.
 *
 * Kluczowa decyzja: `primeYahooQuotes` NIE zmienia silnika. Wypełnia ten sam
 * klucz cache'u (`yahoo_live_${ticker}`), z którego czyta `fetchYahooPrice`,
 * więc sekwencyjna pętla po prostu trafia w cache. Symbol, którego batch nie
 * pokrył, ląduje w `missed` i idzie starą ścieżką v8 — inny host (query1 vs
 * query2), rate-limitowany w miarę niezależnie, co jest tu zaletą.
 */

import { getCached, setCached } from './price-cache.js';
import { config } from '../config.js';
import { getYahooAuth, invalidateYahooAuth } from './yahoo-auth.js';
import { detectYahooBlock, getYahooGuard, withYahooLimit } from './yahoo-guard.js';
import { getLiveQuoteStore, type QuoteUpsert } from './live-quote-store.js';

const YAHOO_V7_BASE = 'https://query2.finance.yahoo.com/v7/finance/quote';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FETCH_TIMEOUT = 10_000;

/**
 * Ile symboli w jednym żądaniu. Yahoo deklaruje ~100, ale przy dużych listach
 * bywa, że odpowiedź jest ucinana bez błędu — 50 to margines bezpieczeństwa.
 */
const CHUNK_SIZE = 50;

/**
 * Pełny cykl stanów Yahoo dla dnia handlowego (na przykładzie USA, czas ET):
 * PREPRE (po północy do 4:00) → PRE (4:00–9:30) → REGULAR (9:30–16:00) →
 * POST (16:00–20:00) → POSTPOST (20:00–północ) → CLOSED (weekend/święto).
 *
 * `PREPRE` bywa pomijany w dokumentacji, a to najczęstszy stan amerykańskich
 * spółek w europejskie przedpołudnie — jego brak na tej liście oznaczał TTL
 * „nieznany" (1 h) zamiast długiego, czyli 6 zbędnych fal requestów na dobę.
 */
export type YahooMarketState = 'PREPRE' | 'PRE' | 'REGULAR' | 'POST' | 'POSTPOST' | 'CLOSED';

export interface YahooQuote {
  /**
   * `regularMarketPrice` — kurs sesji REGULARNEJ (po jej zamknięciu: kurs
   * zamknięcia). Handel po godzinach jest w odpowiedzi osobno
   * (`preMarketPrice`/`postMarketPrice`) i świadomie go NIE bierzemy: ma cienką
   * płynność i szerokie spready, a wartość portfela musi zgadzać się z historią
   * TWR liczoną z zamknięć. Tak samo działała ścieżka v8 przed batchem.
   */
  price: number;
  /** Surowa waluta Yahoo — 'GBp' dla Londynu zostaje, silnik już to normalizuje. */
  currency: string;
  previousClose: number | null;
  marketState: YahooMarketState | null;
  /** epoch ms z regularMarketTime; null gdy Yahoo nie podał. */
  quoteTime: number | null;
}

/** Kształt zapisywany do cache'u — NADZBIÓR tego, co czyta fetchYahooPrice. */
export interface CachedLiveQuote {
  price: number;
  currency: string;
  previousClose: number | null;
  marketState?: YahooMarketState | null;
  quoteTime?: number | null;
}

const MARKET_STATES: YahooMarketState[] = [
  'PREPRE',
  'PRE',
  'REGULAR',
  'POST',
  'POSTPOST',
  'CLOSED',
];

export function normalizeMarketState(raw: unknown): YahooMarketState | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.toUpperCase();
  return (MARKET_STATES as string[]).includes(upper) ? (upper as YahooMarketState) : null;
}

/**
 * Otwarcia rynków, o które klamrujemy TTL — KAŻDE w swojej własnej strefie.
 *
 * Nie hardkodujemy przesunięć: `Intl` liczy godzinę lokalną rynku, więc DST
 * wychodzi poprawnie samo. To istotne, bo zmiany czasu w USA i Europie NIE
 * pokrywają się (marzec: USA 2 tygodnie wcześniej, listopad: Europa tydzień
 * wcześniej) — stały offset mylił się w tych oknach o godzinę.
 *
 * Świąt świadomie nie znamy: w święto rynek i tak raportuje CLOSED, więc klamra
 * powoduje najwyżej jedno dodatkowe odpytanie, bez szkody dla danych.
 */
const MARKET_OPENS: Array<{ timeZone: string; hour: number; minute: number }> = [
  { timeZone: 'Europe/Warsaw', hour: 9, minute: 0 }, // GPW/NC (a przy okazji XETRA, Paryż)
  { timeZone: 'America/New_York', hour: 9, minute: 30 }, // NYSE/NASDAQ
];

/** Podłoga TTL — nawet tuż przed otwarciem nie odpytujemy częściej niż co 5 min. */
const MIN_CLOSED_TTL_SECONDS = 5 * 60;

/** Sekundy od północy w danej strefie (Intl zamiast offsetu serwera — prod stoi w UTC). */
function secondsOfDayIn(timeZone: string, nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 3600 + get('minute') * 60 + get('second');
}

/**
 * Ile sekund do najbliższego otwarcia któregokolwiek z obsługiwanych rynków.
 *
 * Bierzemy MINIMUM, bo portfel bywa mieszany, a jedno zbędne odpytanie (np.
 * portfel czysto amerykański budzony o 9:00 przez otwarcie GPW) kosztuje jeden
 * batch — dużo mniej niż pokazywanie wczorajszego zamknięcia po starcie sesji.
 */
function secondsUntilNextMarketOpen(nowMs: number): number {
  const candidates = MARKET_OPENS.map(({ timeZone, hour, minute }) => {
    const nowSec = secondsOfDayIn(timeZone, nowMs);
    const openSec = hour * 3600 + minute * 60;
    // Po otwarciu celujemy w otwarcie NASTĘPNEGO dnia.
    return nowSec < openSec ? openSec - nowSec : 24 * 3600 - nowSec + openSec;
  });
  return Math.min(...candidates);
}

/**
 * TTL ceny wg stanu rynku (sekundy). Czysta funkcja (zegar wstrzykiwany) —
 * sedno decyzji „jak długo cena może leżeć w cache'u".
 *
 * Poza sesją TTL jest dodatkowo KLAMROWANY do najbliższego otwarcia rynku.
 * Bez tego cena zapisana o 8:50 ze stanem CLOSED wisiałaby 6 h — przez pierwsze
 * godziny realnej sesji użytkownik patrzyłby na wczorajsze zamknięcie, czyli
 * gorzej niż przy dotychczasowej stałej godzinie.
 *
 * Klamra obejmuje też PRE/POST: `PRE` z definicji poprzedza otwarcie, więc wpis
 * powstały o 15:29 CEST żyłby do 15:59 — 29 min po starcie sesji w USA.
 */
export function quoteTtlSeconds(
  state: YahooMarketState | null,
  nowMs: number = Date.now(),
): number {
  const { quoteTtl } = config.cache;
  // Sesja trwa — otwarcie jest już za nami, klamra nie ma tu nic do roboty.
  if (state === 'REGULAR') return quoteTtl.regular;
  if (state === null) return quoteTtl.unknown;

  const base = state === 'PRE' || state === 'POST' ? quoteTtl.prePost : quoteTtl.closed;
  return Math.max(
    MIN_CLOSED_TTL_SECONDS,
    Math.min(base, quoteTtl.cap, secondsUntilNextMarketOpen(nowMs)),
  );
}

/**
 * Parsuje odpowiedź v7 na mapę symbol → notowanie. Czysta funkcja (fixture
 * zamiast sieci w testach). Pozycje bez sensownej ceny są pomijane, żeby
 * wołający zobaczył je jako `missed` i spróbował starą ścieżką.
 */
export function parseQuoteResponse(json: unknown): Map<string, YahooQuote> {
  const out = new Map<string, YahooQuote>();
  const rows = (json as any)?.quoteResponse?.result;
  if (!Array.isArray(rows)) return out;

  for (const row of rows) {
    const symbol = typeof row?.symbol === 'string' ? row.symbol : null;
    const price = row?.regularMarketPrice;
    if (!symbol || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;

    const prev = row?.regularMarketPreviousClose;
    const time = row?.regularMarketTime;
    out.set(symbol, {
      price,
      currency: typeof row?.currency === 'string' && row.currency ? row.currency : 'USD',
      previousClose: typeof prev === 'number' && Number.isFinite(prev) ? prev : null,
      marketState: normalizeMarketState(row?.marketState),
      // v7 podaje sekundy epoch; bywa też obiekt {raw}.
      quoteTime:
        typeof time === 'number' && Number.isFinite(time)
          ? time * 1000
          : typeof time?.raw === 'number'
            ? time.raw * 1000
            : null,
    });
  }
  return out;
}

/** Klucz cache'u ceny live — MUSI zgadzać się z fetchYahooPrice. */
function liveKey(ticker: string): string {
  return `yahoo_live_${ticker}`;
}

/** Migawka świeżości zestawu notowań — dla nagłówka UI i tempa odpytywania. */
export interface QuoteFreshness {
  /** ISO NAJŚWIEŻSZEGO notowania w zestawie; null gdy żadne nie podało czasu. */
  asOf: string | null;
  /** Najkrótszy TTL w zestawie (s) — tak szybko cokolwiek może się zmienić. */
  ttlSeconds: number;
  /** Czy którykolwiek rynek w zestawie jest w sesji. */
  marketOpen: boolean;
}

/**
 * Podsumowuje świeżość cen leżących w cache'u dla podanych tickerów.
 *
 * Czyta wyłącznie cache (bez sieci) — wołane już PO wycenie, więc wszystko, co
 * miało być pobrane, jest na miejscu.
 *
 * Dwie świadome decyzje:
 *  - TTL to MINIMUM zestawu: portfel z jedną pozycją w sesji ma się odświeżać
 *    w tempie tej pozycji, nie najwolniejszej.
 *  - `asOf` to MAKSIMUM (najświeższe notowanie), nie minimum. `regularMarketTime`
 *    dla instrumentów o rzadkim handlu (np. opcje) to czas ostatniej TRANSAKCJI,
 *    a nie moment pobrania danych — branie minimum pokazywałoby „Kursy z 31.07"
 *    dla portfela z aktualnymi kursami akcji, czyli mierzyłoby płynność
 *    instrumentu zamiast świeżości naszych danych.
 */
export function summarizeQuoteFreshness(tickers: string[]): QuoteFreshness {
  let newest: number | null = null;
  let ttl = config.cache.quoteTtl.closed;
  let marketOpen = false;
  let seen = false;

  for (const ticker of tickers) {
    const quote = getCached<CachedLiveQuote>(liveKey(ticker));
    if (!quote) continue;
    seen = true;
    const state = quote.marketState ?? null;
    ttl = Math.min(ttl, quoteTtlSeconds(state));
    if (state === 'REGULAR') marketOpen = true;
    if (quote.quoteTime && (newest === null || quote.quoteTime > newest)) newest = quote.quoteTime;
  }

  return {
    asOf: newest !== null ? new Date(newest).toISOString() : null,
    // Brak notowań w cache'u (portfel czysto NC/Catalyst albo odcięcie źródła) →
    // nie udajemy wiedzy o rynku, tylko wracamy do zachowawczej godziny.
    ttlSeconds: seen ? ttl : config.cache.quoteTtl.unknown,
    marketOpen,
  };
}

/**
 * Symbol pary walutowej (`USDPLN=X`) → klucz cache'u kursu (`fx_USDPLN`).
 * Zwraca null dla zwykłych tickerów.
 */
function fxKeyFor(symbol: string): string | null {
  return symbol.endsWith('=X') ? `fx_${symbol.slice(0, -2)}` : null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Jeden strzał v7 dla listy symboli. Zwraca null, gdy żądanie się nie udało
 * (wołający potraktuje cały chunk jako `missed`).
 */
async function fetchQuoteChunk(symbols: string[]): Promise<Map<string, YahooQuote> | null> {
  const guard = getYahooGuard();
  if (guard.isBlocked()) return null;

  const auth = await getYahooAuth();
  if (!auth) return null;

  async function attempt(crumb: string, cookies: string): Promise<Response> {
    const params = new URLSearchParams({ symbols: symbols.join(','), crumb });
    return withYahooLimit(() =>
      fetch(`${YAHOO_V7_BASE}?${params}`, {
        headers: { 'User-Agent': USER_AGENT, Cookie: cookies },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      }),
    );
  }

  try {
    let resp = await attempt(auth.crumb, auth.cookies);

    if (resp.status === 401 || resp.status === 403) {
      // v7 wymaga pary cookie+crumb z jednego „słoika" — 401 to zwykle rotacja
      // crumba, nie odcięcie. Jedna powtórka ze świeżą parą.
      invalidateYahooAuth();
      const auth2 = await getYahooAuth();
      if (!auth2) return null;
      resp = await attempt(auth2.crumb, auth2.cookies);
      if (resp.status === 401 || resp.status === 403) {
        // Świeży crumb i dalej odmowa → to już odcięcie.
        guard.registerBlock();
        return null;
      }
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (detectYahooBlock(resp.status, body)) guard.registerBlock();
      return null;
    }

    const quotes = parseQuoteResponse(await resp.json());
    if (quotes.size > 0) guard.registerSuccess('v7-quote');
    else guard.registerParseMiss('v7-quote', { structural: true });
    return quotes;
  } catch (err) {
    console.warn('[yahoo-quotes] batch quote nie powiódł się:', (err as Error).message);
    return null;
  }
}

/**
 * Wypełnia cache cen live dla podanych tickerów jednym (lub kilkoma) żądaniami.
 *
 * Zwraca symbole, których batch nie pokrył — wołający NIE musi nic z nimi robić:
 * `fetchYahooPrice` sam pobierze je pojedynczo starą ścieżką. Lista służy do
 * diagnostyki i testów.
 */
export async function primeYahooQuotes(
  tickers: string[],
): Promise<{ primed: number; missed: string[] }> {
  // Twardy wyłącznik (wzorzec BOND_CATALOG_ONDEMAND): testy nie mogą uderzać do
  // Yahoo, a na produkcji daje to awaryjne wyjście, gdyby v7 zaczął kaprysić —
  // wszystko spada wtedy na sprawdzoną ścieżkę per-ticker v8.
  if (process.env.YAHOO_BATCH_QUOTES === 'off') return { primed: 0, missed: [...tickers] };

  // Deduplikacja + odsiew tego, co już jest w cache'u — prime ma dopytać
  // wyłącznie o brakujące symbole.
  const wanted = [...new Set(tickers.filter(Boolean))].filter(
    (t) => getCached<CachedLiveQuote>(liveKey(t)) === undefined,
  );
  if (wanted.length === 0) return { primed: 0, missed: [] };

  let primed = 0;
  const missed: string[] = [];
  const toPersist: QuoteUpsert[] = [];

  for (const group of chunk(wanted, CHUNK_SIZE)) {
    const quotes = await fetchQuoteChunk(group);
    if (!quotes) {
      missed.push(...group);
      continue;
    }
    for (const symbol of group) {
      const quote = quotes.get(symbol);
      if (!quote) {
        missed.push(symbol);
        continue;
      }
      const ttl = quoteTtlSeconds(quote.marketState);
      const cached: CachedLiveQuote = {
        price: quote.price,
        currency: quote.currency,
        previousClose: quote.previousClose,
        marketState: quote.marketState,
        quoteTime: quote.quoteTime,
      };
      setCached(liveKey(symbol), cached, ttl);

      // Pary walutowe trafiają dodatkowo pod klucz kursu — inaczej fetchFxRate
      // i tak zrobiłby osobny strzał v8 po tę samą liczbę.
      const fxKey = fxKeyFor(symbol);
      if (fxKey) setCached(fxKey, quote.price, ttl);

      toPersist.push({ ticker: symbol, source: 'yahoo-v7', ...quote });
      primed++;
    }
  }

  // Write-through do store'a: po restarcie procesu (deploy) i przy odcięciu
  // Yahoo mamy z czego wycenić portfel — zamiast schodzić na cenę z transakcji.
  getLiveQuoteStore().upsert(toPersist);

  return { primed, missed };
}
