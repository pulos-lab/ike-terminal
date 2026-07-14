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
      if (!response.ok) {
        // 404 = spółki nie ma pod tym tickerem (np. delisting/inny symbol) — cache miss krótko.
        setCached(cacheKey, null, NULL_TTL);
        return null;
      }
      const html = await response.text();
      const price = parseBiznesradarPrice(html);
      setCached(cacheKey, price, price != null ? config.cache.biznesradarLiveTtl : NULL_TTL);
      return price;
    } catch (error) {
      console.error(`biznesradar price fetch failed for ${ticker}:`, error);
      return null;
    }
  });
}
