/**
 * Parsowanie symboli instrumentów z wyciągów IBKR.
 *
 * Opcje w sekcji Trades mają symbol "UNDERLYING DDMMMYY STRIKE C|P" (np. "DKNG 20MAY22 45.0 P")
 * — ten sam format dla opcji USA i Eurex. Sekcja Financial Instrument Information podaje
 * dodatkowo pełny symbol OCC i mnożnik; parser symbolu służy jako fallback, gdy kontraktu
 * nie ma w ContractInfo, oraz do ręcznego dodawania opcji.
 */

export {
  parseOptionSymbol,
  toOccTicker,
  toOptionPseudoIsin,
  type ParsedOptionSymbol,
} from 'shared';

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
