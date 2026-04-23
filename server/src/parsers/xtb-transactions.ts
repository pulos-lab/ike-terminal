import ExcelJS from 'exceljs';
import type { Transaction, CashOperation, ParseResult, SkippedRow, InstrumentCategory } from 'shared';
import { findCfdTicker } from 'shared';
import { roundTo2 } from './utils.js';

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

const SUFFIX_CURRENCY: Record<string, string> = {
  PL: 'PLN', US: 'USD', NL: 'EUR', DE: 'EUR', FR: 'EUR',
  ES: 'EUR', IT: 'EUR', UK: 'GBP', NO: 'NOK', SE: 'SEK',
  DK: 'DKK', CH: 'CHF', HK: 'HKD',
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
  PL: '.WA', US: '', NL: '.AS', DE: '.DE', UK: '.L',
  FR: '.PA', ES: '.MC', IT: '.MI', SE: '.ST', NO: '.OL',
  DK: '.CO', CH: '.SW', HK: '.HK',
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
 * Handles case variations ("Deposit" vs "deposit") and aliases ("Stock sell" → "Stock sale"). */
function normalizeType(type: string): string {
  const lower = type.toLowerCase();
  // Map aliases to canonical names used by the parser
  const ALIASES: Record<string, string> = {
    'stock sell': 'Stock sale',
    'stock sale': 'Stock sale',
    'stock purchase': 'Stock purchase',
    'close trade': 'close trade',
    'deposit': 'deposit',
    'withdrawal': 'withdrawal',
    'commission': 'commission',
    'sec fee': 'Sec Fee',
    // Accept both space- and hyphen-spelled variants — the PL template uses
    // "Free-funds Interest" / "Free-funds Interest Tax", EN uses space.
    'free funds interest': 'Free funds interest',
    'free-funds interest': 'Free funds interest',
    'free funds interest tax': 'Free funds interest tax',
    'free-funds interest tax': 'Free funds interest tax',
    'dividend': 'dividend',
    // PL template has "DIVIDENT" typo
    'divident': 'dividend',
    'withholding tax': 'withholding tax',
    'swap': 'swap',
    'tax iftt': 'tax iftt',
    'rights issue': 'rights issue',
    'rollover': 'rollover',
    'ikze deposit': 'deposit',
    'ike deposit': 'deposit',
    // Currency conversion between XTB sub-accounts
    'transfer': 'fx_conversion',
    'currency conversion': 'fx_conversion',
  };
  return ALIASES[lower] || type;
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
): { paperName: string; isin: string; currency: string } {
  if (symbol.includes('.') && /\.\w{2}$/.test(symbol)) {
    // Old format: ticker.COUNTRY (e.g., "JSW.PL", "PLTR.US")
    const yahooTicker = xtbToYahooTicker(symbol);
    const badSuffix = unknownSuffixOf(symbol);
    if (badSuffix && unknownSuffixes) unknownSuffixes.add(badSuffix);
    return { paperName: yahooTicker, isin: yahooTicker, currency: instrumentCurrency(symbol) };
  }
  // New format: full company name — try Closed Positions ticker lookup first
  const cpTicker = tickerLookup?.get(symbol);
  if (cpTicker) {
    const yahooTicker = xtbToYahooTicker(cpTicker);
    const badSuffix = unknownSuffixOf(cpTicker);
    if (badSuffix && unknownSuffixes) unknownSuffixes.add(badSuffix);
    return { paperName: yahooTicker, isin: yahooTicker, currency: instrumentCurrency(cpTicker) };
  }
  // Fallback: use company name as placeholder
  if (unknownNames) unknownNames.add(symbol);
  return { paperName: symbol, isin: symbol, currency: 'PLN' };
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

export async function isXtbFormat(buffer: Buffer): Promise<boolean> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb.worksheets.some(ws =>
      ws.name.toUpperCase().includes('CASH OPERATION')
    );
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
      if (n in labels) { symbol = labels[n]; break; }
    }

    if (id !== null && type !== null && time !== null && comment !== null && amount !== null && symbol !== null) {
      return { headerIdx: i, col: { id, type, time, comment, symbol, amount } };
    }
  }
  return null;
}

/** Fallback: extract account currency from filename prefix like "USD_52807819_..." */
function currencyFromFileName(fileName: string | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.split(/[\\/]/).pop() || fileName;
  const m = base.match(/^([A-Z]{3})_\d+_/);
  if (!m) return null;
  const cur = m[1];
  // Known XTB base currencies — filter to avoid false positives
  if (['PLN', 'USD', 'EUR', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'HUF', 'CZK'].includes(cur)) return cur;
  return null;
}

// ── Main parser ─────────────────────────────────────────────────────────────

export async function parseXtbFile(
  buffer: Buffer,
  importBatch: string,
  fileName?: string,
): Promise<{ transactions: ParseResult<Transaction>; operations: ParseResult<CashOperation>; warnings?: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  // ── Extract instrument categories and ticker lookup from Closed Positions sheet ──
  const categoryMap = extractCategoryMap(wb);
  const tickerLookup = extractTickerLookup(wb);
  const warnings: string[] = [];
  if (categoryMap.size === 0) {
    const hasClosedSheet = wb.worksheets.some(s => s.name.toUpperCase().includes('CLOSED'));
    if (!hasClosedSheet) {
      warnings.push('Brak arkusza "Closed Positions" — kategorie instrumentów (CFD/ETF) wykryte heurystycznie z mapy CFD');
    }
  }

  const worksheet = wb.worksheets.find(ws =>
    ws.name.toUpperCase().includes('CASH OPERATION')
  );
  if (!worksheet) {
    return {
      transactions: { data: [], skipped: [] },
      operations: { data: [], skipped: [] },
    };
  }

  // Convert to 2D array. ExcelJS preserves column positions (including empty
  // leading columns) — detectHeaderLayout scans every cell for known header
  // names via synonyms, so leading empty columns are handled implicitly.
  const rows: any[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    rows.push((row.values as any[]).slice(1));
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
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const typeCell = row[col.type]?.toString().trim() || '';
    if (!typeCell) continue;
    const typeLower = typeCell.toLowerCase();
    if (typeLower === 'total' || typeLower === 'profit/loss') continue;

    const timeVal = row[col.time];
    const time = timeVal instanceof Date || typeof timeVal === 'number'
      ? timeVal
      : timeVal?.toString().trim() || '';
    const amountRaw = row[col.amount];
    const amount = typeof amountRaw === 'number'
      ? amountRaw
      : parseFloat(amountRaw?.toString() || '0') || 0;

    rawRows.push({
      rowNum: i + 1,
      id: row[col.id]?.toString().trim() || '',
      type: normalizeType(typeCell),
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

  // ── Pre-pass: Build close trade P/L lookup for old-format sale fallback ──
  // "close trade" rows contain P/L amounts; paired with "Stock sale" Amount we can derive sale price
  const closeTradePL = new Map<string, number>(); // "SYMBOL|ISO_TIME" → P/L amount
  for (const raw of rawRows) {
    if (raw.type === 'close trade' && raw.symbol) {
      const isoTime = parseXtbTime(raw.time);
      if (isoTime) {
        const key = `${raw.symbol}|${isoTime}`;
        closeTradePL.set(key, (closeTradePL.get(key) || 0) + raw.amount);
      }
    }
  }

  // ── Pass 1: Build transactions from Stock purchase / Stock sale ──
  const transactions: Transaction[] = [];
  const txSkipped: SkippedRow[] = [];
  const opsSkipped: SkippedRow[] = [];

  // Track transactions by key for commission matching: "SYMBOL|ISO_TIME" → index in transactions[]
  const txBySymbolTime = new Map<string, number>();
  // Track sell transactions by "SYMBOL|DATE" for Sec Fee matching
  const sellBySymbolDate = new Map<string, number>();
  // Track buy qty per symbol for old-format sale fallback
  const lastBuyQty = new Map<string, number>();

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
          txSkipped.push({ row: raw.rowNum, reason: 'unparseable_comment', paperName: raw.symbol });
          continue;
        }
      }

      if (qty <= 0) { txSkipped.push({ row: raw.rowNum, reason: 'invalid_quantity', paperName: raw.symbol }); continue; }
      if (price <= 0) { txSkipped.push({ row: raw.rowNum, reason: 'invalid_price', paperName: raw.symbol }); continue; }

      const ids = resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames);
      const value = roundTo2(qty * price);
      const category = categoryMap.get(raw.symbol) ?? inferCategoryFromSymbol(raw.symbol) ?? 'stock';

      const idx = transactions.length;
      transactions.push({
        date: isoTime,
        paperName: ids.paperName,
        isin: ids.isin,
        quantity: qty,
        side: 'K',
        price,
        value,
        commission: 0,
        total: value,
        // XTB model: jedno sub-konto = jedna waluta. XLSX raportuje CENY I KWOTY
        // w walucie konta, nawet dla instrumentów notowanych natywnie gdzie indziej
        // (np. ISAC.UK to USD Acc share class — cena w USD mimo suffixu .UK).
        // Ustawienie currency z suffixu symbolu prowadziło do rozjazdu z Yahoo
        // quote.currency (zapisanym w tickerMap) i powodowało, że engine skipował
        // transakcje w cash-flow oraz wpisywał bilans do fantomowej waluty.
        currency: accountCurrency,
        paymentCurrency: accountCurrency,
        category,
        source: 'xtb',
        importBatch,
      });
      txBySymbolTime.set(`${raw.symbol}|${isoTime}`, idx);
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
      if (match) {
        qty = parseFloat(match[1]);
        price = parseFloat(match[2]);
      } else {
        // Fallback for old format: "Return position #NNN open nominal value"
        // Use buy qty from the corresponding Stock purchase and derive price from Amount + close trade P/L
        const buyQty = lastBuyQty.get(raw.symbol);
        const plKey = `${raw.symbol}|${isoTime}`;
        const pl = closeTradePL.get(plKey);
        if (buyQty && buyQty > 0 && pl !== undefined) {
          qty = buyQty;
          // Stock sale Amount = original purchase value (returned)
          // close trade Amount = P/L
          // Actual sale value = Amount + P/L
          const saleValue = Math.abs(raw.amount) + pl;
          price = roundTo2(saleValue / qty);
        } else {
          txSkipped.push({ row: raw.rowNum, reason: 'unparseable_comment', paperName: raw.symbol });
          continue;
        }
      }

      if (qty <= 0) { txSkipped.push({ row: raw.rowNum, reason: 'invalid_quantity', paperName: raw.symbol }); continue; }
      if (price <= 0) { txSkipped.push({ row: raw.rowNum, reason: 'invalid_price', paperName: raw.symbol }); continue; }

      const ids = resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames);
      const value = roundTo2(qty * price);
      const category = categoryMap.get(raw.symbol) ?? inferCategoryFromSymbol(raw.symbol) ?? 'stock';

      const idx = transactions.length;
      transactions.push({
        date: isoTime,
        paperName: ids.paperName,
        isin: ids.isin,
        quantity: qty,
        side: 'S',
        price,
        value,
        commission: 0,
        total: value,
        // XTB model: cena i kwota w walucie konta (patrz komentarz w Stock purchase).
        currency: accountCurrency,
        paymentCurrency: accountCurrency,
        category,
        source: 'xtb',
        importBatch,
      });
      txBySymbolTime.set(`${raw.symbol}|${isoTime}`, idx);
      sellBySymbolDate.set(`${raw.symbol}|${isoTime.slice(0, 10)}`, idx);
    }
  }

  // ── Pass 2: Match commissions and Sec Fees to transactions ──
  const unmatchedFees: RawRow[] = [];

  for (const raw of rawRows) {
    if (raw.type === 'commission') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime || !raw.symbol) { unmatchedFees.push(raw); continue; }

      const key = `${raw.symbol}|${isoTime}`;
      const idx = txBySymbolTime.get(key);
      if (idx !== undefined) {
        const fee = Math.abs(raw.amount);
        transactions[idx].commission = roundTo2(transactions[idx].commission + fee);
        transactions[idx].total = roundTo2(
          transactions[idx].side === 'K'
            ? transactions[idx].value + transactions[idx].commission
            : transactions[idx].value - transactions[idx].commission,
        );
      } else {
        unmatchedFees.push(raw);
      }

    } else if (raw.type === 'Sec Fee') {
      const sfMatch = SEC_FEE_RE.exec(raw.comment);
      if (!sfMatch) { unmatchedFees.push(raw); continue; }

      const [, symbol, dateStr] = sfMatch;
      const feeDate = parseSecFeeDate(dateStr);
      if (!feeDate) { unmatchedFees.push(raw); continue; }

      const key = `${symbol}|${feeDate}`;
      const idx = sellBySymbolDate.get(key);
      if (idx !== undefined) {
        const fee = Math.abs(raw.amount);
        transactions[idx].commission = roundTo2(transactions[idx].commission + fee);
        transactions[idx].total = roundTo2(transactions[idx].value - transactions[idx].commission);
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
      if (!isoTime) { opsSkipped.push({ row: raw.rowNum, reason: 'invalid_date', paperName: raw.symbol }); continue; }

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
        ticker: raw.symbol ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames).paperName : undefined,
        source: 'xtb',
        importBatch,
      });
    }
  }

  // ── Pass 3b: Build remaining cash operations ──
  for (const raw of rawRows) {
    if (raw.type === 'dividend') continue; // already processed in pass 3a

    if (raw.type === 'deposit') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) { opsSkipped.push({ row: raw.rowNum, reason: 'invalid_date', paperName: raw.comment }); continue; }

      operations.push({
        date: isoTime,
        operationType: 'deposit',
        description: raw.comment,
        amount: Math.abs(raw.amount),
        currency: accountCurrency,
        source: 'xtb',
        importBatch,
      });

    } else if (raw.type === 'withdrawal') {
      const isoTime = parseXtbTime(raw.time);
      if (!isoTime) { opsSkipped.push({ row: raw.rowNum, reason: 'invalid_date', paperName: raw.comment }); continue; }

      operations.push({
        date: isoTime,
        operationType: 'withdrawal',
        description: raw.comment,
        amount: -Math.abs(raw.amount), // negative for withdrawal
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
      if (!isoTime) { opsSkipped.push({ row: raw.rowNum, reason: 'invalid_date', paperName: raw.symbol }); continue; }

      // Only create fee if not already paired with a dividend
      const whtKey = `${raw.symbol}|${isoTime}`;
      if (usedWht.has(whtKey)) continue; // already netted into dividend

      operations.push({
        date: isoTime,
        operationType: 'fee',
        description: raw.comment || `Withholding tax: ${raw.symbol}`,
        amount: raw.amount, // negative
        currency: accountCurrency,
        ticker: raw.symbol ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames).paperName : undefined,
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
        ticker: raw.symbol ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames).paperName : undefined,
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
        ticker: raw.symbol ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames).paperName : undefined,
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
      if (!isoTime) { opsSkipped.push({ row: raw.rowNum, reason: 'invalid_date' }); continue; }

      // Parse the exchange rate + pair from Comment for marker metadata.
      // Unparseable Comment is non-fatal — we still emit the operation with
      // a generic "[z wymiany walut]" marker so no records are silently lost.
      const m = raw.comment.match(/\b([A-Z]{3})\s+to\s+([A-Z]{3})\b[^]*?Exchange\s+rate\s*:\s*([\d.]+)/i);
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
      ticker: raw.symbol ? resolveSymbolIdentifiers(raw.symbol, tickerLookup, unknownSuffixes, unknownNames).paperName : undefined,
      source: 'xtb',
      importBatch,
    });
  }

  // ── Pass 4: Generate CFD transactions from Closed Positions ──
  // CFD instruments have no Stock purchase/Stock sell in Cash Operations.
  // Build a set of existing transaction keys for deduplication.
  const existingTxKeys = new Set(txBySymbolTime.keys());

  const { transactions: cfdTransactions, unmappedCfd } = extractCfdTransactions(
    wb, accountCurrency, importBatch, existingTxKeys,
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

  // Aggregated warning for raw rows whose `type` matched no dispatch branch.
  // Until now these rows silently disappeared (no skipped entry, no operation).
  const unknownTypes = new Map<string, number>();
  for (const raw of rawRows) {
    if (!KNOWN_XTB_TYPES.has(raw.type)) {
      unknownTypes.set(raw.type, (unknownTypes.get(raw.type) ?? 0) + 1);
    }
  }
  if (unknownTypes.size > 0) {
    const list = [...unknownTypes.entries()]
      .map(([t, n]) => `${t} (${n}×)`)
      .sort()
      .join(', ');
    warnings.push(
      `Nierozpoznane typy operacji XTB — pominięte cicho: ${list}. ` +
      `Sprawdź czy któryś nie powinien być zaimportowany.`,
    );
  }

  return {
    transactions: { data: transactions, skipped: txSkipped },
    operations: { data: operations, skipped: opsSkipped },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Canonical operation type names that the main dispatch loop handles.
 * Any `raw.type` not in this set (after normalizeType aliasing) is silently
 * dropped today — we surface it as an aggregated warning instead. */
const KNOWN_XTB_TYPES = new Set<string>([
  'Stock purchase', 'Stock sale', 'close trade',
  'deposit', 'withdrawal', 'commission', 'Sec Fee',
  'Free funds interest', 'Free funds interest tax',
  'dividend', 'withholding tax',
  'swap', 'tax iftt', 'rights issue', 'rollover',
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
        if (syn in labels) { cols[canonical] = labels[syn]; break; }
      }
    }
    const required: Array<keyof typeof CP_SYNONYMS> =
      ['instrument', 'type', 'volume', 'openPrice', 'openTime', 'closePrice', 'closeTime'];
    if (required.every(k => cols[k] !== undefined)) {
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
 * Swap + Rollover are read directly from Closed Positions sheet columns. */
function extractCfdTransactions(
  wb: ExcelJS.Workbook,
  accountCurrency: string,
  importBatch: string,
  existingTxKeys: Set<string>,
): { transactions: Transaction[]; unmappedCfd: Set<string> } {
  const unmappedCfd = new Set<string>();
  const ws = wb.worksheets.find(s => s.name.toUpperCase().includes('CLOSED'));
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
    const swap       = cols.swap       !== undefined ? Math.abs(readNum(vals[cols.swap]))       : 0;
    const rollover   = cols.rollover   !== undefined ? Math.abs(readNum(vals[cols.rollover]))   : 0;

    const positionId = cols.positionId !== undefined
      ? vals[cols.positionId]?.toString?.().trim() || undefined
      : undefined;

    const grossProfit = cols.grossProfit !== undefined ? readNum(vals[cols.grossProfit]) : undefined;

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
      total: closeSide === 'S'
        ? roundTo2(closeValue - commission)
        : roundTo2(closeValue + commission),
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
  const ws = wb.worksheets.find(s => s.name.toUpperCase().includes('CLOSED'));
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
  const ws = wb.worksheets.find(s => s.name.toUpperCase().includes('CLOSED'));
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

