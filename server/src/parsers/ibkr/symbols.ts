/**
 * Parsowanie symboli instrumentów z wyciągów IBKR.
 *
 * Opcje w sekcji Trades mają symbol "UNDERLYING DDMMMYY STRIKE C|P" (np. "DKNG 20MAY22 45.0 P")
 * — ten sam format dla opcji USA i Eurex. Sekcja Financial Instrument Information podaje
 * dodatkowo pełny symbol OCC i mnożnik; parser symbolu służy jako fallback, gdy kontraktu
 * nie ma w ContractInfo, oraz do ręcznego dodawania opcji.
 */

export interface ParsedOptionSymbol {
  underlying: string;
  /** YYYY-MM-DD */
  expiry: string;
  strike: number;
  optionType: 'C' | 'P';
}

const MONTHS: Record<string, string> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

const OPTION_SYMBOL_RE = /^(\S+)\s+(\d{2})([A-Z]{3})(\d{2})\s+([\d.]+)\s+([CP])$/;

/** "DKNG 20MAY22 45.0 P" → { underlying: "DKNG", expiry: "2022-05-20", strike: 45, optionType: "P" }. */
export function parseOptionSymbol(symbol: string): ParsedOptionSymbol | null {
  const m = symbol.trim().match(OPTION_SYMBOL_RE);
  if (!m) return null;
  const [, underlying, day, monthName, yy, strikeRaw, right] = m;
  const month = MONTHS[monthName];
  if (!month) return null;
  const strike = Number(strikeRaw);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    underlying,
    expiry: `20${yy}-${month}-${day}`,
    strike,
    optionType: right as 'C' | 'P',
  };
}

/**
 * Ticker w formacie OCC bez paddingu roota — dokładnie taki przyjmuje Yahoo v8 chart
 * (zweryfikowane: /v8/finance/chart/AAPL261218C00250000 zwraca instrumentType OPTION).
 * Strike kodowany jako ×1000 na 8 cyfrach: 45.0 → "00045000", 5.6 → "00005600".
 */
export function toOccTicker(opt: ParsedOptionSymbol): string {
  const [year, month, day] = opt.expiry.split('-');
  const strikeCode = String(Math.round(opt.strike * 1000)).padStart(8, '0');
  return `${opt.underlying}${year.slice(2)}${month}${day}${opt.optionType}${strikeCode}`;
}

/**
 * Pseudo-ISIN kontraktu opcyjnego (opcje giełdowe nie mają ISIN). Prefiks `OPT:` gwarantuje
 * brak kolizji z prawdziwymi ISIN-ami i czytelność w bazie; kolumna `isin` to TEXT bez
 * ograniczenia długości.
 */
export function toOptionPseudoIsin(opt: ParsedOptionSymbol): string {
  return `OPT:${toOccTicker(opt)}`;
}

/**
 * Symbol obligacji w Trades ma doklejony yield ("T 2 7/8 05/15/32 3.92547561%"),
 * a w ContractInfo/CombInt występuje bez niego — klucz do matchowania to część bez yieldu.
 */
export function normalizeBondSymbol(symbol: string): string {
  return symbol
    .trim()
    .replace(/\s+[\d.]+%$/, '')
    .trim();
}

export interface ParsedForexSymbol {
  /** Waluta kupowana/sprzedawana (znak ilości decyduje o kierunku). */
  base: string;
  /** Waluta rozliczenia. */
  quote: string;
}

/** "USD.PLN" → { base: "USD", quote: "PLN" }. */
export function parseForexSymbol(symbol: string): ParsedForexSymbol | null {
  const m = symbol.trim().match(/^([A-Z]{3})\.([A-Z]{3})$/);
  if (!m) return null;
  return { base: m[1], quote: m[2] };
}

/**
 * Normalizuje symbol OCC z ContractInfo ("INTC  240906P00018000" — root padowany spacjami
 * do 6 znaków) do formatu bez paddingu ("INTC240906P00018000") używanego przez Yahoo.
 */
export function normalizeOccSymbol(raw: string): string {
  return raw.replace(/\s+/g, '');
}
