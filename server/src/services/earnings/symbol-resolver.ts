/**
 * Mapowanie pozycji portfela na klucz symbolu w źródle terminarza.
 *
 * US jest darmowe — nasze tickery zagraniczne są czyste (`AAPL`, `PLTR`, `NVO`)
 * i wprost pasują do kalendarza Nasdaq.
 *
 * PL/NC wymaga sluga bankiera (`CDPROJEKT`, `ORANGEPL`, `AQUABB`), który NIE jest
 * naszym tickerem (`CDR.WA`). Kluczowa obserwacja: klucze `GPW_SECTOR_MAP` to
 * dokładnie te slugi (mapa jest generowana ze stockwatch, który dzieli z bankierem
 * skróty GPW), a `NC_TICKER_MAP` daje `ticker → skrót` dla NewConnectu. Cały indeks
 * mamy więc offline w repo — bez ani jednego dodatkowego requestu.
 *
 * Moduł jest czysty (poza opcjonalnym mostem do tabeli dywidend wstrzykiwanym
 * jako zależność), żeby dało się go testować bez sieci i bez bazy.
 */
import {
  GPW_SECTOR_MAP,
  findNcTicker,
  normalizePolishCompanyName,
  compactPolishCompanyName,
} from 'shared';
import { stripTickerSuffix } from '../stooq-utils.js';
import type { EarningsMarket, SymbolResolvedBy } from './earnings-store.js';

export interface ResolvedEarningsSymbol {
  symbolKey: string;
  resolvedBy: SymbolResolvedBy;
  confidence: number;
}

export interface SymbolResolverDeps {
  /**
   * Most przez kalendarz dywidend: `gpw_dividend_calendar` trzyma pary
   * `short_name ↔ ticker` dla ~190 spółek, zebrane niezależnym scrapem.
   * Darmowy fallback dla spółek spoza statycznych map.
   */
  dividendBridge?: (tickerBase: string) => string | null;
}

/** Giełdy, dla których w ogóle szukamy terminarza (reszta nie publikuje raportów okresowych). */
const PL_EXCHANGES = new Set(['GPW', 'NC']);
const US_EXCHANGES = new Set(['NYSE', 'NASDAQ']);
const FOREIGN_EXCHANGES = new Set(['XETRA', 'TSX']);

/**
 * Indeks „znormalizowana nazwa → slug" zbudowany z `GPW_SECTOR_MAP`.
 * W odróżnieniu od `GPW_NAME_TO_TICKER` (samo `toLowerCase`) składa diakrytyki,
 * dzięki czemu brokerska „Grupa Kety" trafia w „Grupa Kęty".
 */
const NAME_TO_SLUG: Map<string, string> = (() => {
  const out = new Map<string, string>();
  for (const [slug, entry] of Object.entries(GPW_SECTOR_MAP)) {
    const norm = normalizePolishCompanyName(entry.name);
    if (norm && !out.has(norm)) out.set(norm, slug);
  }
  return out;
})();

/**
 * Kandydaci do fuzzy matchu, malejąco po długości — dłuższe nazwy bite pierwsze.
 * Minimum 5 znaków; krótsze („ac", „lpp", „best") jako substring dają fałszywe
 * trafienia (lekcja z `sector-resolver.ts`).
 */
const NAME_CANDIDATES: Array<[string, string]> = [...NAME_TO_SLUG.entries()]
  .filter(([name]) => name.length >= 5)
  .sort((a, b) => b[0].length - a[0].length);

/** Rynek, na którym szukamy terminarza; null = instrument poza zakresem funkcji. */
export function resolveEarningsMarket(exchange: string | undefined): EarningsMarket | null {
  if (!exchange) return null;
  if (PL_EXCHANGES.has(exchange)) return 'PL';
  if (US_EXCHANGES.has(exchange)) return 'US';
  if (FOREIGN_EXCHANGES.has(exchange)) return 'FOREIGN';
  return null;
}

/** Slug bankiera dla spółki z GPW/NewConnect. Kolejność: najpewniejsze najpierw. */
export function resolvePlSlug(
  ticker: string,
  name: string | undefined | null,
  deps: SymbolResolverDeps = {},
): ResolvedEarningsSymbol | null {
  const base = stripTickerSuffix(ticker).toUpperCase().trim();
  if (!base) return null;

  // 1. NewConnect — statyczna mapa ticker → skrót (MND → MINERAL).
  const nc = findNcTicker(base);
  if (nc?.name) {
    return { symbolKey: nc.name.toUpperCase(), resolvedBy: 'nc-map', confidence: 1 };
  }

  // 2. Ticker JEST slugiem (PZU, LPP, TOA, GPW).
  if (Object.prototype.hasOwnProperty.call(GPW_SECTOR_MAP, base)) {
    return { symbolKey: base, resolvedBy: 'ticker-is-slug', confidence: 1 };
  }

  // 3. Nazwa z ticker_map jest slugiem — realny przypadek nazw brokerskich
  //    (OML.WA ma name='ONEMORE', WPR.WA → 'WOODPCKR').
  if (name) {
    const compact = compactPolishCompanyName(name).toUpperCase();
    if (compact && Object.prototype.hasOwnProperty.call(GPW_SECTOR_MAP, compact)) {
      return { symbolKey: compact, resolvedBy: 'name-is-slug', confidence: 1 };
    }
  }

  // 4. Po znormalizowanej nazwie — dokładnie, potem fuzzy „najdłuższy match wygrywa".
  if (name) {
    const norm = normalizePolishCompanyName(name);
    const exact = NAME_TO_SLUG.get(norm);
    if (exact) return { symbolKey: exact, resolvedBy: 'name-index', confidence: 1 };
    if (norm.length >= 5) {
      for (const [candidate, slug] of NAME_CANDIDATES) {
        if (norm.includes(candidate) || candidate.includes(norm)) {
          return { symbolKey: slug, resolvedBy: 'name-index', confidence: 0.8 };
        }
      }
    }
  }

  // 5. Most przez kalendarz dywidend (pary zebrane niezależnym scrapem).
  const bridged = deps.dividendBridge?.(base);
  if (bridged) {
    return { symbolKey: bridged.toUpperCase(), resolvedBy: 'dividend-bridge', confidence: 0.9 };
  }

  return null;
}

/**
 * Klucz symbolu dla dowolnej pozycji. Dla US/FOREIGN to sam ticker — Nasdaq i Yahoo
 * używają tych samych oznaczeń co my.
 */
export function resolveEarningsSymbol(
  market: EarningsMarket,
  ticker: string,
  name: string | undefined | null,
  deps: SymbolResolverDeps = {},
): ResolvedEarningsSymbol | null {
  if (market === 'PL') return resolvePlSlug(ticker, name, deps);
  const symbol = ticker.toUpperCase().trim();
  if (!symbol) return null;
  return { symbolKey: symbol, resolvedBy: 'ticker-is-slug', confidence: 1 };
}
