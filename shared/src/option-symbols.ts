/**
 * Symbole kontraktów opcyjnych — współdzielone między parserem IBKR (server),
 * ręcznym dodawaniem transakcji (server routes + client dialog) i wycenami.
 *
 * Kanoniczny identyfikator kontraktu w aplikacji:
 * - ticker OCC bez paddingu roota: SYMBOL + YYMMDD + C/P + strike×1000 na 8 cyfrach
 *   (np. "DKNG220520P00045000") — dokładnie ten format przyjmuje Yahoo v8 chart;
 * - pseudo-ISIN = `OPT:` + ticker OCC (opcje giełdowe nie mają ISIN).
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

/** Symbol IBKR "DKNG 20MAY22 45.0 P" → { underlying, expiry: "2022-05-20", strike: 45, optionType: "P" }. */
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

/** Ticker OCC bez paddingu — akceptowany wprost przez Yahoo v8 chart. Strike 5.6 → "00005600". */
export function toOccTicker(opt: ParsedOptionSymbol): string {
  const [year, month, day] = opt.expiry.split('-');
  const strikeCode = String(Math.round(opt.strike * 1000)).padStart(8, '0');
  return `${opt.underlying.toUpperCase()}${year.slice(2)}${month}${day}${opt.optionType}${strikeCode}`;
}

/** Pseudo-ISIN kontraktu — prefiks `OPT:` gwarantuje brak kolizji z prawdziwymi ISIN-ami. */
export function toOptionPseudoIsin(opt: ParsedOptionSymbol): string {
  return `OPT:${toOccTicker(opt)}`;
}

/** Czytelna etykieta kontraktu: "DKNG 45 PUT 2022-05-20". */
export function optionDisplayName(opt: ParsedOptionSymbol): string {
  return `${opt.underlying.toUpperCase()} ${opt.strike} ${opt.optionType === 'C' ? 'CALL' : 'PUT'} ${opt.expiry}`;
}
