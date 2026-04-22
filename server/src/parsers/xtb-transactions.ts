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
    'free funds interest': 'Free funds interest',
    'free funds interest tax': 'Free funds interest tax',
    'dividend': 'dividend',
    'withholding tax': 'withholding tax',
    'swap': 'swap',
    'tax iftt': 'tax iftt',
    'rights issue': 'rights issue',
    'rollover': 'rollover',
    'ikze deposit': 'deposit',
    'ike deposit': 'deposit',
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

// ── Main parser ─────────────────────────────────────────────────────────────

export async function parseXtbFile(
  buffer: Buffer,
  importBatch: string,
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

  // Convert to 2D array (equivalent to xlsx sheet_to_json with header:1)
  // ExcelJS preserves column positions (including empty leading columns),
  // while xlsx's sheet_to_json trimmed them. Find the first data column
  // from the header row and shift all rows to match the old behavior.
  const rawRows2d: any[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    rawRows2d.push((row.values as any[]).slice(1));
  });

  // Detect leading empty columns offset from the header row (ID/Type in col 0)
  let colOffset = 0;
  for (const row of rawRows2d) {
    const col0 = row[0]?.toString?.().trim();
    const col1 = row[1]?.toString?.().trim();
    if ((col0 === 'ID' && col1 === 'Type') || (col0 === 'Type' && col1 === 'Instrument')) {
      break; // data starts at index 0 — no offset needed
    }
    if ((col1 === 'ID' && row[2]?.toString?.().trim() === 'Type') ||
        (col1 === 'Type' && row[2]?.toString?.().trim() === 'Instrument')) {
      colOffset = 1;
      break;
    }
  }

  const rows: any[][] = colOffset > 0
    ? rawRows2d.map(r => r.slice(colOffset))
    : rawRows2d;

  // ── Extract account currency from metadata rows (1-8) ──
  const { currency: accountCurrency, detected: accountCurrencyDetected } = extractAccountCurrency(rows);
  if (!accountCurrencyDetected) {
    warnings.push(
      'Nie wykryto waluty konta w metadanych pliku XTB — przyjęto PLN. ' +
      'Jeśli konto jest prowadzone w innej walucie, zweryfikuj import.',
    );
  }

  // Collectors for silent currency fallbacks used by resolveSymbolIdentifiers
  // (aggregated into one warning each at the end of the parse).
  const unknownSuffixes = new Set<string>();
  const unknownNames = new Set<string>();

  // ── Detect format and find header row ──
  // Old format: headers start with "ID, Type, ..."
  // New format: headers start with "Type, Instrument, ..."
  let headerIdx = -1;
  let isNewFormat = false;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i];
    if (!row) continue;
    const col0 = row[0]?.toString().trim();
    const col1 = row[1]?.toString().trim();
    if (col0 === 'ID' && col1 === 'Type') {
      headerIdx = i;
      isNewFormat = false;
      break;
    }
    if (col0 === 'Type' && col1 === 'Instrument') {
      headerIdx = i;
      isNewFormat = true;
      break;
    }
  }

  if (headerIdx === -1) {
    return {
      transactions: { data: [], skipped: [] },
      operations: { data: [], skipped: [] },
    };
  }

  // ── Parse data rows ──
  // Old format columns: ID[0], Type[1], Time[2], Comment[3], Symbol[4], Amount[5]
  // New format columns: Type[0], Instrument[1], Time[2], Amount[3], ID[4], Comment[5], Product[6]
  const rawRows: RawRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;

    const col0 = row[0]?.toString().trim() || '';
    const col0Lower = col0.toLowerCase();
    if (col0Lower === 'total' || col0Lower === 'profit/loss' || col0 === '') continue;

    if (isNewFormat) {
      // New format: Type[0], Instrument[1], Time[2], Amount[3], ID[4], Comment[5]
      const amountVal = typeof row[3] === 'number' ? row[3] : parseFloat(row[3]?.toString() || '0') || 0;
      rawRows.push({
        rowNum: i + 1,
        id: row[4]?.toString().trim() || '',
        type: normalizeType(col0),
        time: row[2] instanceof Date || typeof row[2] === 'number' ? row[2] : row[2]?.toString().trim() || '',
        comment: row[5]?.toString().trim() || '',
        symbol: row[1]?.toString().trim() || '', // Instrument = full company name
        amount: amountVal,
      });
    } else {
      // Old format: ID[0], Type[1], Time[2], Comment[3], Symbol[4], Amount[5]
      rawRows.push({
        rowNum: i + 1,
        id: col0,
        type: normalizeType(row[1]?.toString().trim() || ''),
        time: row[2] instanceof Date || typeof row[2] === 'number' ? row[2] : row[2]?.toString().trim() || '',
        comment: row[3]?.toString().trim() || '',
        symbol: row[4]?.toString().trim() || '',
        amount: typeof row[5] === 'number' ? row[5] : parseFloat(row[5]?.toString() || '0') || 0,
      });
    }
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
        currency: ids.currency,               // quote — z suffixu symbolu (.US→USD, .PL→PLN, .DE→EUR)
        paymentCurrency: accountCurrency,     // XTB account base — z metadanych XLSX
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
        currency: ids.currency,               // quote — z suffixu symbolu
        paymentCurrency: accountCurrency,     // XTB account base
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

  return {
    transactions: { data: transactions, skipped: txSkipped },
    operations: { data: operations, skipped: opsSkipped },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

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

  // Find header row and column indices
  let headerIdx = -1;
  const cols: Record<string, number> = {};
  const NEEDED = ['Instrument', 'Category', 'Type', 'Volume', 'Open Price', 'Open Time (UTC)', 'Close Price', 'Close Time (UTC)', 'Commission', 'Swap', 'Rollover', 'Position ID', 'Gross Profit'];

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (headerIdx !== -1) return;
    const vals = (row.values as any[]).slice(1);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i]?.toString?.().trim();
      if (v && NEEDED.includes(v)) cols[v] = i;
    }
    if (cols['Instrument'] !== undefined && cols['Category'] !== undefined) headerIdx = rowNum;
  });

  if (headerIdx === -1) return { transactions: [], unmappedCfd };

  const transactions: Transaction[] = [];

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum <= headerIdx) return;
    const vals = (row.values as any[]).slice(1);

    const cat = vals[cols['Category']]?.toString?.().trim()?.toUpperCase();
    if (cat !== 'CFD') return;

    const instrument = vals[cols['Instrument']]?.toString?.().trim() || '';
    const posType = vals[cols['Type']]?.toString?.().trim()?.toUpperCase() || ''; // BUY or SELL
    const volume = typeof vals[cols['Volume']] === 'number' ? vals[cols['Volume']] : parseFloat(vals[cols['Volume']]?.toString() || '0');
    const openPrice = typeof vals[cols['Open Price']] === 'number' ? vals[cols['Open Price']] : parseFloat(vals[cols['Open Price']]?.toString() || '0');
    const closePrice = typeof vals[cols['Close Price']] === 'number' ? vals[cols['Close Price']] : parseFloat(vals[cols['Close Price']]?.toString() || '0');
    const openTimeRaw = vals[cols['Open Time (UTC)']];
    const closeTimeRaw = vals[cols['Close Time (UTC)']];

    if (!instrument || !posType || volume <= 0 || openPrice <= 0 || closePrice <= 0) return;

    // Flag CFDs that have no Yahoo mapping — their historical valuation will fall
    // back to txPrice only. Uses the same lookup logic as inferCategoryFromSymbol:
    // try the full symbol first, then the base name without suffix.
    if (!findCfdTicker(instrument)) {
      const base = instrument.includes('.') ? instrument.split('.')[0] : instrument;
      if (base === instrument || !findCfdTicker(base)) {
        unmappedCfd.add(instrument);
      }
    }

    const openTime = parseXtbTime(openTimeRaw);
    const closeTime = parseXtbTime(closeTimeRaw);
    if (!openTime || !closeTime) return;

    const commission = Math.abs(typeof vals[cols['Commission']] === 'number' ? vals[cols['Commission']] : parseFloat(vals[cols['Commission']]?.toString() || '0') || 0);

    // Read swap/rollover directly from Closed Positions sheet columns
    const swap = Math.abs(typeof vals[cols['Swap']] === 'number' ? vals[cols['Swap']] : parseFloat(vals[cols['Swap']]?.toString() || '0') || 0);
    const rollover = Math.abs(typeof vals[cols['Rollover']] === 'number' ? vals[cols['Rollover']] : parseFloat(vals[cols['Rollover']]?.toString() || '0') || 0);

    // Position ID for unique FIFO grouping (prevents mixing overlapping CFD positions)
    const positionId = cols['Position ID'] !== undefined ? vals[cols['Position ID']]?.toString?.().trim() : undefined;

    // Gross Profit — actual P/L from price movement (includes contract multiplier + FX conversion, before swap/rollover/commission)
    const grossProfit = cols['Gross Profit'] !== undefined
      ? (typeof vals[cols['Gross Profit']] === 'number' ? vals[cols['Gross Profit']] : parseFloat(vals[cols['Gross Profit']]?.toString() || '0') || 0)
      : undefined;

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
 * Returns Map<instrumentName, InstrumentCategory> */
function extractCategoryMap(wb: ExcelJS.Workbook): Map<string, InstrumentCategory> {
  const map = new Map<string, InstrumentCategory>();
  const ws = wb.worksheets.find(s =>
    s.name.toUpperCase().includes('CLOSED')
  );
  if (!ws) return map;

  // Find header row with "Instrument" and "Category"
  let headerIdx = -1;
  let instrCol = -1;
  let catCol = -1;
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (headerIdx !== -1) return;
    const vals = (row.values as any[]).slice(1);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i]?.toString?.().trim();
      if (v === 'Instrument') instrCol = i;
      if (v === 'Category') catCol = i;
    }
    if (instrCol !== -1 && catCol !== -1) headerIdx = rowNum;
  });

  if (headerIdx === -1) return map;

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum <= headerIdx) return;
    const vals = (row.values as any[]).slice(1);
    const instr = vals[instrCol]?.toString?.().trim();
    const cat = vals[catCol]?.toString?.().trim()?.toLowerCase();
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
 * Used to resolve new-format company names to Yahoo-compatible tickers. */
function extractTickerLookup(wb: ExcelJS.Workbook): Map<string, string> {
  const map = new Map<string, string>();
  const ws = wb.worksheets.find(s => s.name.toUpperCase().includes('CLOSED'));
  if (!ws) return map;

  let headerIdx = -1;
  let instrCol = -1;
  let tickerCol = -1;
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (headerIdx !== -1) return;
    const vals = (row.values as any[]).slice(1);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i]?.toString?.().trim();
      if (v === 'Instrument') instrCol = i;
      if (v === 'Ticker') tickerCol = i;
    }
    if (instrCol !== -1 && tickerCol !== -1) headerIdx = rowNum;
  });

  if (headerIdx === -1) return map;

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum <= headerIdx) return;
    const vals = (row.values as any[]).slice(1);
    const instr = vals[instrCol]?.toString?.().trim();
    const ticker = vals[tickerCol]?.toString?.().trim();
    if (instr && ticker && instr !== ticker) {
      // Only store if instrument name differs from ticker (new format)
      map.set(instr, ticker);
    }
  });

  return map;
}

