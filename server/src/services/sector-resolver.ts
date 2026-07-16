/**
 * Sector resolver — pojedyncze źródło prawdy dla klasyfikacji sektorowej
 * zunifikowanej ze stockwatch.pl (8 nadsektorów × 40 podsektorów) oraz kraju
 * siedziby (źródło wykresu „Regiony").
 *
 * Kolejność źródeł (sektor):
 *   1. GPW/NC  → GPW_SECTOR_MAP po tickerze (stripped .WA/.NC)
 *              → fallback: GPW_NAME_TO_TICKER po nazwie spółki
 *   2. CFD     → getCfdSector (Surowce/Indeksy/Forex/Krypto) jako supersector
 *   3. Inne    → Yahoo fetchAssetProfile → mapGicsToStockwatch (GICS → PL)
 *   4. Miss    → { supersector: null, subsector: null } (caller → "Inne")
 *
 * Kraj: GPW/NC/Catalyst → "Poland" (statycznie); CFD → null (surowce/indeksy/FX
 * nie mają kraju); zagraniczne → Yahoo assetProfile.country (poprawnie
 * klasyfikuje ADR-y — spółka duńska na NYSE dostaje "Denmark", nie USA).
 */

import type { TickerMapEntry } from 'shared';
import {
  GPW_SECTOR_MAP,
  GPW_NAME_TO_TICKER,
  findCfdTicker,
  getCfdSector,
  mapGicsToStockwatch,
} from 'shared';
import { fetchAssetProfile } from './yahoo-finance.js';

export interface ResolvedSector {
  supersector: string | null;
  subsector: string | null;
  /** Kraj siedziby, kanoniczna nazwa EN (jak Yahoo assetProfile.country). */
  country: string | null;
}

import { stripTickerSuffix } from './stooq-utils.js';

/** Normalizacja nazwy firmy: usuń "S.A.", "SA", "ASI", puste znaki, lowercase. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+s\.?a\.?\s*$/i, '')
    .replace(/\s+asi\s*$/i, '')
    .replace(/\s+spółka akcyjna\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kandydaci do fuzzy matchu, posortowani malejąco po długości nazwy.
 *  Długie nazwy bite są pierwsze (np. "kogeneracja" > "ac"), co eliminuje
 *  fałszywe trafienia typu "AC" (2 chars) w "kogener**ac**ja". Minimum 5 znaków
 *  — krótsze ("ac", "lpp", "ccc", "best", "less") są zbyt niespecyficzne jako
 *  substring i powodowały klasyfikację np. Kogeneracji jako Motoryzacji. */
const GPW_NAME_CANDIDATES: Array<[string, string]> = Object.entries(GPW_NAME_TO_TICKER)
  .filter(([sw]) => sw.length >= 5)
  .sort((a, b) => b[0].length - a[0].length);

/** Spróbuj dopasować wpis ticker_map do klucza stockwatch przez nazwę. */
function findGpwByName(name: string | undefined | null): string | null {
  if (!name) return null;
  const norm = normalizeName(name);
  // Dokładne trafienie — zawsze wygrywa niezależnie od długości.
  const exact = GPW_NAME_TO_TICKER[norm];
  if (exact) return exact;
  // Fuzzy: najdłuższy-match-wygrywa, tylko dla nazw ≥ 5 znaków.
  for (const [swName, ticker] of GPW_NAME_CANDIDATES) {
    if (norm.includes(swName) || swName.includes(norm)) return ticker;
  }
  return null;
}

/**
 * Zwraca klasyfikację sektorową w taksonomii stockwatch dla danego wpisu ticker_map.
 * Czysto funkcyjny interfejs (poza Yahoo fetch); bezpieczny do wywołania w pętli
 * z `updateTickerSectors`.
 */
export async function resolveSector(entry: TickerMapEntry): Promise<ResolvedSector> {
  const { ticker, exchange, name } = entry;

  // Kraj dla polskich rynków znany statycznie — niezależnie od trafienia sektora.
  const isPolish = exchange === 'GPW' || exchange === 'NC' || exchange === 'CATALYST';
  const staticCountry = isPolish ? 'Poland' : null;

  // 0) Obligacje Catalyst — serie nie istnieją w Yahoo (fetch zawsze chybia),
  //    sektor zostaje pusty; zwracamy od razu sam kraj.
  if (exchange === 'CATALYST') {
    return { supersector: null, subsector: null, country: staticCountry };
  }

  // 1) GPW / NewConnect — statyczna mapa stockwatch.
  if (exchange === 'GPW' || exchange === 'NC') {
    const stripped = stripTickerSuffix(ticker).toUpperCase();
    const byTicker = GPW_SECTOR_MAP[stripped];
    if (byTicker) {
      return {
        supersector: byTicker.supersector,
        subsector: byTicker.subsector,
        country: staticCountry,
      };
    }
    const byNameTicker = findGpwByName(name);
    if (byNameTicker) {
      const hit = GPW_SECTOR_MAP[byNameTicker];
      if (hit) {
        return { supersector: hit.supersector, subsector: hit.subsector, country: staticCountry };
      }
    }
    // GPW miss → spróbuj Yahoo jako fallback (często small-cap ma sektor w Yahoo)
  }

  // 2) CFD — autorytatywna statyczna mapa. Surowce/indeksy/FX nie mają kraju.
  const cfdEntry = findCfdTicker(name) || findCfdTicker(ticker);
  if (cfdEntry) {
    return { supersector: getCfdSector(cfdEntry), subsector: null, country: staticCountry };
  }

  // 3) Yahoo GICS → stockwatch (+ kraj siedziby z tego samego profilu).
  try {
    const profile = await fetchAssetProfile(ticker);
    if (profile) {
      const country = staticCountry ?? profile.country;
      const mapped = mapGicsToStockwatch(profile.sector, profile.industry);
      if (mapped) {
        return { supersector: mapped.supersector, subsector: mapped.subsector, country };
      }
      // Mapowanie nie znalazło — zachowaj przynajmniej angielski sector jako subsector
      if (profile.sector) {
        return { supersector: null, subsector: profile.sector, country };
      }
      return { supersector: null, subsector: null, country };
    }
  } catch {
    // silent — caller nie blokuje się na pojedynczym faile
  }

  // 4) Nic nie rozpoznane
  return { supersector: null, subsector: null, country: staticCountry };
}
