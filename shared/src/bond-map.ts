import { BOND_MAP as GENERATED_BOND_MAP, type BondMapEntry } from './bond-map-data.js';
import { BOND_OVERRIDES } from './bond-overrides-map.js';

export type { BondMapEntry };

/**
 * Mapa obligacji = wygenerowana scraperem (`bond-map-data.ts`) ∪ ręczne wpisy
 * (`bond-overrides-map.ts`). Overrides WYGRYWAJĄ przy kolizji tickera — pozwala uzupełnić/
 * skorygować dane, których scraper nie widzi (obligacje wykupione, nigdy nienotowane w jego
 * przebiegu — np. BST0728). Cała reszta pliku (indeks ISIN, findBond*, isBondInstrument)
 * operuje na tym scalonym `BOND_MAP`. Patrz #167.
 */
export const BOND_MAP: Record<string, BondMapEntry> = { ...GENERATED_BOND_MAP, ...BOND_OVERRIDES };

/**
 * Rejestr obligacji dogranych w RUNTIME (Etap 2 #167) — dodatkowa warstwa poza statycznym
 * `BOND_MAP`. Serwer zasila go z tabeli `bonds` w `price_history.db` (przy starcie) oraz
 * on-demand z detalu obligacje.pl podczas importu, gdy trafi na obligację spoza mapy.
 * Klient nigdy tu nie pisze (klasyfikacja importu jest wyłącznie serwerowa). Statyczna mapa
 * ma PIERWSZEŃSTWO; rejestr tylko WYPEŁNIA luki (brakujące/wykupione serie).
 */
const extraBonds = new Map<string, BondMapEntry>(); // ticker (upper) → entry
const extraBondsByIsin = new Map<string, BondMapEntry>(); // isin (upper) → entry

export function registerExtraBonds(entries: BondMapEntry[]): void {
  for (const e of entries) {
    const ticker = e.ticker?.toUpperCase().trim();
    if (!ticker) continue;
    extraBonds.set(ticker, e);
    if (e.isin) extraBondsByIsin.set(e.isin.toUpperCase().trim(), e);
  }
}

/** Migawka warstwy runtime — do diagnostyki i testów. */
export function getRegisteredExtraBonds(): BondMapEntry[] {
  return [...extraBonds.values()];
}

/** Wyczyść warstwę runtime (re-seed / izolacja testów). */
export function clearExtraBonds(): void {
  extraBonds.clear();
  extraBondsByIsin.clear();
}

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
  const t = ticker.toUpperCase().trim();
  return BOND_MAP[t] ?? extraBonds.get(t) ?? null;
}

export function findBondByIsin(isin: string): BondMapEntry | null {
  const i = isin.toUpperCase().trim();
  return getIsinIndex().get(i) ?? extraBondsByIsin.get(i) ?? null;
}

/**
 * Normalizuje nazwę emitenta obligacji do porównania.
 * "PRAGMAGO D4" → { name: "PRAGMAGO", series: "D4" }
 * "PragmaGO S.A." → { name: "PRAGMAGO", series: undefined }
 */
function normalizeBondIssuerName(raw: string): { name: string; series?: string } {
  const upper = raw.toUpperCase().trim();
  const seriesMatch = upper.match(/^(.+?)\s+([A-Z]\d{1,2})$/);
  const name = seriesMatch
    ? seriesMatch[1]
        .trim()
        .replace(/\s+(?:S\.?A\.?|SP(?:ÓLKA|OLKA)\s+AKCYJNA)\s*$/i, '')
        .trim()
    : upper.replace(/\s+(?:S\.?A\.?|SP(?:ÓLKA|OLKA)\s+AKCYJNA)\s*$/i, '').trim();
  return { name, series: seriesMatch?.[2] ?? undefined };
}

/**
 * Wyszukaj obligację po nazwie emitenta (pole `name` w bond-map).
 * Gdy nazwa zawiera numer serii (np. "PRAGMAGO D4"), najpierw próbuje
 * dopasować po nazwie + serii, potem po samej nazwie (fallback).
 */
export function findBondByName(name: string): BondMapEntry | null {
  const { name: query, series } = normalizeBondIssuerName(name);
  // Pass 1: match name + series
  if (series) {
    for (const entry of Object.values(BOND_MAP)) {
      const entryName = normalizeBondIssuerName(entry.name ?? '');
      if (entryName.name && entryName.name === query && entry.series?.toUpperCase() === series) {
        return entry;
      }
    }
  }
  // Pass 2: match name only (fallback)
  for (const entry of Object.values(BOND_MAP)) {
    const entryName = normalizeBondIssuerName(entry.name ?? '');
    if (entryName.name && entryName.name === query) {
      return entry;
    }
  }
  return null;
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
  if (ticker && extraBonds.has(ticker)) return true;
  if (TREASURY_BOND_RE.test(ticker)) return true;
  if (isin) {
    const i = isin.toUpperCase().trim();
    if (getIsinIndex().has(i)) return true;
    if (extraBondsByIsin.has(i)) return true;
    if (TREASURY_ISIN_RE.test(i)) return true;
  }
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
