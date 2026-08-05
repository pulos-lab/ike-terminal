/**
 * Ceny bieżące i historyczne spółek GPW/NewConnect oraz obligacji Catalyst
 * z biznesradar.pl.
 *
 * Powód: endpointy CSV Stooqa padły (~03.2026 live `/q/l/` = „lokalizacja nie
 * istnieje"; ~07.2026 historyczny `/q/d/l/` za challenge anti-bot), a Yahoo nie
 * listuje NewConnect ani obligacji Catalyst. biznesradar renderuje SERVER-SIDE
 * i kurs bieżący, i tabelę notowań historycznych — używamy go jako główne źródło
 * cen live NC (Stooq zapas) i główne źródło HISTORII wykresów NC + Catalyst.
 *
 * Dane live są opóźnione ~15 min (akceptowalne dla widoku portfela), stąd krótki TTL.
 * Strona `/notowania/<TICKER>` i `/notowania-historyczne/<TICKER>` robią 301 na slug
 * nazwy (np. EXC → EXCELLENCE); podajemy sam ticker i podążamy za przekierowaniem,
 * a slug do paginacji odczytujemy z finalnego URL.
 */

import { getCached, setCached } from './price-cache.js';
import { config } from '../config.js';
import { createConcurrencyLimiter } from './concurrency.js';
import { stripTickerSuffix } from './stooq-utils.js';
import {
  storeHistoricalPrices,
  loadHistoricalPrices,
  getLastCachedDate,
  getFirstCachedDate,
} from './history-cache.js';
import { parseNumber } from '../parsers/utils.js';
import { detectBiznesradarBlock, getBiznesradarGuard } from './biznesradar-guard.js';
import { getLiveQuoteStore } from './live-quote-store.js';

// Re-export dla zastanych importów (testy, skrypty) — definicja przeniesiona
// do lekkiego biznesradar-guard.ts, żeby katalog/kalendarz nie ciągnęły tego modułu.
export { detectBiznesradarBlock } from './biznesradar-guard.js';

const withBrLimit = createConcurrencyLimiter(3);
const FETCH_TIMEOUT = 12_000;
const NULL_TTL = 5 * 60; // krótki cache na miss (404/parse fail) — nie blokuj retry na długo

const BR_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ── Guard źródła: breaker (429/403/challenge) + detekcja zmiany markupu ─────
// Lekcja ze Stooqa: śmierć źródła była CICHA (parser po prostu zwracał null).
// Wspólna instancja z katalogiem tickerów i kalendarzem dywidend — patrz
// biznesradar-guard.ts; stan w /api/health, przejścia mailują admina.

/** Stan bezpiecznika — wrapper kompatybilności (pełny stan: guard.getState()). */
export function getBiznesradarBlockState(): { blocked: boolean; blockedUntil: number } {
  const state = getBiznesradarGuard().getState();
  return {
    blocked: state.blocked,
    blockedUntil: state.blockedUntil ? Date.parse(state.blockedUntil) : 0,
  };
}

/**
 * Wyłuskaj kurs z HTML strony notowań biznesradar.
 * Element główny: `<span class="q_ch_act">0.565</span>` (kropka dziesiętna, PLN).
 * Odporny na spacje jako separator tysięcy (np. „1 234.50").
 */
export function parseBiznesradarPrice(html: string): number | null {
  const m = html.match(/class="q_ch_act"[^>]*>\s*([0-9][0-9\s]*(?:\.[0-9]+)?)/);
  if (!m) return null;
  const value = parseFloat(m[1].replace(/\s+/g, ''));
  if (!isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Pobierz bieżący kurs (opóźniony ~15 min) z biznesradar.pl.
 * `ticker` może mieć sufiks `.WA`/`.NC` — jest zdejmowany.
 * Zwraca null gdy spółki brak (404) lub kursu nie da się sparsować.
 */
export async function fetchBiznesradarPrice(ticker: string): Promise<number | null> {
  const symbol = stripTickerSuffix(ticker).toUpperCase().trim();
  if (!symbol) return null;

  const guard = getBiznesradarGuard();
  // Bezpiecznik otwarty — jesteśmy odcięci, nie ruszamy sieci aż do wygaśnięcia backoffu.
  if (guard.isBlocked()) return null;

  const cacheKey = `biznesradar_live_${symbol}`;
  const cached = getCached<number | null>(cacheKey);
  if (cached !== undefined) return cached;

  return withBrLimit(async () => {
    try {
      const url = `https://www.biznesradar.pl/notowania/${encodeURIComponent(symbol)}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': BR_USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });

      // 404 = spółki nie ma pod tym tickerem (delisting/inny symbol) — to NIE odcięcie.
      if (response.status === 404) {
        setCached(cacheKey, null, NULL_TTL);
        return null;
      }

      const html = response.ok ? await response.text() : '';
      if (detectBiznesradarBlock(response.status, html)) {
        guard.registerBlock();
        // NIE cache'ujemy — po wygaśnięciu backoffu chcemy spróbować od nowa.
        return null;
      }
      if (!response.ok) {
        setCached(cacheKey, null, NULL_TTL);
        return null;
      }

      const price = parseBiznesradarPrice(html);
      if (price != null) {
        guard.registerSuccess(`live:${symbol}`); // realna cena = źródło żyje
        // Write-through: NC też ma przetrwać restart procesu i odcięcie źródła.
        // Kurs zapisujemy w konwencji notowania (Catalyst: % nominału) — mnożnik
        // nakłada dopiero silnik, tak samo jak przy odczycie z cache'u.
        getLiveQuoteStore().upsert([{ ticker, price, currency: 'PLN', source: 'biznesradar' }]);
      } else {
        // 200 OK bez kursu = kandydat na zmianę markupu (np. przemianowana klasa
        // q_ch_act); pojedynczy ticker nie alarmuje — dopiero seria różnych.
        guard.registerParseMiss(`live:${symbol}`);
      }
      setCached(cacheKey, price, price != null ? config.cache.biznesradarLiveTtl : NULL_TTL);
      return price;
    } catch (error) {
      console.error(`biznesradar price fetch failed for ${ticker}:`, error);
      return null;
    }
  });
}

// ── Historia notowań (wykresy NC + Catalyst) ────────────────────────────────
// Strona `/notowania-historyczne/<TICKER>` renderuje SERVER-SIDE tabelę
// `qTableFull`: Data | Otwarcie | Max | Min | Zamknięcie | Wolumen | Obrót
// (50 sesji/stronę, data DD.MM.YYYY). Obligacje Catalyst kwotowane w % nominału
// — spójne z konwencją silnika (bondPriceMultiplier), jak wcześniej Stooq.

const HISTORY_PAGE_CAP = 40; // ~2000 sesji ≈ 8 lat; bound na jednorazowy backfill

function ddmmyyyyToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Parser tabeli notowań historycznych (czysta funkcja, bez I/O). Nagłówek ma
 * `<th>`, więc wiersze danych (`<td>`) filtrują się naturalnie. Zwraca (date, close)
 * z kolumny „Zamknięcie" (indeks 4); wiersze bez daty/kursu są pomijane.
 */
export function parseBiznesradarHistoryTable(html: string): Array<{ date: string; close: number }> {
  const tbl = html.match(/<table[^>]*qTableFull[^>]*>([\s\S]*?)<\/table>/);
  if (!tbl) return [];
  const out: Array<{ date: string; close: number }> = [];
  for (const row of tbl[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, '').trim(),
    );
    if (cells.length < 5) continue;
    const date = ddmmyyyyToIso(cells[0]);
    const close = parseNumber(cells[4]);
    if (date && close > 0) out.push({ date, close });
  }
  return out;
}

interface HistoryPage {
  rows: Array<{ date: string; close: number }>;
  slug: string | null;
  blocked: boolean;
  /** Status HTTP — odróżnia „200 bez tabeli" (parse-miss) od 404/5xx. */
  status: number;
}

async function fetchHistoryPage(url: string): Promise<HistoryPage> {
  const response = await fetch(url, {
    headers: { 'User-Agent': BR_USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const status = response.status;
  if (status === 404) return { rows: [], slug: null, blocked: false, status };
  const html = response.ok ? await response.text() : '';
  if (detectBiznesradarBlock(status, html)) return { rows: [], slug: null, blocked: true, status };
  if (!response.ok) return { rows: [], slug: null, blocked: false, status };
  // Slug do paginacji z finalnego URL po 301 (np. EXC → EXCELLENCE); dla obligacji
  // ticker = slug. Ticker+`,N` gubi numer strony w redirect, więc paginujemy slugiem.
  const m = response.url.match(/\/notowania-historyczne\/([^,/?]+)/);
  return {
    rows: parseBiznesradarHistoryTable(html),
    slug: m ? m[1] : null,
    blocked: false,
    status,
  };
}

/**
 * Historia dzienna (date, close) dla NC/Catalyst. Główne źródło wykresów po
 * śmierci Stooqa. Strategia przyrostowa: cache SQLite (ten sam klucz co Stooq —
 * `stripTickerSuffix().toLowerCase()`), a z sieci dociągamy tylko brakujące
 * strony (str.1 = 50 najnowszych sesji) wstecz do startDate lub do ostatniej
 * zakeszowanej daty, z twardym capem stron. Zwraca scalony wynik (cache ∪ świeże).
 */
export async function fetchBiznesradarHistory(
  ticker: string,
  startDate?: string,
): Promise<Array<{ date: string; close: number }>> {
  const key = stripTickerSuffix(ticker).toLowerCase();
  if (!key) return [];

  const cached = loadHistoricalPrices(key, startDate);
  const lastCached = getLastCachedDate(key);
  const firstCached = getFirstCachedDate(key);
  const today = new Date().toISOString().split('T')[0];

  const cacheCoversStart = !startDate || (firstCached != null && firstCached <= startDate);
  const daysDiff = lastCached
    ? Math.floor((new Date(today).getTime() - new Date(lastCached).getTime()) / 86_400_000)
    : Infinity;
  // Cache świeży i pokrywa żądany początek → bez sieci.
  if (cached.length > 10 && daysDiff <= 3 && cacheCoversStart) return cached;

  const guard = getBiznesradarGuard();
  // Bezpiecznik otwarty — oddaj co mamy, nie ruszaj sieci.
  if (guard.isBlocked()) return cached;

  const lowerBound = startDate ?? '2000-01-01';

  return withBrLimit(async () => {
    const fresh: Array<{ date: string; close: number }> = [];
    let slug = stripTickerSuffix(ticker).toUpperCase(); // str.1 tickerem (podąża za 301)
    for (let page = 1; page <= HISTORY_PAGE_CAP; page++) {
      const base = `https://www.biznesradar.pl/notowania-historyczne/${encodeURIComponent(slug)}`;
      const {
        rows,
        slug: resolvedSlug,
        blocked,
        status,
      } = await fetchHistoryPage(page === 1 ? base : `${base},${page}`);
      if (blocked) {
        guard.registerBlock();
        break;
      }
      if (page === 1 && resolvedSlug) slug = resolvedSlug; // slug do dalszej paginacji
      if (rows.length === 0) {
        // Str. 1 z kodem 200 bez tabeli qTableFull = kandydat na zmianę markupu
        // (kolejne strony puste to normalny koniec paginacji, 404/5xx to nie parse-miss).
        if (page === 1 && status === 200) guard.registerParseMiss(`history:${key}`);
        break;
      }
      fresh.push(...rows);
      const oldest = rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date);
      // Stop: sięgnęliśmy żądanego początku ALBO dobiliśmy do tego, co już w cache.
      if (oldest <= lowerBound || (lastCached && oldest <= lastCached)) break;
    }

    if (fresh.length > 0) {
      guard.registerSuccess(`history:${key}`);
      storeHistoricalPrices(key, fresh, 'biznesradar');
    }

    const merged = new Map<string, number>();
    for (const d of cached) merged.set(d.date, d.close);
    for (const d of fresh) merged.set(d.date, d.close);
    const out = [...merged.entries()]
      .map(([date, close]) => ({ date, close }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return startDate ? out.filter((d) => d.date >= startDate) : out;
  });
}
