import ExcelJS from 'exceljs';
import type {
  Transaction,
  CashOperation,
  CashOperationAliasTarget,
  OperationType,
  ParseResult,
  SkippedRow,
  SkippedRowRaw,
  InstrumentCategory,
} from 'shared';
import { findCfdTicker } from 'shared';
import type { ParserContext } from './registry.js';
import {
  roundTo2,
  roundFxRate,
  parseNumber,
  detectColumnShift,
  columnShiftWarning,
  rawRowForWarning,
} from './utils.js';

/** Infer CFD category from instrument name using static CFD_TICKER_MAP.
 *  Used as fallback when Closed Positions sheet is missing. */
function inferCategoryFromSymbol(symbol: string): InstrumentCategory | null {
  // Try full symbol first (e.g. "OIL.WTI", "AU200.cash")
  if (findCfdTicker(symbol)) return 'cfd';
  // Try base name without country suffix (e.g. "GOLD" from "GOLD", but NOT "CDR" from "CDR.PL")
  const base = symbol.includes('.') ? symbol.split('.')[0] : symbol;
  if (base !== symbol && findCfdTicker(base)) return 'cfd';
  return null;
}

/**
 * XTB XLSX parser — reads CASH OPERATION HISTORY sheet
 *
 * Operation types handled:
 * - Stock purchase      → Transaction K (extract qty/price from Comment, supports fractional shares)
 * - Stock sale/sell     → Transaction S (extract qty/price from Comment, supports fractional shares)
 * - commission          → matched to transaction by Symbol + Time
 * - Sec Fee             → matched to sell transaction by Symbol + date from Comment
 * - deposit             → CashOperation deposit (also handles IKZE/IKE deposit)
 * - withdrawal          → CashOperation withdrawal
 * - dividend            → CashOperation dividend
 * - withholding tax     → CashOperation fee (tax on dividends)
 * - swap                → CashOperation fee
 * - Tax IFTT            → CashOperation fee (Italian Financial Transaction Tax)
 * - rights issue        → CashOperation other
 * - rollover            → CashOperation fee
 * - Free funds interest → CashOperation other
 * - close trade         → skipped (P/L accounting entry)
 *
 * Type matching is case-insensitive ("Deposit" = "deposit").
 */

// ── Regex patterns ──────────────────────────────────────────────────────────

/** "OPEN BUY 64 @ 16.00" or "OPEN BUY 33/60 @ 35.560" or "OPEN BUY 0.3069 @ 494.15" */
const BUY_RE = /(?:OPEN )?BUY ([\d.]+)(?:\/[\d.]+)? @ ([\d.]+)/;

/** "CLOSE BUY 64 @ 26.07" or "CLOSE BUY 2/4 @ 222.03" or "CLOSE BUY 0.4926 @ 175.20" */
const SELL_RE = /CLOSE BUY ([\d.]+)(?:\/[\d.]+)? @ ([\d.]+)/;

/** "Sec Fee adj PLTR.US 20201201" → symbol=PLTR.US, date=20201201 */
const SEC_FEE_RE = /Sec Fee adj (\S+) (\d{8})/;

// ── Currency mapping ────────────────────────────────────────────────────────

/** Mapa suffix kraju → waluta notowania. Eksportowana: profil generyczny XTB
 *  (xtb-cash-operations.profile) deklaruje ją w quoteCurrencyFromSettlement —
 *  identyczna etykieta pierwszego rzutu to warunek parytetu compare:generic. */
export const SUFFIX_CURRENCY: Record<string, string> = {
  PL: 'PLN',
  US: 'USD',
  NL: 'EUR',
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  UK: 'GBP',
  NO: 'NOK',
  SE: 'SEK',
  DK: 'DKK',
  CH: 'CHF',
  HK: 'HKD',
};

function instrumentCurrency(symbol: string): string {
  const dot = symbol.lastIndexOf('.');
  if (dot === -1) return 'USD';
  const suffix = symbol.slice(dot + 1).toUpperCase();
  return SUFFIX_CURRENCY[suffix] || 'USD';
}

/** Returns the raw suffix (after last dot) if present and NOT mapped in
 * SUFFIX_CURRENCY — i.e. the case where instrumentCurrency silently falls
 * back to USD. Returns null for symbols without suffix or with known suffix. */
function unknownSuffixOf(symbol: string): string | null {
  const dot = symbol.lastIndexOf('.');
  if (dot === -1) return null;
  const suffix = symbol.slice(dot + 1).toUpperCase();
  return SUFFIX_CURRENCY[suffix] ? null : suffix;
}

function normalizeXtbSymbol(symbol: string): string {
  const dot = symbol.lastIndexOf('.');
  return dot === -1 ? symbol : symbol.slice(0, dot);
}

// ── XTB → Yahoo ticker mapping ──────────────────────────────────────────────

const XTB_TO_YAHOO: Record<string, string> = {
  PL: '.WA',
  US: '',
  NL: '.AS',
  DE: '.DE',
  UK: '.L',
  FR: '.PA',
  ES: '.MC',
  IT: '.MI',
  SE: '.ST',
  NO: '.OL',
  DK: '.CO',
  CH: '.SW',
  HK: '.HK',
};

/** Map XTB symbol to Yahoo Finance ticker format for ISIN resolution.
 * "R22.PL" → "R22.WA", "PLTR.US" → "PLTR", "INPST.NL" → "INPST.AS" */
function xtbToYahooTicker(symbol: string): string {
  const dot = symbol.lastIndexOf('.');
  if (dot === -1) return symbol;
  const ticker = symbol.slice(0, dot);
  const suffix = symbol.slice(dot + 1).toUpperCase();
  const yahooSuffix = XTB_TO_YAHOO[suffix];
  return yahooSuffix !== undefined ? ticker + yahooSuffix : ticker;
}

// ── Type normalization ────────────────────────────────────────────────────────

/** Normalize XTB operation type to canonical lowercase form.
 * Handles case variations ("Deposit" vs "deposit") and aliases ("Stock sell" → "Stock sale").
 * Globalne aliasy (ctx, admin-approved) działają TYLKO dla typów, których nie łapią
 * wbudowane mapowania — deterministyczne, przetestowane ALIASES zawsze wygrywają. */
function normalizeType(type: string, ctx?: ParserContext): string {
  const lower = type.toLowerCase();
  // Map aliases to canonical names used by the parser
  const ALIASES: Record<string, string> = {
    'stock sell': 'Stock sale',
    'stock sale': 'Stock sale',
    'stock purchase': 'Stock purchase',
    'close trade': 'close trade',
    deposit: 'deposit',
    withdrawal: 'withdrawal',
    commission: 'commission',
    'sec fee': 'Sec Fee',
    // Accept both space- and hyphen-spelled variants — the PL template uses
    // "Free-funds Interest" / "Free-funds Interest Tax", EN uses space.
    'free funds interest': 'Free funds interest',
    'free-funds interest': 'Free funds interest',
    'free funds interest tax': 'Free funds interest tax',
    'free-funds interest tax': 'Free funds interest tax',
    dividend: 'dividend',
    // PL template has "DIVIDENT" typo
    divident: 'dividend',
    'withholding tax': 'withholding tax',
    swap: 'swap',
    'tax iftt': 'tax iftt',
    'rights issue': 'rights issue',
    rollover: 'rollover',
    'ikze deposit': 'deposit',
    'ike deposit': 'deposit',
    // Currency conversion between XTB sub-accounts
    transfer: 'fx_conversion',
    'currency conversion': 'fx_conversion',
  };
  const builtin = ALIASES[lower];
  if (builtin) return builtin;
  // Globalny alias parser_type: wiersz wchodzi w normalny dispatch (pełne
  // parsowanie Comment/amount). Target walidowany przeciw katalogowi — zły
  // wpis w DB nie może wpuścić wiersza w nieistniejącą gałąź.
  const alias = ctx?.typeAliases?.get(lower.trim());
  if (alias?.kind === 'parser_type' && alias.value && KNOWN_XTB_TYPES.has(alias.value)) {
    return alias.value;
  }
  return type;
}

// ── Commission data extraction (for old-format JSW-like entries) ────────────

/** "BUY 80 @ 19.32" → { qty: 80, price: 19.32 } */
const COMMISSION_BUY_RE = /BUY ([\d.]+) @ ([\d.]+)/;

/** Determine paperName and isin for a raw symbol.
 * Old format: "JSW.PL" → yahooTicker "JSW.WA"
 * New format: "Cyfrowy Polsat" → look up in Closed Positions ticker column,
 *   fall back to company name as placeholder
 *
 * Optional collectors — when provided, the function logs each silent fallback
 * it takes so the caller can surface a single aggregated warning:
 *   unknownSuffixes — raw country suffixes that triggered USD fallback
 *   unknownNames     — new-format company names that triggered PLN placeholder
 */
function resolveSymbolIdentifiers(
  symbol: string,
  tickerLookup?: Map<string, string>,
  unknownSuffixes?: Set<string>,
  unknownNames?: Set<string>,
): { paperName: string; isin: string; currency: string; placeholder: boolean } {
  if (symbol.includes('.') && /\.\w{2}$/.test(symbol)) {
    // Old format: ticker.COUNTRY (e.g., "JSW.PL", "PLTR.US")
    const yahooTicker = xtbToYahooTicker(symbol);
    const badSuffix = unknownSuffixOf(symbol);
    if (badSuffix && unknownSuffixes) unknownSuffixes.add(badSuffix);
    return {
      paperName: yahooTicker,
      isin: yahooTicker,
      currency: instrumentCurrency(symbol),
      placeholder: false,
    };
  }
  // New format: full company name — try Closed Positions ticker lookup first
  const cpTicker = tickerLookup?.get(symbol);
  if (cpTicker) {
    const yahooTicker = xtbToYahooTicker(cpTicker);
    const badSuffix = unknownSuffixOf(cpTicker);
    if (badSuffix && unknownSuffixes) unknownSuffixes.add(badSuffix);
    return {
      paperName: yahooTicker,
      isin: yahooTicker,
      currency: instrumentCurrency(cpTicker),
      placeholder: false,
    };
  }
  // Fallback: use company name as placeholder
  if (unknownNames) unknownNames.add(symbol);
  return { paperName: symbol, isin: symbol, currency: 'PLN', placeholder: true };
}

// ── Detekcja waluty notowania z kwoty rozliczenia ───────────────────────────
//
// Empiria (realne pliki XTB): cena w komentarzu ("OPEN BUY 83 @ 45.73") jest
// ZAWSZE w walucie NOTOWANIA instrumentu, a kolumna Amount ZAWSZE w walucie
// konta — konto PLN kupujące ETF w USD dostaje cenę w USD i debet w PLN.
// Stosunek |Amount|/(qty×price) ≈ 1 → notowanie w walucie konta; wyraźnie
// inny → instrument kwotowany w walucie obcej, a stosunek JEST implikowanym
// kursem rozliczenia (konwencja payment-per-quote, jak Transaction.fxRate).
// Dla sprzedaży Amount to zwrócony nominał OTWARCIA (wartość kupna) — wartość
// sprzedaży w walucie konta = |Amount| + P/L z wiersza "close trade".
//
// Suffix symbolu daje tylko ETYKIETĘ pierwszego rzutu (bywa mylący: ISAC.UK /
// EIMI.UK to klasy USD na LSE) — po imporcie reconcileQuoteCurrencies koryguje
// etykietę do waluty notowania z Yahoo (ticker_map); kwoty i kurs zostają.

/** |implied − 1| ≤ tolerancja → cena w walucie konta. Empirycznie stosunki
 *  same-currency mieszczą się w 0.995–1.0, a najbliższy realny kurs pary to
 *  ~1.05 (EUR/USD). Pary w okolicach parytetu (EUR/USD 2022) mogą wpaść w
 *  tolerancję — wtedy kwoty są niemal identyczne i błąd wyceny ~0. */
const FX_DETECT_TOLERANCE = 0.02;

interface TradeCurrencyDecision {
  currency: string;
  paymentCurrency: string;
  fxRate?: number;
  /** Cena po ewentualnym przeliczeniu na walutę konta (nieznany instrument nowego formatu). */
  price: number;
}

/** Kolektory ostrzeżeń detekcji — agregowane do pojedynczych warningów na końcu parsowania. */
interface FxDetectCollectors {
  /** symbol → etykieta waluty + implikowany kurs pierwszej transakcji + licznik. */
  impliedFx: Map<string, { currency: string; rate: number; count: number }>;
  noAmount: Set<string>;
  anomalies: Set<string>;
  convertedToAccount: Set<string>;
  gbpUnits: Set<string>;
  salesWithoutPl: Set<string>;
  mixedLegs: Set<string>;
}

function newFxDetectCollectors(): FxDetectCollectors {
  return {
    impliedFx: new Map(),
    noAmount: new Set(),
    anomalies: new Set(),
    convertedToAccount: new Set(),
    gbpUnits: new Set(),
    salesWithoutPl: new Set(),
    mixedLegs: new Set(),
  };
}

function resolveTradeCurrency(args: {
  side: 'K' | 'S';
  symbol: string;
  qty: number;
  price: number;
  /** |Amount| wiersza transakcji (waluta konta). */
  amountAbs: number;
  /** P/L z wiersza "close trade" (tylko sprzedaż; undefined gdy brak pary). */
  closePl: number | undefined;
  /**
   * true, gdy plik NIE zawiera żadnych wierszy "close trade" — w tym szablonie
   * (nowy EN z kolumną Ticker, np. eksporty IKE_*) Amount sprzedaży to PEŁNA
   * wartość sprzedaży w walucie konta (zweryfikowane: PEO 0.3507 @ 228.90 →
   * Amount 80.28, ratio 1.0; UBI.FR ratio = EURPLN), nie zwrócony nominał.
   * Stosunek liczy się wtedy wprost, jak dla kupna.
   */
  saleAmountIsFullValue: boolean;
  ids: { currency: string; placeholder: boolean };
  accountCurrency: string;
  /** Pamięć decyzji per symbol — sprzedaż bez close trade dziedziczy etykietę z kupna. */
  symbolFx: Map<string, { foreign: boolean; currency: string }>;
  collectors: FxDetectCollectors;
}): TradeCurrencyDecision {
  const { side, symbol, qty, price, amountAbs, closePl, ids, accountCurrency } = args;
  const sameCurrency: TradeCurrencyDecision = {
    currency: accountCurrency,
    paymentCurrency: accountCurrency,
    price,
  };

  // Kwota rozliczenia w walucie konta odpowiadająca qty×price.
  let settleValue: number | null = null;
  if (!(amountAbs > 0)) {
    args.collectors.noAmount.add(symbol);
  } else if (side === 'K' || args.saleAmountIsFullValue) {
    settleValue = amountAbs;
  } else if (closePl !== undefined && Number.isFinite(closePl)) {
    const v = amountAbs + closePl;
    if (v > 0) settleValue = v;
  }

  if (settleValue === null) {
    if (side === 'S' && amountAbs > 0) {
      // Sprzedaż bez wiersza close trade — stosunek niepoliczalny (Amount to
      // nominał otwarcia). Etykietę dziedziczymy z wcześniejszych transakcji
      // symbolu; kursu nie zgadujemy (silnik użyje kursu dziennego).
      const prev = args.symbolFx.get(symbol);
      if (prev?.foreign) {
        args.collectors.salesWithoutPl.add(symbol);
        return { currency: prev.currency, paymentCurrency: accountCurrency, price };
      }
    }
    return sameCurrency;
  }

  const implied = settleValue / (qty * price);
  if (Math.abs(implied - 1) <= FX_DETECT_TOLERANCE) {
    args.symbolFx.set(symbol, { foreign: false, currency: accountCurrency });
    return sameCurrency;
  }

  // Stosunek wyraźnie ≠ 1 → cena w walucie obcej.
  if (ids.placeholder) {
    // Nowy format bez mapy tickerów — waluta notowania nieznana. Przeliczamy
    // cenę na walutę konta z kwoty rozliczenia (wartości spójne z gotówką).
    args.collectors.convertedToAccount.add(symbol);
    return {
      currency: accountCurrency,
      paymentCurrency: accountCurrency,
      price: settleValue / qty,
    };
  }
  if (ids.currency === accountCurrency) {
    // Suffix twierdzi, że notowanie = waluta konta, a kwoty mówią co innego —
    // anomalia danych; zostawiamy status quo i prosimy o weryfikację.
    args.collectors.anomalies.add(symbol);
    return sameCurrency;
  }

  const fxRate = roundFxRate(implied);
  args.symbolFx.set(symbol, { foreign: true, currency: ids.currency });
  const agg = args.collectors.impliedFx.get(symbol);
  if (agg) agg.count++;
  else args.collectors.impliedFx.set(symbol, { currency: ids.currency, rate: fxRate, count: 1 });
  // GBP z wykrytym FX: Yahoo kwotuje część LSE w pensach (GBp) — bez danych
  // empirycznych nie kodujemy translacji, tylko prosimy o weryfikację jednostki.
  if (ids.currency === 'GBP') args.collectors.gbpUnits.add(symbol);
  return { currency: ids.currency, paymentCurrency: accountCurrency, fxRate, price };
}

// ── Date parsing ────────────────────────────────────────────────────────────

/**
 * Parse XTB time — handles both Excel serial numbers (43769.59) and
 * string format "DD/MM/YYYY HH:MM:SS" → ISO 8601.
 */
function parseXtbTime(time: string | number | Date): string | null {
  // ExcelJS may return Date objects for date-formatted cells
  if (time instanceof Date) {
    const yyyy = time.getFullYear();
    const mm = String(time.getMonth() + 1).padStart(2, '0');
    const dd = String(time.getDate()).padStart(2, '0');
    const hh = String(time.getHours()).padStart(2, '0');
    const mi = String(time.getMinutes()).padStart(2, '0');
    const ss = String(time.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
  }

  // Excel serial number
  if (typeof time === 'number') {
    return excelSerialToISO(time);
  }

  const str = String(time).trim();

  // Try Excel serial from string
  const num = parseFloat(str);
  if (!isNaN(num) && num > 1000 && num < 100000) {
    return excelSerialToISO(num);
  }

  // String format: DD/MM/YYYY HH:MM:SS
  const match = str.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}:\d{2})$/);
  if (!match) return null;
  const [, dd, mm, yyyy, hms] = match;
  return `${yyyy}-${mm}-${dd}T${hms}`;
}

/** Convert Excel serial date to ISO 8601 string */
function excelSerialToISO(serial: number): string {
  // Excel epoch: 1900-01-01 (with the Lotus 123 bug: day 60 = Feb 29, 1900 which doesn't exist)
  // JS epoch offset: 25569 days between 1900-01-01 and 1970-01-01
  const ms = (serial - 25569) * 86400000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

/** "20201201" → "2020-12-01" */
function parseSecFeeDate(yyyymmdd: string): string | null {
  if (yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// ── Format detection ────────────────────────────────────────────────────────

/** Kanoniczne nazwy kolumn arkusza Cash Operation XTB (do walidacji nagłówka). */
const XTB_HEADER_TOKENS = [
  'type',
  'time',
  'amount',
  'comment',
  'symbol',
  'id',
  'instrument',
  'ticker',
];

export async function isXtbFormat(buffer: Buffer): Promise<boolean> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets.find((ws) => ws.name.toUpperCase().includes('CASH OPERATION'));
    if (!sheet) return false;
    // Anti-false-positive: sama nazwa arkusza to za mało — obcy XLSX z arkuszem
    // „CASH OPERATION …" o niezwiązanych kolumnach NIE jest XTB. Wymagaj wiersza
    // nagłówka z ≥2 znanymi kolumnami XTB (skan pierwszych ~20 wierszy).
    let headerLike = false;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerLike || rowNumber > 20) return;
      const cells = (Array.isArray(row.values) ? row.values : [])
        .filter((v) => v != null)
        .map((v) => String(v).trim().toLowerCase());
      if (XTB_HEADER_TOKENS.filter((t) => cells.includes(t)).length >= 2) headerLike = true;
    });
    return headerLike;
  } catch {
    return false;
  }
}

// ── Raw row type ────────────────────────────────────────────────────────────

interface RawRow {
  rowNum: number;
  id: string;
  type: string;
  time: string | number | Date;
  comment: string;
  symbol: string;
  amount: number;
}

/** Surowa treść wiersza dla skrzynki "Do wyjaśnienia" — nagłówki kanoniczne
 * (kolejność jak OLD EN layout), `rawType` = lower(trim) typu PO normalizeType
 * (dla nieznanych typów normalizeType zwraca oryginał — to klucz mapy aliasów). */
function rawRowToSkippedRaw(raw: RawRow, accountCurrency: string): SkippedRowRaw {
  const isoTime = parseXtbTime(raw.time);
  return {
    rawType: raw.type.trim().toLowerCase(),
    headers: ['ID', 'Type', 'Time', 'Comment', 'Symbol', 'Amount'],
    cells: [
      raw.id,
      raw.type,
      isoTime ?? String(raw.time),
      raw.comment,
      raw.symbol,
      String(raw.amount),
    ],
    hint: {
      date: isoTime ? isoTime.slice(0, 10) : undefined,
      amount: raw.amount !== 0 ? raw.amount : undefined,
      currency: accountCurrency,
      symbol: raw.symbol || undefined,
      description: raw.comment || undefined,
    },
  };
}

// ── Header layout detection ────────────────────────────────────────────────
//
// XTB exports Cash Operations with several header layouts we've seen:
//   OLD EN       : ID | Type | Time | Comment | Symbol | Amount
//   NEW EN       : Type | Instrument | Time | Amount | ID | Comment | Product
//   NEW EN+TICKER: Type | Ticker | Instrument | Time | Amount | ID | Comment | Product
//   PL TEMPLATE  : (empty) | ID | Type | Time | Comment | Symbol | Amount  (leading col)
//
// Instead of enumerating every permutation, scan each candidate row for known
// header names via synonyms and build a canonical column → index map. Any
// layout where we can find id/type/time/amount/symbol qualifies.

interface HeaderLayout {
  /** Index into `rows` array where the header sits. */
  headerIdx: number;
  /** Canonical column name → column index within the row. */
  col: { id: number; type: number; time: number; comment: number; symbol: number; amount: number };
}

const HEADER_SYNONYMS = {
  id: ['id'],
  type: ['type'],
  time: ['time'],
  comment: ['comment'],
  // Symbol source: prefer 'Ticker' (broker format like MSFT.US) when present,
  // fall back to 'Instrument' (company name like "Microsoft") or 'Symbol' (PL).
  // We record the winning column as `symbol` regardless of its header label.
  symbol: ['ticker', 'instrument', 'symbol'],
  amount: ['amount'],
} as const;

function detectHeaderLayout(rows: any[][]): HeaderLayout | null {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    if (!row) continue;

    // Build lowercase label → index for this row.
    const labels: Record<string, number> = {};
    for (let j = 0; j < row.length; j++) {
      const cell = row[j]?.toString?.().trim().toLowerCase();
      if (!cell) continue;
      if (!(cell in labels)) labels[cell] = j;
    }

    // Find the best column for each canonical name (first synonym that hits).
    function find(names: readonly string[]): number | null {
      for (const n of names) if (n in labels) return labels[n];
      return null;
    }

    const id = find(HEADER_SYNONYMS.id);
    const type = find(HEADER_SYNONYMS.type);
    const time = find(HEADER_SYNONYMS.time);
    const comment = find(HEADER_SYNONYMS.comment);
    const amount = find(HEADER_SYNONYMS.amount);
    // Symbol source — prefer Ticker > Instrument > Symbol if multiple present.
    let symbol: number | null = null;
    for (const n of HEADER_SYNONYMS.symbol) {
      if (n in labels) {
        symbol = labels[n];
        break;
      }
    }

    if (
      id !== null &&
      type !== null &&
      time !== null &&
      comment !== null &&
      amount !== null &&
      symbol !== null
    ) {
      return { headerIdx: i, col: { id, type, time, comment, symbol, amount } };
    }
  }
  return null;
}

/** Fallback: extract account currency from filename prefix like "USD_52807819_..."
 *  Prefiks IKE_/IKZE_ (eksporty kont emerytalnych, np. "IKE_51152547_...") ZAWSZE
 *  implikuje PLN — konta IKE/IKZE są z definicji prowadzone w złotówkach. */
function currencyFromFileName(fileName: string | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.split(/[\\/]/).pop() || fileName;
  if (/^(IKE|IKZE)_\d+_/i.test(base)) return 'PLN';
  const m = base.match(/^([A-Z]{3})_\d+_/);
  if (!m) return null;
  const cur = m[1];
  // Known XTB base currencies — filter to avoid false positives
  if (['PLN', 'USD', 'EUR', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'HUF', 'CZK'].includes(cur))
    return cur;
  return null;
}

// ── Main parser ─────────────────────────────────────────────────────────────

export async function parseXtbFile(
  buffer: Buffer,
  importBatch: string,
  fileName?: string,
  ctx?: ParserContext,
): Promise<{
  transactions: ParseResult<Transaction>;
  operations: ParseResult<CashOperation>;
  warnings?: string[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  // ── Extract instrument categories and ticker lookup from Closed Positions sheet ──
  const categoryMap = extractCategoryMap(wb);
  const tickerLookup = extractTickerLookup(wb);
  const warnings: string[] = [];
  if (categoryMap.size === 0) {
    const hasClosedSheet = wb.worksheets.some((s) => s.name.toUpperCase().includes('CLOSED'));
    if (!hasClosedSheet) {
      warnings.push(
        'Brak arkusza "Closed Positions" — kategorie instrumentów (CFD/ETF) wykryte heurystycznie z mapy CFD',
      );
    }
  }

  const worksheet = wb.worksheets.find((ws) => ws.name.toUpperCase().includes('CASH OPERATION'));
  if (!worksheet) {
    return {
      transactions: { data: [], skipped: [] },
      operations: { data: [], skipped: [] },
    };
  }

  // Convert to 2D array. ExcelJS preserves column positions (including empty
  // leading columns) — detectHeaderLayout scans every cell for known header
  // names via synonyms, so leading empty columns are handled implicitly.
  // excelRowNums: PRAWDZIWE numery wierszy arkusza (ExcelJS row.number) — indeks
  // w `rows` po includeEmpty:false rozjeżdża się z arkuszem przy pustych wierszach,
  // a numer w skipped/warnings musi pozwolić userowi znaleźć wiersz w pliku.
  const rows: any[][] = [];
  const excelRowNums: number[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    rows.push((row.values as any[]).slice(1));
    excelRowNums.push(rowNumber);
  });

  // ── Extract account currency ──
  // Priority: metadata cell (PLN/USD/EUR/...) > filename prefix ("USD_...") > PLN default.
  const meta = extractAccountCurrency(rows);
  const fromFile = currencyFromFileName(fileName);
  const accountCurrency = meta.detected ? meta.currency : (fromFile ?? 'PLN');
  const accountCurrencyDetected = meta.detected || fromFile !== null;
  if (!accountCurrencyDetected) {
    warnings.push(
      'Nie wykryto waluty konta w metadanych pliku XTB ani w nazwie pliku — przyjęto PLN. ' +
        'Jeśli konto jest prowadzone w innej walucie, zweryfikuj import.',
    );
  }

  // Collectors for silent currency fallbacks used by resolveSymbolIdentifiers
  // (aggregated into one warning each at the end of the parse).
  const unknownSuffixes = new Set<string>();
  const unknownNames = new Set<string>();

  // ── Detect header layout ──
  const layout = detectHeaderLayout(rows);
  if (!layout) {
    return {
      transactions: { data: [], skipped: [] },
      operations: { data: [], skipped: [] },
    };
  }
  const { headerIdx, col } = layout;

  // ── Parse data rows — column indices come from the layout map ──
  const rawRows: RawRow[] = [];
  const structSkipped: SkippedRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const rowNum = excelRowNums[i];

    const typeCell = row[col.type]?.toString().trim() || '';
    if (!typeCell) continue;
    const typeLower = typeCell.toLowerCase();
    if (typeLower === 'total' || typeLower === 'profit/loss') continue;

    const timeVal = row[col.time];
    const time =
      timeVal instanceof Date || typeof timeVal === 'number'
        ? timeVal
        : timeVal?.toString().trim() || '';

    // XLSX nie ma delimitera, więc klasyczne przesunięcie kolumn nie występuje —
    // ale komórka tekstowa w kolumnie Amount (albo obiekt formuły ExcelJS) to ten
    // sam cichy błąd: parseFloat('12abc')=12 wchodziło do DB bez sygnału.
    // Niepusta nie-liczba → skip z ostrzeżeniem; pusta komórka = kwota 0 (jak dotąd).
    const amountRaw = row[col.amount];
    let amount = 0;
    if (typeof amountRaw === 'number') {
      amount = amountRaw;
    } else {
      const amountStr = amountRaw?.toString().trim() || '';
      const shiftProblems = detectColumnShift([
        { label: 'Amount', value: amountStr, kind: 'number' },
      ]);
      if (shiftProblems.length > 0) {
        structSkipped.push({
          row: rowNum,
          reason: 'column_shift',
          paperName: row[col.symbol]?.toString().trim() || typeCell,
        });
        warnings.push(columnShiftWarning(rowNum, shiftProblems, rawRowForWarning(row, ';')));
        continue;
      }
      // parseNumber zamiast parseFloat: tekstowa kwota "1,5" (przecinek dziesiętny)
      // dawała parseFloat=1 — cicho ucięte grosze.
      amount = parseNumber(amountStr);
    }

    rawRows.push({
      rowNum,
      id: row[col.id]?.toString().trim() || '',
      type: normalizeType(typeCell, ctx),
      time,
      comment: row[col.comment]?.toString().trim() || '',
      symbol: row[col.symbol]?.toString().trim() || '',
      amount,
    });
  }

  // ── Pre-pass: Build commission lookup for old-format fallback (JSW) ──
  // Commission rows like "BUY 80 @ 19.32" contain qty/price that can be used
  // when the Stock purchase comment is unparseable ("Order #... cash stock purchase")
  const commissionData = new Map<string, { qty: number; price: number }>();
  for (const raw of rawRows) {
    if (raw.type === 'commission' && raw.symbol) {
      const m = COMMISSION_BUY_RE.exec(raw.comment);
      if (m) {
        const isoTime = parseXtbTime(raw.time);
        if (isoTime) {
          commissionData.set(`${raw.symbol}|${isoTime}`, {
            qty: parseFloat(m[1]),
            price: parseFloat(m[2]),
          });
        }
      }
    }
  }

  // ── Pre-pass: Build close trade P/L lookup (old-format fallback + detekcja FX) ──
  // "close trade" rows contain P/L amounts; paired with "Stock sale" Amount we can
  // derive sale price / implied FX. LISTA per klucz, konsumowana FIFO (takeClosePl):
  // partial fille zamykane w tej samej sekundzie mają ten sam klucz, a każdy ma
  // WŁASNY wiersz close trade — sumowanie pod kluczem wliczałoby każdej sprzedaży
  // cały P/L (np. BABA 2×"CLOSE BUY 2/4" dawało kursy 2.92/2.69 zamiast ~3.66).
  const closeTradePL = new Map<string, number[]>(); // "SYMBOL|ISO_TIME" → [P/L, …]
  for (const raw of rawRows) {
    if (raw.type === 'close trade' && raw.symbol) {
      const isoTime = parseXtbTime(raw.time);
      if (isoTime) {
        const key = `${raw.symbol}|${isoTime}`;
        const list = closeTradePL.get(key);
        if (list) list.push(raw.amount);
        else closeTradePL.set(key, [raw.amount]);
      }
    }
  }
  // Semantyka Amount sprzedaży zależy od szablonu: stary format (są wiersze
  // "close trade") → zwrócony nominał otwarcia; nowy szablon z kolumną Ticker
  // (eksporty IKE_*, zero wierszy close trade w pliku) → pełna wartość
  // sprzedaży. Brak jakiegokolwiek close trade w pliku = wiarygodny sygnał.
  const fileHasCloseTrades = closeTradePL.size > 0;
  const closeTradeCursor = new Map<string, number>();
  /** Zdejmij kolejny niezużyty P/L pod kluczem (FIFO, jak prowizje). */
  const takeClosePl = (key: string): number | undefined => {
    const list = closeTradePL.get(key);
    if (!list) return undefined;
    const i = closeTradeCursor.get(key) ?? 0;
    if (i >= list.length) return undefined;
    closeTradeCursor.set(key, i + 1);
    return list[i];
  };

  // ── Pass 1: Build transactions from Stock purchase / Stock sale ──
  const transactions: Transaction[] = [];
  // Skipy strukturalne (column_shift) idą do listy transakcji — przy zepsutej
  // kolumnie Amount nie wiadomo nawet, czy wiersz był transakcją czy operacją.
  const txSkipped: SkippedRow[] = [...structSkipped];
  const opsSkipped: SkippedRow[] = [];

  // Track transactions by key for commission matching: "SYMBOL|ISO_TIME" → indeksy w transactions[].
  // Tablica (nie pojedynczy indeks): dwa trade'y w tej samej sekundzie (np. partial fills)
  // mają ten sam klucz — każda prowizja konsumuje kolejny niezużyty indeks (FIFO).
  const txBySymbolTime = new Map<string, number[]>();
  const pushTxKey = (key: string, idx: number) => {
    const list = txBySymbolTime.get(key);
    if (list) list.push(idx);
    else txBySymbolTime.set(key, [idx]);
  };
  // Track sell transactions by "SYMBOL|DATE" for Sec Fee matching
  const sellBySymbolDate = new Map<string, number>();
  // Track buy qty per symbol for old-format sale fallback
  const lastBuyQty = new Map<string, number>();
  // Detekcja waluty notowania z kwoty rozliczenia (patrz resolveTradeCurrency)
  const fxCollectors = newFxDetectCollectors();
  const symbolFx = new Map<string, { foreign: boolean; currency: string }>();

  for (const raw of rawRows) {
    if (raw.type === 'Stock purchase') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) {
        txSkipped.push({ row: raw.rowNum, reason: 'invalid_date', paperName: raw.symbol });
        continue;
      }

      let qty: number;
      let price: number;

      const match = BUY_RE.exec(raw.comment);
      if (match) {
        qty = parseFloat(match[1]);
        price = parseFloat(match[2]);
      } else {
        // Fallback: try commission row data ("BUY 80 @ 19.32")
        const commKey = `${raw.symbol}|${isoTime}`;
        const commInfo = commissionData.get(commKey);
        if (commInfo) {
          qty = commInfo.qty;
          price = commInfo.price;
        } else {
          txSkipped.push({
            row: raw.rowNum,
            reason: 'unparseable_comment',
            paperName: raw.symbol,
            raw: rawRowToSkippedRaw(raw, accountCurrency),
          });
          continue;
        }
      }

      if (!Number.isFinite(qty) || qty <= 0) {
        txSkipped.push({ row: raw.rowNum, reason: 'invalid_quantity', paperName: raw.symbol });
        continue;
      }
      if (!Number.isFinite(price) || price <= 0) {
        txSkipped.push({ row: raw.rowNum, reason: 'invalid_price', paperName: raw.symbol });
        continue;
      }

      const ids = resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames);
      // Waluta z kwoty rozliczenia: |Amount| ≈ qty×price → notowanie w walucie
      // konta (m.in. ISAC.UK na koncie USD); wyraźny rozjazd → cena w walucie
      // obcej, stosunek = implikowany kurs (payment-per-quote).
      const decision = resolveTradeCurrency({
        side: 'K',
        symbol: raw.symbol,
        qty,
        price,
        amountAbs: Math.abs(raw.amount),
        closePl: undefined,
        saleAmountIsFullValue: !fileHasCloseTrades,
        ids,
        accountCurrency,
        symbolFx,
        collectors: fxCollectors,
      });
      const value = roundTo2(qty * decision.price);
      const category =
        categoryMap.get(raw.symbol) ?? inferCategoryFromSymbol(raw.symbol) ?? 'stock';

      const idx = transactions.length;
      transactions.push({
        date: isoTime,
        paperName: ids.paperName,
        isin: ids.isin,
        quantity: qty,
        side: 'K',
        price: decision.price,
        value,
        commission: 0,
        total: value,
        currency: decision.currency,
        paymentCurrency: decision.paymentCurrency,
        fxRate: decision.fxRate,
        category,
        source: 'xtb',
        importBatch,
      });
      pushTxKey(`${raw.symbol}|${isoTime}`, idx);
      lastBuyQty.set(raw.symbol, qty);
    } else if (raw.type === 'Stock sale') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) {
        txSkipped.push({ row: raw.rowNum, reason: 'invalid_date', paperName: raw.symbol });
        continue;
      }

      let qty: number;
      let price: number;

      const match = SELL_RE.exec(raw.comment);
      // Ścieżka fallbacku wyprowadza cenę z (|Amount|+P/L)/qty — czyli w walucie
      // KONTA (nie notowania); detekcja waluty jest wtedy pomijana.
      let priceInAccountCurrency = false;

      if (match) {
        qty = parseFloat(match[1]);
        price = parseFloat(match[2]);
      } else {
        // Fallback for old format: "Return position #NNN open nominal value"
        // Use buy qty from the corresponding Stock purchase and derive price from Amount + close trade P/L
        const buyQty = lastBuyQty.get(raw.symbol);
        const plKey = `${raw.symbol}|${isoTime}`;
        // Konsumujemy P/L dopiero gdy buyQty jest znane — nieudany fallback nie
        // może zjeść wiersza close trade innemu partial fillowi pod tym kluczem.
        const pl = buyQty && buyQty > 0 ? takeClosePl(plKey) : undefined;
        if (buyQty && buyQty > 0 && pl !== undefined) {
          // Guards: cena wyprowadzana z (|Amount| + P/L) / qty — każdy składnik
          // musi być policzalny, inaczej NaN/Infinity trafiłoby do outputu.
          if (!Number.isFinite(pl) || !Number.isFinite(raw.amount)) {
            txSkipped.push({ row: raw.rowNum, reason: 'invalid_price', paperName: raw.symbol });
            continue;
          }
          qty = buyQty;
          // Stock sale Amount = original purchase value (returned)
          // close trade Amount = P/L
          // Actual sale value = Amount + P/L
          const saleValue = Math.abs(raw.amount) + pl;
          if (!(saleValue > 0)) {
            txSkipped.push({ row: raw.rowNum, reason: 'invalid_price', paperName: raw.symbol });
            continue;
          }
          price = roundTo2(saleValue / qty);
          if (!Number.isFinite(price) || price <= 0) {
            txSkipped.push({ row: raw.rowNum, reason: 'invalid_price', paperName: raw.symbol });
            continue;
          }
          priceInAccountCurrency = true;
        } else {
          txSkipped.push({
            row: raw.rowNum,
            reason: 'unparseable_comment',
            paperName: raw.symbol,
            raw: rawRowToSkippedRaw(raw, accountCurrency),
          });
          continue;
        }
      }

      if (!Number.isFinite(qty) || qty <= 0) {
        txSkipped.push({ row: raw.rowNum, reason: 'invalid_quantity', paperName: raw.symbol });
        continue;
      }
      if (!Number.isFinite(price) || price <= 0) {
        txSkipped.push({ row: raw.rowNum, reason: 'invalid_price', paperName: raw.symbol });
        continue;
      }

      const ids = resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames);
      let decision: TradeCurrencyDecision;
      if (priceInAccountCurrency) {
        // Cena wyprowadzona z kwot konta — wartości spójne z gotówką w walucie
        // konta. Gdy kupna tego symbolu wykryto jako FX, legi FIFO będą w
        // mieszanych walutach — sygnalizujemy zamiast zgadywać kurs.
        decision = { currency: accountCurrency, paymentCurrency: accountCurrency, price };
        if (symbolFx.get(raw.symbol)?.foreign) fxCollectors.mixedLegs.add(raw.symbol);
      } else {
        decision = resolveTradeCurrency({
          side: 'S',
          symbol: raw.symbol,
          qty,
          price,
          amountAbs: Math.abs(raw.amount),
          closePl: takeClosePl(`${raw.symbol}|${isoTime}`),
          saleAmountIsFullValue: !fileHasCloseTrades,
          ids,
          accountCurrency,
          symbolFx,
          collectors: fxCollectors,
        });
      }
      const value = roundTo2(qty * decision.price);
      const category =
        categoryMap.get(raw.symbol) ?? inferCategoryFromSymbol(raw.symbol) ?? 'stock';

      const idx = transactions.length;
      transactions.push({
        date: isoTime,
        paperName: ids.paperName,
        isin: ids.isin,
        quantity: qty,
        side: 'S',
        price: decision.price,
        value,
        commission: 0,
        total: value,
        currency: decision.currency,
        paymentCurrency: decision.paymentCurrency,
        fxRate: decision.fxRate,
        category,
        source: 'xtb',
        importBatch,
      });
      pushTxKey(`${raw.symbol}|${isoTime}`, idx);
      sellBySymbolDate.set(`${raw.symbol}|${isoTime.slice(0, 10)}`, idx);
    }
  }

  // ── Pass 2: Match commissions and Sec Fees to transactions ──
  const unmatchedFees: RawRow[] = [];
  // FIFO cursor per klucz — n-ta prowizja pod tym samym kluczem trafia do n-tego
  // trade'a. Nadmiarowe prowizje (więcej prowizji niż trade'ów) kumulują się na
  // ostatnim trade'dzie (zachowanie sprzed zmiany dla pojedynczego trade'a).
  const commissionCursor = new Map<string, number>();

  for (const raw of rawRows) {
    if (raw.type === 'commission') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime || !raw.symbol) {
        unmatchedFees.push(raw);
        continue;
      }

      const key = `${raw.symbol}|${isoTime}`;
      const indexes = txBySymbolTime.get(key);
      const idx =
        indexes && indexes.length > 0
          ? indexes[Math.min(commissionCursor.get(key) ?? 0, indexes.length - 1)]
          : undefined;
      if (idx !== undefined) {
        commissionCursor.set(key, (commissionCursor.get(key) ?? 0) + 1);
        const tx = transactions[idx];
        // Prowizja (Amount) jest w walucie KONTA; value/total transakcji przy
        // wykrytym FX są w walucie notowania — przeliczamy przez implikowany
        // kurs, żeby commission/total były jednorodne walutowo.
        const fee =
          tx.fxRate && tx.fxRate > 0
            ? roundTo2(Math.abs(raw.amount) / tx.fxRate)
            : Math.abs(raw.amount);
        tx.commission = roundTo2(tx.commission + fee);
        tx.total = roundTo2(tx.side === 'K' ? tx.value + tx.commission : tx.value - tx.commission);
      } else {
        unmatchedFees.push(raw);
      }
    } else if (raw.type === 'Sec Fee') {
      const sfMatch = SEC_FEE_RE.exec(raw.comment);
      if (!sfMatch) {
        unmatchedFees.push(raw);
        continue;
      }

      const [, symbol, dateStr] = sfMatch;
      const feeDate = parseSecFeeDate(dateStr);
      if (!feeDate) {
        unmatchedFees.push(raw);
        continue;
      }

      const key = `${symbol}|${feeDate}`;
      const idx = sellBySymbolDate.get(key);
      if (idx !== undefined) {
        const tx = transactions[idx];
        // Sec Fee w walucie konta → przeliczenie na walutę notowania jak prowizja.
        const fee =
          tx.fxRate && tx.fxRate > 0
            ? roundTo2(Math.abs(raw.amount) / tx.fxRate)
            : Math.abs(raw.amount);
        tx.commission = roundTo2(tx.commission + fee);
        tx.total = roundTo2(tx.value - tx.commission);
      } else {
        unmatchedFees.push(raw);
      }
    }
  }

  // ── Pre-pass: Build WHT lookup for dividend netting ──
  const whtLookup = new Map<string, { amount: number; comment: string; rowNum: number }>();
  for (const raw of rawRows) {
    if (raw.type === 'withholding tax') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime || !raw.symbol) continue;
      const key = `${raw.symbol}|${isoTime}`;
      whtLookup.set(key, { amount: raw.amount, comment: raw.comment, rowNum: raw.rowNum });
    }
  }
  const usedWht = new Set<string>(); // track paired WHTs

  // ── Pass 3a: Process dividends first (to pair with WHT before WHT is processed) ──
  const operations: CashOperation[] = [];

  for (const raw of rawRows) {
    if (raw.type === 'dividend') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) {
        opsSkipped.push({ row: raw.rowNum, reason: 'invalid_date', paperName: raw.symbol });
        continue;
      }

      const grossAmount = Math.abs(raw.amount);
      let netAmount = grossAmount;
      let description = raw.comment || `Dividend: ${raw.symbol}`;

      // Try to pair with WHT
      const whtKey = `${raw.symbol}|${isoTime}`;
      const wht = whtLookup.get(whtKey);
      if (wht) {
        const whtAbs = Math.abs(wht.amount);
        netAmount = roundTo2(grossAmount - whtAbs);
        const pctMatch = wht.comment.match(/WHT (\d+)%/);
        const pctStr = pctMatch ? ` WHT ${pctMatch[1]}%` : ' WHT';
        description = `${raw.comment} (brutto ${grossAmount},${pctStr} -${whtAbs})`;
        usedWht.add(whtKey);
      }

      operations.push({
        date: isoTime,
        operationType: 'dividend',
        description,
        amount: netAmount,
        currency: accountCurrency,
        ticker: raw.symbol
          ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames)
              .paperName
          : undefined,
        source: 'xtb',
        importBatch,
      });
    }
  }

  // ── Pass 3b: Build remaining cash operations ──
  for (const raw of rawRows) {
    if (raw.type === 'dividend') continue; // already processed in pass 3a

    if (raw.type === 'deposit' || raw.type === 'withdrawal') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) {
        opsSkipped.push({ row: raw.rowNum, reason: 'invalid_date', paperName: raw.comment });
        continue;
      }

      // Kierunek po ZNAKU kwoty, nie po typie wiersza — storno wpłaty (ujemny
      // "deposit") musi trafić jako withdrawal, jak w parserach mBank/Bossa.
      // Wymuszanie znaku przez Math.abs zamieniało korekty w fałszywe wpłaty
      // i zawyżało mianownik MWR.
      operations.push({
        date: isoTime,
        operationType: raw.amount >= 0 ? 'deposit' : 'withdrawal',
        description: raw.comment,
        amount: raw.amount,
        currency: accountCurrency,
        source: 'xtb',
        importBatch,
      });
    } else if (raw.type === 'Free funds interest' || raw.type === 'Free funds interest tax') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) continue;

      operations.push({
        date: isoTime,
        operationType: raw.type.includes('tax') ? 'fee' : 'other',
        description: raw.comment || raw.type,
        amount: raw.amount,
        currency: accountCurrency,
        source: 'xtb',
        importBatch,
      });
    } else if (raw.type === 'withholding tax') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) {
        opsSkipped.push({ row: raw.rowNum, reason: 'invalid_date', paperName: raw.symbol });
        continue;
      }

      // Only create fee if not already paired with a dividend
      const whtKey = `${raw.symbol}|${isoTime}`;
      if (usedWht.has(whtKey)) continue; // already netted into dividend

      operations.push({
        date: isoTime,
        operationType: 'fee',
        description: raw.comment || `Withholding tax: ${raw.symbol}`,
        amount: raw.amount, // negative
        currency: accountCurrency,
        ticker: raw.symbol
          ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames)
              .paperName
          : undefined,
        source: 'xtb',
        importBatch,
      });
    } else if (raw.type === 'swap' || raw.type === 'tax iftt' || raw.type === 'rollover') {
      // Skip for CFD instruments — handled by extractCfdTransactions with authoritative values
      const swapCategory = categoryMap.get(raw.symbol) ?? inferCategoryFromSymbol(raw.symbol);
      if (swapCategory === 'cfd') continue;

      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) continue;

      operations.push({
        date: isoTime,
        operationType: 'trade_fee',
        description: `${raw.type}: ${raw.comment || raw.symbol || ''}`.trim(),
        amount: raw.amount,
        currency: accountCurrency,
        ticker: raw.symbol
          ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames)
              .paperName
          : undefined,
        source: 'xtb',
        importBatch,
      });
    } else if (raw.type === 'rights issue') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) continue;

      operations.push({
        date: isoTime,
        operationType: 'other',
        description: raw.comment || `Rights issue: ${raw.symbol}`,
        amount: raw.amount,
        currency: accountCurrency,
        ticker: raw.symbol
          ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames)
              .paperName
          : undefined,
        source: 'xtb',
        importBatch,
      });
    } else if (raw.type === 'fx_conversion') {
      // Currency conversion between XTB sub-accounts (e.g. PLN→USD subaccount).
      // Raw amount is in the account currency — positive means the sub-account
      // receives funds (external inflow from this sub-account's perspective),
      // negative means it sends funds out.
      //
      // Design decision: treat Transfer as deposit/withdrawal in the account
      // currency rather than a paired fx_exchange. Rationale:
      //   • Single-subaccount portfolio (common case): Transfer IS the only
      //     cash inflow (external zasilenie from user's bank), so it must
      //     trigger firstDepositSeen for the history/chart to render.
      //   • Merged multi-subaccount portfolio: the PLN-side file emits its
      //     own withdrawal leg (raw.amount negative on the sending side),
      //     naturally offsetting this deposit.
      // The stable `[z wymiany walut PAIR @ RATE]` prefix is detected by the
      // client (CashFlowPage) to render an info-tooltip explaining the origin.
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) {
        opsSkipped.push({ row: raw.rowNum, reason: 'invalid_date' });
        continue;
      }

      // Parse the exchange rate + pair from Comment for marker metadata.
      // Unparseable Comment is non-fatal — we still emit the operation with
      // a generic "[z wymiany walut]" marker so no records are silently lost.
      const m = raw.comment.match(
        /\b([A-Z]{3})\s+to\s+([A-Z]{3})\b[^]*?Exchange\s+rate\s*:\s*([\d.]+)/i,
      );
      let marker = '[z wymiany walut]';
      let rate: number | undefined;
      let pair: string | undefined;
      if (m) {
        const [, fromCur, toCur, rateStr] = m;
        const r = parseFloat(rateStr);
        if (r > 0) {
          rate = r;
          pair = `${fromCur}/${toCur}`;
          marker = `[z wymiany walut ${pair} @ ${rate}]`;
        }
      }

      const isCredit = raw.amount > 0;
      operations.push({
        date: isoTime,
        operationType: isCredit ? 'deposit' : 'withdrawal',
        description: `${marker} ${raw.comment}`.trim(),
        amount: isCredit ? Math.abs(raw.amount) : -Math.abs(raw.amount),
        currency: accountCurrency,
        fxRate: rate,
        fxPair: pair,
        source: 'xtb',
        importBatch,
      });
    } else if (raw.type === 'close trade') {
      txSkipped.push({ row: raw.rowNum, reason: 'close_trade_entry', paperName: raw.symbol });
    }
  }

  // Add unmatched fees as CashOperations
  for (const raw of unmatchedFees) {
    const isoTime = parseXtbTime(raw.time);
    if (!isoTime) continue;

    operations.push({
      date: isoTime,
      operationType: 'fee',
      description: `${raw.type}: ${raw.comment}`,
      amount: raw.amount,
      currency: accountCurrency,
      ticker: raw.symbol
        ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames)
            .paperName
        : undefined,
      source: 'xtb',
      importBatch,
    });
  }

  // ── Pass 4: Generate CFD transactions from Closed Positions ──
  // CFD instruments have no Stock purchase/Stock sell in Cash Operations.
  // Build a set of existing transaction keys for deduplication.
  const existingTxKeys = new Set(txBySymbolTime.keys());

  const { transactions: cfdTransactions, unmappedCfd } = extractCfdTransactions(
    wb,
    accountCurrency,
    importBatch,
    existingTxKeys,
  );
  transactions.push(...cfdTransactions);

  // ── Aggregated warnings from silent fallbacks ──────────────────────────
  if (unknownSuffixes.size > 0) {
    warnings.push(
      `Nieznane suffixy kraju w symbolach: ${[...unknownSuffixes].sort().join(', ')} — ` +
        `walutę przyjęto domyślnie jako USD. Zweryfikuj transakcje tych instrumentów.`,
    );
  }
  if (unknownNames.size > 0) {
    const sample = [...unknownNames].slice(0, 5).join(', ');
    const more = unknownNames.size > 5 ? ` (i ${unknownNames.size - 5} innych)` : '';
    warnings.push(
      `Brak mapy tickerów dla ${unknownNames.size} instrumentów (nowy format XTB bez arkusza ` +
        `"Closed Positions"): ${sample}${more}. Walutę ustawiono domyślnie na PLN — zweryfikuj, ` +
        `czy to poprawne dla każdego z tych walorów.`,
    );
  }
  if (unmappedCfd.size > 0) {
    warnings.push(
      `Instrumenty CFD bez mapowania Yahoo (${unmappedCfd.size}): ${[...unmappedCfd].sort().join(', ')}. ` +
        `Wycena historyczna będzie oparta tylko na cenie transakcji (txPrice).`,
    );
  }

  // ── Warningi detekcji waluty notowania (resolveTradeCurrency) ──────────
  if (fxCollectors.impliedFx.size > 0) {
    const list = [...fxCollectors.impliedFx.entries()]
      .map(([sym, i]) => `${sym} → ${i.currency} @ ~${i.rate.toFixed(4)} (${i.count}×)`)
      .sort()
      .join(', ');
    warnings.push(
      `Instrumenty notowane w innej walucie niż konto (${accountCurrency}) — kurs rozliczenia ` +
        `implikowany z kwot XTB: ${list}. Ceny i wartości transakcji pozostają w walucie notowania; ` +
        `etykieta waluty zostanie uzgodniona z notowaniem po imporcie.`,
    );
  }
  if (fxCollectors.salesWithoutPl.size > 0) {
    warnings.push(
      `Sprzedaże bez wiersza "close trade" — walutę notowania przyjęto z wcześniejszych transakcji, ` +
        `a kurs rozliczenia zostanie policzony z kursu dziennego: ` +
        `${[...fxCollectors.salesWithoutPl].sort().join(', ')}.`,
    );
  }
  if (fxCollectors.noAmount.size > 0) {
    warnings.push(
      `Wiersze transakcji bez kwoty rozliczenia (Amount) — walutę konta przyjęto bez weryfikacji: ` +
        `${[...fxCollectors.noAmount].sort().join(', ')}.`,
    );
  }
  if (fxCollectors.anomalies.size > 0) {
    warnings.push(
      `Kwota rozliczenia wyraźnie odbiega od ilość×cena mimo notowania w walucie konta: ` +
        `${[...fxCollectors.anomalies].sort().join(', ')} — zweryfikuj te transakcje.`,
    );
  }
  if (fxCollectors.convertedToAccount.size > 0) {
    warnings.push(
      `Instrumenty bez mapy tickerów z cenami w walucie obcej — ceny przeliczono na walutę konta ` +
        `z kwoty rozliczenia: ${[...fxCollectors.convertedToAccount].sort().join(', ')}.`,
    );
  }
  if (fxCollectors.gbpUnits.size > 0) {
    warnings.push(
      `Instrumenty GBP z wykrytym przewalutowaniem: ${[...fxCollectors.gbpUnits].sort().join(', ')} — ` +
        `zweryfikuj jednostkę notowania (GBp/pensy vs GBP; Yahoo kwotuje część LSE w pensach).`,
    );
  }
  if (fxCollectors.mixedLegs.size > 0) {
    warnings.push(
      `Stary format XTB: sprzedaż rozliczona w walucie konta po kupnie w walucie obcej ` +
        `(mieszane waluty legów FIFO): ${[...fxCollectors.mixedLegs].sort().join(', ')} — ` +
        `zweryfikuj zamknięte pozycje tych instrumentów.`,
    );
  }

  // Raw rows whose `type` matched no dispatch branch: per-row skipped entry
  // (reason 'unknown_type', paperName niesie nazwę typu + symbol, żeby user mógł
  // odnaleźć wiersze w pliku) + jeden zagregowany warning z listą typów.
  const unknownTypes = new Map<string, number>();
  for (const raw of rawRows) {
    if (KNOWN_XTB_TYPES.has(raw.type)) continue;

    // Globalny alias (admin-approved) — konsultowany PRZED oznaczeniem unknown.
    // parser_type obsłużone wcześniej w normalizeType; tu warianty terminalne.
    const alias = ctx?.typeAliases?.get(raw.type.trim().toLowerCase());
    if (alias?.kind === 'ignore') {
      opsSkipped.push({
        row: raw.rowNum,
        reason: 'aliased_ignore',
        paperName: raw.symbol ? `${raw.type} (${raw.symbol})` : raw.type,
      });
      continue;
    }
    if (alias?.kind === 'cash_operation' && alias.value) {
      const op = buildAliasedCashOperation(raw, alias.value, accountCurrency, importBatch);
      if (op) {
        operations.push(op);
        continue;
      }
      // Nieparsowalny target/data → wiersz spada do unknown (skrzynka), nie ginie.
    }

    unknownTypes.set(raw.type, (unknownTypes.get(raw.type) ?? 0) + 1);
    opsSkipped.push({
      row: raw.rowNum,
      reason: 'unknown_type',
      paperName: raw.symbol ? `${raw.type} (${raw.symbol})` : raw.type,
      raw: rawRowToSkippedRaw(raw, accountCurrency),
    });
  }
  if (unknownTypes.size > 0) {
    const list = [...unknownTypes.entries()]
      .map(([t, n]) => `${t} (${n}×)`)
      .sort()
      .join(', ');
    warnings.push(
      `Nierozpoznane typy operacji XTB — pominięte: ${list}. ` +
        `Wiersze znajdziesz w skrzynce „Do wyjaśnienia" — sprawdź, czy któryś nie powinien być zaimportowany.`,
    );
  }

  return {
    transactions: { data: transactions, skipped: txSkipped },
    operations: { data: operations, skipped: opsSkipped },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Dozwolone operationType dla aliasów cash_operation — bez typów specjalnych
 * (fx_exchange wymaga parowania nóg, corporate_action_pending logiki reconciliation). */
const ALIAS_ALLOWED_OPERATION_TYPES = new Set<OperationType>([
  'deposit',
  'withdrawal',
  'dividend',
  'fee',
  'trade_fee',
  'commission_refund',
  'capital_return',
  'other',
]);

/** Buduje CashOperation z surowego wiersza wg targetu aliasu cash_operation
 * (JSON CashOperationAliasTarget). null = target/data nieparsowalne — caller
 * zostawia wiersz w unknown (skrzynka), nic nie ginie po cichu. */
function buildAliasedCashOperation(
  raw: RawRow,
  targetJson: string,
  accountCurrency: string,
  importBatch: string,
): CashOperation | null {
  let target: CashOperationAliasTarget;
  try {
    target = JSON.parse(targetJson);
  } catch {
    return null;
  }
  if (!target?.operationType || !ALIAS_ALLOWED_OPERATION_TYPES.has(target.operationType)) {
    return null;
  }
  const isoTime = parseXtbTime(raw.time);
  if (!isoTime) return null;

  const sign = target.sign ?? 'file';
  const amount =
    sign === 'file' ? raw.amount : sign === '+' ? Math.abs(raw.amount) : -Math.abs(raw.amount);

  return {
    date: isoTime,
    operationType: target.operationType,
    subkind: (target.subkind as CashOperation['subkind']) ?? undefined,
    description: raw.comment || raw.type,
    amount,
    currency: accountCurrency,
    ticker: raw.symbol || undefined,
    source: 'xtb',
    importBatch,
  };
}

/** Canonical operation type names that the main dispatch loop handles.
 * Any `raw.type` not in this set (after normalizeType aliasing) is silently
 * dropped today — we surface it as an aggregated warning instead.
 * Eksportowane: katalog dozwolonych targetów parser_type dla walidacji
 * approve w panelu admina (server/src/parsers/known-types.ts). */
export const KNOWN_XTB_TYPES = new Set<string>([
  'Stock purchase',
  'Stock sale',
  'close trade',
  'deposit',
  'withdrawal',
  'commission',
  'Sec Fee',
  'Free funds interest',
  'Free funds interest tax',
  'dividend',
  'withholding tax',
  'swap',
  'tax iftt',
  'rights issue',
  'rollover',
  'fx_conversion',
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractAccountCurrency(rows: any[][]): { currency: string; detected: boolean } {
  // Look for currency in metadata rows (typically row 6, column 4 "Currency")
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      const cell = row[j]?.toString().trim();
      if (cell === 'PLN' || cell === 'USD' || cell === 'EUR' || cell === 'GBP') {
        return { currency: cell, detected: true };
      }
    }
  }
  return { currency: 'PLN', detected: false };
}

// ── Closed Positions sheet — column resolver ───────────────────────────────
// Multiple XTB templates export this sheet with different column names:
//   EN new    : Instrument | Category | Ticker | Type | Volume | Open Price | Open Time (UTC) | ...
//   PL legacy : Position | Symbol | Type | Volume | Open time | Open price | Close time | Close price | ... | Gross P/L
// Single resolver finds the header row and maps each canonical column to its
// index via synonyms; callers look up `cols.openTime`, `cols.instrument`, etc.

const CP_SYNONYMS: Record<string, readonly string[]> = {
  instrument: ['instrument', 'symbol'],
  type: ['type'],
  volume: ['volume'],
  openPrice: ['open price'],
  closePrice: ['close price'],
  openTime: ['open time (utc)', 'open time'],
  closeTime: ['close time (utc)', 'close time'],
  commission: ['commission'],
  swap: ['swap'],
  rollover: ['rollover'],
  positionId: ['position id', 'position'],
  grossProfit: ['gross profit', 'gross p/l'],
  ticker: ['ticker'],
  category: ['category'],
};

interface ClosedPosLayout {
  headerIdx: number;
  cols: Partial<Record<keyof typeof CP_SYNONYMS, number>>;
}

/** Locate the header row of a Closed Positions sheet and map canonical columns
 * to indices. Requires at minimum instrument/type/volume/openPrice/openTime/
 * closePrice/closeTime to consider a row a valid header. */
function resolveClosedPositionLayout(ws: ExcelJS.Worksheet): ClosedPosLayout | null {
  let best: ClosedPosLayout | null = null;
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (best) return;
    const vals = (row.values as any[]).slice(1);
    const labels: Record<string, number> = {};
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i]?.toString?.().trim().toLowerCase();
      if (v && !(v in labels)) labels[v] = i;
    }
    const cols: ClosedPosLayout['cols'] = {};
    for (const canonical of Object.keys(CP_SYNONYMS) as Array<keyof typeof CP_SYNONYMS>) {
      for (const syn of CP_SYNONYMS[canonical]) {
        if (syn in labels) {
          cols[canonical] = labels[syn];
          break;
        }
      }
    }
    const required: Array<keyof typeof CP_SYNONYMS> = [
      'instrument',
      'type',
      'volume',
      'openPrice',
      'openTime',
      'closePrice',
      'closeTime',
    ];
    if (required.every((k) => cols[k] !== undefined)) {
      best = { headerIdx: rowNum, cols };
    }
  });
  return best;
}

function readNum(v: any): number {
  if (typeof v === 'number') return v;
  return parseFloat(v?.toString() || '0') || 0;
}

/** Extract CFD transactions from Closed Positions sheet.
 * CFD positions have no Stock purchase/Stock sell rows in Cash Operations —
 * all data (volume, prices, times, fees) lives in Closed Positions only.
 *
 * For each CFD row:
 *   Type=BUY (long):  K @ OpenTime/OpenPrice  +  S @ CloseTime/ClosePrice
 *   Type=SELL (short): S @ OpenTime/OpenPrice  +  K @ CloseTime/ClosePrice
 *
 * Commission is attached to the closing transaction.
 * Swap + Rollover are read directly from Closed Positions sheet columns.
 *
 * ZNANE OGRANICZENIE (świadomie poza zakresem fixu walut): ceny open/close CFD
 * kwotowanych natywnie w innej walucie (np. GOLD w USD na koncie PLN) raportujemy
 * w walucie konta bez detekcji z kwot — arkusz Closed Positions nie ma kolumny
 * rozliczenia per leg, a wynik pozycji i tak liczymy z Gross P/L (kolumna w
 * walucie konta, cfdGrossProfit), więc skutek błędnej etykiety jest ograniczony
 * do wyceny historycznej legów. */
function extractCfdTransactions(
  wb: ExcelJS.Workbook,
  accountCurrency: string,
  importBatch: string,
  existingTxKeys: Set<string>,
): { transactions: Transaction[]; unmappedCfd: Set<string> } {
  const unmappedCfd = new Set<string>();
  const ws = wb.worksheets.find((s) => s.name.toUpperCase().includes('CLOSED'));
  if (!ws) return { transactions: [], unmappedCfd };

  const layout = resolveClosedPositionLayout(ws);
  if (!layout) return { transactions: [], unmappedCfd };
  const { headerIdx, cols } = layout;

  const transactions: Transaction[] = [];

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum <= headerIdx) return;
    const vals = (row.values as any[]).slice(1);

    const instrument = vals[cols.instrument!]?.toString?.().trim() || '';
    const posType = vals[cols.type!]?.toString?.().trim()?.toUpperCase() || ''; // BUY or SELL
    if (!instrument || !posType) return;

    // Determine whether this row is a CFD:
    //   - EN template: Category column present → only keep rows with Category='CFD'
    //   - PL template: no Category → infer from CFD ticker map (inferCategoryFromSymbol)
    if (cols.category !== undefined) {
      const cat = vals[cols.category]?.toString?.().trim()?.toUpperCase();
      if (cat !== 'CFD') return;
    } else {
      if (inferCategoryFromSymbol(instrument) !== 'cfd') return;
    }

    const volume = readNum(vals[cols.volume!]);
    const openPrice = readNum(vals[cols.openPrice!]);
    const closePrice = readNum(vals[cols.closePrice!]);
    if (volume <= 0 || openPrice <= 0 || closePrice <= 0) return;

    // Flag CFDs that have no Yahoo mapping — their historical valuation will fall
    // back to txPrice only. Uses the same lookup logic as inferCategoryFromSymbol:
    // try the full symbol first, then the base name without suffix.
    if (!findCfdTicker(instrument)) {
      const base = instrument.includes('.') ? instrument.split('.')[0] : instrument;
      if (base === instrument || !findCfdTicker(base)) {
        unmappedCfd.add(instrument);
      }
    }

    const openTime = parseXtbTime(vals[cols.openTime!]);
    const closeTime = parseXtbTime(vals[cols.closeTime!]);
    if (!openTime || !closeTime) return;

    const commission = cols.commission !== undefined ? Math.abs(readNum(vals[cols.commission])) : 0;
    const swap = cols.swap !== undefined ? Math.abs(readNum(vals[cols.swap])) : 0;
    const rollover = cols.rollover !== undefined ? Math.abs(readNum(vals[cols.rollover])) : 0;

    const positionId =
      cols.positionId !== undefined
        ? vals[cols.positionId]?.toString?.().trim() || undefined
        : undefined;

    const grossProfit =
      cols.grossProfit !== undefined ? readNum(vals[cols.grossProfit]) : undefined;

    // Deduplicate: skip if Cash Operations already has a transaction for this instrument+time
    const openKey = `${instrument}|${openTime}`;
    const closeKey = `${instrument}|${closeTime}`;
    if (existingTxKeys.has(openKey) || existingTxKeys.has(closeKey)) return;

    const openValue = roundTo2(volume * openPrice);
    const closeValue = roundTo2(volume * closePrice);

    // BUY position (long): K at open, S at close
    // SELL position (short): S at open, K at close
    const openSide: 'K' | 'S' = posType === 'BUY' ? 'K' : 'S';
    const closeSide: 'K' | 'S' = posType === 'BUY' ? 'S' : 'K';

    // Opening transaction (no fees) — CFD: quote = payment (rozliczenie = denomination w accountCurrency)
    transactions.push({
      date: openTime,
      paperName: instrument,
      isin: instrument,
      quantity: volume,
      side: openSide,
      price: openPrice,
      value: openValue,
      commission: 0,
      total: openValue,
      currency: accountCurrency,
      paymentCurrency: accountCurrency,
      category: 'cfd',
      source: 'xtb',
      importBatch,
      cfdPositionId: positionId,
    });

    // Closing transaction (commission + swap/rollover embedded)
    transactions.push({
      date: closeTime,
      paperName: instrument,
      isin: instrument,
      quantity: volume,
      side: closeSide,
      price: closePrice,
      value: closeValue,
      commission,
      total:
        closeSide === 'S' ? roundTo2(closeValue - commission) : roundTo2(closeValue + commission),
      currency: accountCurrency,
      paymentCurrency: accountCurrency,
      category: 'cfd',
      source: 'xtb',
      importBatch,
      swap: swap > 0 ? swap : undefined,
      rollover: rollover > 0 ? rollover : undefined,
      cfdPositionId: positionId,
      cfdGrossProfit: grossProfit,
    });
  });

  return { transactions, unmappedCfd };
}

/** Extract instrument category (STOCK/ETF/CFD) from Closed Positions sheet.
 * Returns Map<instrumentName, InstrumentCategory>. Empty when the sheet has
 * no Category column (PL template) — callers fall back to inferCategoryFromSymbol. */
function extractCategoryMap(wb: ExcelJS.Workbook): Map<string, InstrumentCategory> {
  const map = new Map<string, InstrumentCategory>();
  const ws = wb.worksheets.find((s) => s.name.toUpperCase().includes('CLOSED'));
  if (!ws) return map;

  const layout = resolveClosedPositionLayout(ws);
  if (!layout || layout.cols.category === undefined) return map;
  const { headerIdx, cols } = layout;

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum <= headerIdx) return;
    const vals = (row.values as any[]).slice(1);
    const instr = vals[cols.instrument!]?.toString?.().trim();
    const cat = vals[cols.category!]?.toString?.().trim()?.toLowerCase();
    if (instr && cat) {
      if (cat === 'cfd') map.set(instr, 'cfd');
      else if (cat === 'etf') map.set(instr, 'etf');
      else map.set(instr, 'stock');
    }
  });

  return map;
}

/** Extract instrument name → XTB ticker mapping from Closed Positions sheet.
 * e.g. "Grupa Kęty" → "KTY.PL", "Synektik" → "SNT.PL"
 * Used to resolve new-format company names to Yahoo-compatible tickers.
 * Returns empty map when the sheet has no Ticker column (PL template). */
function extractTickerLookup(wb: ExcelJS.Workbook): Map<string, string> {
  const map = new Map<string, string>();
  const ws = wb.worksheets.find((s) => s.name.toUpperCase().includes('CLOSED'));
  if (!ws) return map;

  const layout = resolveClosedPositionLayout(ws);
  if (!layout || layout.cols.ticker === undefined) return map;
  const { headerIdx, cols } = layout;

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum <= headerIdx) return;
    const vals = (row.values as any[]).slice(1);
    const instr = vals[cols.instrument!]?.toString?.().trim();
    const ticker = vals[cols.ticker!]?.toString?.().trim();
    if (instr && ticker && instr !== ticker) {
      // Only store if instrument name differs from ticker (new format)
      map.set(instr, ticker);
    }
  });

  return map;
}
