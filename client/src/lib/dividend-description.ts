/**
 * Skraca opis auto-dywidendy do prezentacji. Skaner (dividend-scanner.ts) generuje
 * teraz krótki opis "0.525 USD/szt · podatek 19%", ale rekordy zaimportowane wcześniej
 * mają długą, rozwlekłą formę:
 *   "Dywidenda META (8.881784197001252e-16 szt. × 0.525 USD, podatek 19% [zwykłe])"
 * Ten helper normalizuje starą formę na krótką bez potrzeby re-importu; wszystkie inne
 * opisy (ręczne "Wypłata dywidendy X", kupony, DEGIRO) zostawia bez zmian.
 */
// Auto-skaner (stara, długa forma): "Dywidenda META (8.8e-16 szt. × 0.525 USD, podatek 19% [zwykłe])"
const LEGACY_AUTO_DIVIDEND =
  /^Dywidenda\s+\S+\s+\([\d.eE+-]+\s+szt\.\s+×\s+([\d.]+)\s+(\w+),\s+podatek\s+(\d+)%\s*(?:\[[^\]]*\])?\)$/;

// Import IBKR: "MA(US57636Q1040) Cash Dividend USD 0.76 per Share (podatek 15%)"
const IBKR_DIVIDEND =
  /^\S+\([A-Z0-9]+\)\s+Cash Dividend\s+(\w+)\s+([\d.]+)\s+per Share(?:\s+\(podatek\s+(\d+)%\))?/i;

export function formatDividendDescription(description: string): string {
  const legacy = description.match(LEGACY_AUTO_DIVIDEND);
  if (legacy) {
    const [, perShare, currency, taxPct] = legacy;
    return `${perShare} ${currency}/szt · podatek ${taxPct}%`;
  }
  const ibkr = description.match(IBKR_DIVIDEND);
  if (ibkr) {
    const [, currency, perShare, taxPct] = ibkr;
    return taxPct
      ? `${perShare} ${currency}/szt · podatek ${taxPct}%`
      : `${perShare} ${currency}/szt`;
  }
  return description;
}
