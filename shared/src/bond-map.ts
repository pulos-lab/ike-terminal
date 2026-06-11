import { BOND_MAP, type BondMapEntry } from './bond-map-data.js';

export { BOND_MAP, type BondMapEntry };

/**
 * Obligacje skarbowe (Skarb Państwa) i gwarantowane przez SP (BGK: FPC, IDS) notowane
 * na Catalyst — zamknięta lista prefiksów serii + 4 cyfry MMRR (np. DS1030, WZ1131,
 * FPC0733). Regex celowo ścisły: korporacyjne (np. KGH0629) NIE są łapane regexem,
 * tylko przez BOND_MAP — wzorzec "3-4 litery + 4 cyfry" kolidowałby ze zwykłymi tickerami.
 */
export const TREASURY_BOND_RE = /^(OK|PS|DS|WS|WZ|IZ|TOS|FPC|IDS)\d{4}$/;

/**
 * ISIN-y obligacji skarbowych i BGK zaczynają się od PL0000 (emitent: Skarb Państwa / BGK,
 * np. DS0432 → PL0000113783, FPC0229 → PL0000500443). Akcje GPW mają prefiks emitenta
 * (PLKGHM..., PLCDPRO...), więc PL0000 jest bezpiecznym sygnałem obligacji.
 */
const TREASURY_ISIN_RE = /^PL0000\d{6}$/;

/** Indeks odwrotny ISIN → entry, budowany leniwie z BOND_MAP. */
let isinIndex: Map<string, BondMapEntry> | null = null;

function getIsinIndex(): Map<string, BondMapEntry> {
  if (!isinIndex) {
    isinIndex = new Map();
    for (const entry of Object.values(BOND_MAP)) {
      if (entry.isin) isinIndex.set(entry.isin, entry);
    }
  }
  return isinIndex;
}

export function findBondByTicker(ticker: string): BondMapEntry | null {
  return BOND_MAP[ticker.toUpperCase().trim()] ?? null;
}

export function findBondByIsin(isin: string): BondMapEntry | null {
  return getIsinIndex().get(isin.toUpperCase().trim()) ?? null;
}

/**
 * Czy papier (paperName/ticker + opcjonalny ISIN) jest obligacją Catalyst?
 * Kolejność: mapa (ticker → ISIN) → regex skarbowy → prefiks ISIN PL0000.
 * Korporacyjne spoza mapy NIE są wykrywane (świadomie — brak bezpiecznego wzorca);
 * po dograniu mapy scraperem (`npm run scrape:catalyst-bonds -w server`) zostaną rozpoznane.
 */
export function isBondInstrument(paperName: string, isin?: string): boolean {
  const ticker = (paperName || '').toUpperCase().trim();
  if (ticker && BOND_MAP[ticker]) return true;
  if (TREASURY_BOND_RE.test(ticker)) return true;
  if (isin && getIsinIndex().has(isin.toUpperCase().trim())) return true;
  if (isin && TREASURY_ISIN_RE.test(isin.toUpperCase().trim())) return true;
  return false;
}

/** Typowe nominały obligacji Catalyst (PLN/EUR). */
const KNOWN_NOMINALS = [100, 1000, 10000] as const;

/**
 * Inferencja wartości nominalnej z transakcji, gdy obligacji nie ma w mapie:
 * kurs jest w % nominału, więc `value ≈ quantity × pricePct/100 × nominal`.
 * Kandydat przyciągany do najbliższego typowego nominału z tolerancją 15% —
 * pokrywa to narosłe odsetki w `value` (zwykle ≤ kilka % nominału).
 * Zwraca null gdy dane nie pozwalają na wiarygodny strzał.
 */
export function inferBondNominal(quantity: number, pricePct: number, value: number): number | null {
  if (!(quantity > 0) || !(pricePct > 0) || !(value > 0)) return null;
  const candidate = value / (quantity * (pricePct / 100));
  for (const nominal of KNOWN_NOMINALS) {
    if (Math.abs(candidate - nominal) / nominal <= 0.15) return nominal;
  }
  return null;
}
