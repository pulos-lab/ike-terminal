/**
 * Ceny bieżące obligacji Catalyst ze stockwatch.pl (tabele notowań per sektor).
 *
 * Powód: endpoint live CSV Stooqa padł ~03.2026, a żadne inne sprawdzone źródło
 * nie kwotuje obligacji (biznesradar → 404, bankier → pokrycie częściowe i 404
 * na stronach per-instrument, gpwcatalyst.pl → WAF). Stockwatch renderuje
 * server-side zbiorcze tabele: Nazwa | Emitent | Segment | Data | Kurs ostatni |
 * Kurs odniesienia — kurs w % nominału (zgodnie z konwencją silnika:
 * `bondPriceMultiplier` mnoży przez nominał z bond-map).
 *
 * Strategia: JEDEN lazy fetch wszystkich stron sektorowych → mapa
 * ticker → notowanie, wspólny TTL. Obligacje handlują rzadko — 1h TTL to aż
 * nadto; 5 żądań/h nie obciąża serwisu (precedens: kalendarz dywidend już
 * scrapuje stockwatch ≤1×/24h). Circuit breaker jak w biznesradar.ts —
 * lekcja ze Stooqa: śmierć źródła nie może być cicha.
 */

import * as cheerio from 'cheerio';
import { getCached, setCached } from './price-cache.js';
import { config } from '../config.js';
import { getLiveQuoteStore } from './live-quote-store.js';

const FETCH_TIMEOUT = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Sektory Catalyst na stockwatch — razem pełne pokrycie notowanych serii. */
const SECTOR_URLS = [
  'https://www.stockwatch.pl/obligacje/notowania/sektor/korporacyjne/',
  'https://www.stockwatch.pl/obligacje/notowania/sektor/skarbowe/',
  'https://www.stockwatch.pl/obligacje/notowania/sektor/komunalne/',
  'https://www.stockwatch.pl/obligacje/notowania/sektor/spoldzielcze/',
  'https://www.stockwatch.pl/obligacje/notowania/sektor/listy-zastawne/',
];

export interface StockwatchBondQuote {
  /** Kurs ostatniej transakcji w % nominału (null = seria bez transakcji). */
  price: number | null;
  /** Kurs odniesienia w % nominału — pełni rolę previousClose. */
  referencePrice: number | null;
  /** Data ostatniej transakcji (YYYY-MM-DD) lub null („brak"). */
  lastTradeDate: string | null;
}

const CACHE_KEY = 'stockwatch_bonds_map';

// ── Circuit breaker (wzorzec z biznesradar.ts) ──────────────────────────────
const BLOCK_THRESHOLD = 3;
const BLOCK_BACKOFF_MS = 30 * 60 * 1000;
let consecutiveBlocks = 0;
let blockedUntil = 0;

/** Czy odpowiedź to blokada/anti-bot (a NIE zwykły 404)? */
export function detectStockwatchBlock(status: number, html: string): boolean {
  if (status === 429 || status === 403 || status === 503) return true;
  const h = html.toLowerCase();
  return (
    h.includes('captcha') ||
    h.includes('just a moment') ||
    h.includes('cf-browser-verification') ||
    h.includes('attention required') ||
    h.includes('access denied') ||
    h.includes('requires javascript')
  );
}

function registerBlock(): void {
  consecutiveBlocks += 1;
  if (consecutiveBlocks >= BLOCK_THRESHOLD && Date.now() >= blockedUntil) {
    blockedUntil = Date.now() + BLOCK_BACKOFF_MS;
    console.warn(
      `[stockwatch-bonds] wykryto odcięcie (${consecutiveBlocks} blokad pod rząd) — ` +
        `bezpiecznik otwarty do ${new Date(blockedUntil).toISOString()}. ` +
        `Ceny live Catalyst wstrzymane; sprawdź czy stockwatch nie zmienił zabezpieczeń.`,
    );
  }
}

function registerSuccess(): void {
  consecutiveBlocks = 0;
  blockedUntil = 0;
}

/** „80,00" / „100,5" → liczba; „-" / „brak" / puste → null. */
function parseCommaNumber(text: string): number | null {
  const t = text.replace(/\s+/g, '').trim();
  if (!t || t === '-' || t.toLowerCase() === 'brak') return null;
  const v = parseFloat(t.replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Parser tabeli sektora (czysta funkcja, bez I/O). Wiersz:
 * <td><a>TICKER</a></td><td>emitent</td><td>segment</td>
 * <td>YYYY-MM-DD|brak</td><td>kurs|-</td><td>kurs odn.|-</td>
 * Wiersze bez tickera w formacie serii obligacji są pomijane.
 */
export function parseStockwatchBondsTable(html: string): Map<string, StockwatchBondQuote> {
  const $ = cheerio.load(html);
  const quotes = new Map<string, StockwatchBondQuote>();
  $('tr').each((_i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 6) return;
    const ticker = $(cells[0]).text().replace(/\s+/g, '').toUpperCase();
    // Format serii Catalyst: 2-6 znaków emitenta + 4 cyfry MMRR (np. GHE0728, BS10327)
    if (!/^[A-Z0-9]{2,6}\d{4}$/.test(ticker)) return;
    const dateText = $(cells[3]).text().trim();
    const lastTradeDate = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : null;
    quotes.set(ticker, {
      price: parseCommaNumber($(cells[4]).text()),
      referencePrice: parseCommaNumber($(cells[5]).text()),
      lastTradeDate,
    });
  });
  return quotes;
}

// In-flight dedup — równoległe pozycje obligacyjne nie mogą odpalić 5 fetchy każda.
let inFlight: Promise<Map<string, StockwatchBondQuote>> | null = null;

/**
 * Zbiorcza mapa notowań Catalyst (wszystkie sektory). Cache po TTL; częściowa
 * awaria (padnie jedna strona sektorowa) nie unieważnia reszty. Pusta mapa
 * NIE jest cache'owana — po chwilowej awarii kolejne wywołanie próbuje od nowa.
 */
export async function fetchStockwatchBondQuotes(): Promise<Map<string, StockwatchBondQuote>> {
  const cached = getCached<Map<string, StockwatchBondQuote>>(CACHE_KEY);
  if (cached) return cached;
  if (Date.now() < blockedUntil) return new Map();
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const merged = new Map<string, StockwatchBondQuote>();
    for (const url of SECTOR_URLS) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
        });
        const html = response.ok ? await response.text() : '';
        if (detectStockwatchBlock(response.status, html)) {
          registerBlock();
          // Odcięcie — nie hameruj pozostałych sektorów w tej rundzie.
          break;
        }
        if (!response.ok) continue;
        const sectorQuotes = parseStockwatchBondsTable(html);
        if (sectorQuotes.size > 0) registerSuccess();
        for (const [ticker, quote] of sectorQuotes) merged.set(ticker, quote);
      } catch (error) {
        console.error(`[stockwatch-bonds] fetch failed for ${url}:`, error);
      }
    }
    if (merged.size > 0) {
      setCached(CACHE_KEY, merged, config.cache.stockwatchBondsTtl);
    }
    return merged;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Notowanie pojedynczej serii (lookup w zbiorczej mapie). `ticker` może mieć
 * sufiks — zdejmowany. Zwraca null, gdy serii nie ma w tabelach (np. wykupiona).
 */
export async function fetchStockwatchBondPrice(
  ticker: string,
): Promise<StockwatchBondQuote | null> {
  const symbol = ticker.split('.')[0].toUpperCase().trim();
  if (!symbol) return null;
  const quotes = await fetchStockwatchBondQuotes();
  const quote = quotes.get(symbol) ?? null;
  // Seria bez transakcji ma price=null — nie ma czego zapisywać.
  if (quote?.price != null) {
    // Write-through pod tickerem, jakim woła silnik (z sufiksem) — żeby odczyt
    // fallbackowy trafiał tym samym kluczem. Kurs w % nominału, jak w cache'u.
    getLiveQuoteStore().upsert([
      {
        ticker,
        price: quote.price,
        currency: 'PLN',
        previousClose: quote.referencePrice ?? null,
        source: 'stockwatch',
      },
    ]);
  }
  return quote;
}

/** Reset stanu bezpiecznika i in-flight — wyłącznie dla testów. */
export function resetStockwatchBondsStateForTests(): void {
  consecutiveBlocks = 0;
  blockedUntil = 0;
  inFlight = null;
}
