/**
 * Ceny bieżące spółek GPW/NewConnect z biznesradar.pl.
 *
 * Powód: endpoint CSV Stooqa (`/q/l/`) przestał działać (~03.2026 zwraca stronę
 * „Wybrana lokalizacja nie istnieje" dla wszystkich symboli), a Yahoo nie listuje
 * NewConnect. biznesradar renderuje kurs server-side i pokrywa NC — używamy go jako
 * główne źródło cen live dla NC (Stooq zostaje jako zapas, gdyby wrócił).
 *
 * Dane są opóźnione ~15 min (akceptowalne dla widoku portfela), stąd krótki TTL.
 * Strona `/notowania/<TICKER>` robi 301 na slug nazwy (np. EXC → /notowania/EXCELLENCE),
 * więc podajemy sam ticker i pozwalamy fetchowi podążyć za przekierowaniem.
 */

import { getCached, setCached } from './price-cache.js';
import { config } from '../config.js';
import { createConcurrencyLimiter } from './concurrency.js';
import { stripTickerSuffix } from './stooq-utils.js';

const withBrLimit = createConcurrencyLimiter(3);
const FETCH_TIMEOUT = 12_000;
const NULL_TTL = 5 * 60; // krótki cache na miss (404/parse fail) — nie blokuj retry na długo

const BR_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ── Circuit breaker: gdy biznesradar nas odetnie (429/403/challenge), nie hamerujemy ──
// Lekcja ze Stooqa: śmierć źródła była CICHA (parser po prostu zwracał null). Tu wykrywamy
// odcięcie, głośno logujemy i krótko-spinamy fetch-e na BLOCK_BACKOFF, żeby nie dobijać serwisu.
const BLOCK_THRESHOLD = 3; // tyle blokad pod rząd → otwórz bezpiecznik
const BLOCK_BACKOFF_MS = 30 * 60 * 1000; // 30 min ciszy po odcięciu
let consecutiveBlocks = 0;
let blockedUntil = 0;

/**
 * Czy odpowiedź to blokada/anti-bot (a NIE zwykły brak spółki)?
 * 429/403 lub markery challenge (captcha, Cloudflare „Just a moment", access denied).
 * Strona 404 „nie istnieje" NIE jest blokadą — to po prostu nieznany ticker.
 */
export function detectBiznesradarBlock(status: number, html: string): boolean {
  if (status === 429 || status === 403 || status === 503) return true;
  const h = html.toLowerCase();
  return (
    h.includes('captcha') ||
    h.includes('just a moment') ||
    h.includes('cf-browser-verification') ||
    h.includes('attention required') ||
    h.includes('access denied') ||
    h.includes('zbyt wiele') // "zbyt wiele zapytań"
  );
}

/** Stan bezpiecznika — do diagnostyki/health. */
export function getBiznesradarBlockState(): { blocked: boolean; blockedUntil: number } {
  return { blocked: Date.now() < blockedUntil, blockedUntil };
}

function registerBlock(): void {
  consecutiveBlocks += 1;
  if (consecutiveBlocks >= BLOCK_THRESHOLD && Date.now() >= blockedUntil) {
    blockedUntil = Date.now() + BLOCK_BACKOFF_MS;
    console.warn(
      `[biznesradar] wykryto odcięcie (${consecutiveBlocks} blokad pod rząd) — ` +
        `bezpiecznik otwarty do ${new Date(blockedUntil).toISOString()}. ` +
        `Ceny live NC wstrzymane; sprawdź czy biznesradar nie zmienił zabezpieczeń.`,
    );
  }
}

function registerSuccess(): void {
  consecutiveBlocks = 0;
  blockedUntil = 0;
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

  // Bezpiecznik otwarty — jesteśmy odcięci, nie ruszamy sieci aż do wygaśnięcia backoffu.
  if (Date.now() < blockedUntil) return null;

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
        registerBlock();
        // NIE cache'ujemy — po wygaśnięciu backoffu chcemy spróbować od nowa.
        return null;
      }
      if (!response.ok) {
        setCached(cacheKey, null, NULL_TTL);
        return null;
      }

      const price = parseBiznesradarPrice(html);
      if (price != null) registerSuccess(); // realna cena = źródło żyje, zeruj licznik blokad
      setCached(cacheKey, price, price != null ? config.cache.biznesradarLiveTtl : NULL_TTL);
      return price;
    } catch (error) {
      console.error(`biznesradar price fetch failed for ${ticker}:`, error);
      return null;
    }
  });
}
