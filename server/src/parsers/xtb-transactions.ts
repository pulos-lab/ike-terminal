import * as XLSX from 'xlsx';
import type { Transaction, CashOperation, ParseResult, SkippedRow } from 'shared';

/**
 * XTB XLSX parser — reads CASH OPERATION HISTORY sheet
 *
 * Operation types handled:
 * - Stock purchase → Transaction K (extract qty/price from Comment)
 * - Stock sale     → Transaction S (extract qty/price from Comment)
 * - commission     → matched to transaction by Symbol + Time
 * - Sec Fee        → matched to sell transaction by Symbol + date from Comment
 * - deposit        → CashOperation deposit
 * - withdrawal     → CashOperation withdrawal
 * - close trade    → skipped (P/L accounting entry)
 */

// ── Regex patterns ──────────────────────────────────────────────────────────

/** "OPEN BUY 64 @ 16.00" or "OPEN BUY 33/60 @ 35.560" */
const BUY_RE = /(?:OPEN )?BUY (\d+)(?:\/\d+)? @ ([\d.]+)/;

/** "CLOSE BUY 64 @ 26.07" or "CLOSE BUY 2/4 @ 222.03" */
const SELL_RE = /CLOSE BUY (\d+)(?:\/\d+)? @ ([\d.]+)/;

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

// ── Commission data extraction (for old-format JSW-like entries) ────────────

/** "BUY 80 @ 19.32" → { qty: 80, price: 19.32 } */
const COMMISSION_BUY_RE = /BUY (\d+) @ ([\d.]+)/;

/** Determine paperName and isin for a raw symbol.
 * Old format: "JSW.PL" → yahooTicker "JSW.WA"
 * New format: "Cyfrowy Polsat" → use as-is (resolved by findIsinByName) */
function resolveSymbolIdentifiers(symbol: string): { paperName: string; isin: string; currency: string } {
  if (symbol.includes('.') && /\.\w{2}$/.test(symbol)) {
    // Old format: ticker.COUNTRY (e.g., "JSW.PL", "PLTR.US")
    const yahooTicker = xtbToYahooTicker(symbol);
    return { paperName: yahooTicker, isin: yahooTicker, currency: instrumentCurrency(symbol) };
  }
  // New format: full company name — use as paperName/isin placeholder
  // Currency defaults to PLN for Polish company names
  return { paperName: symbol, isin: symbol, currency: 'PLN' };
}

// ── Date parsing ────────────────────────────────────────────────────────────

/**
 * Parse XTB time — handles both Excel serial numbers (43769.59) and
 * string format "DD/MM/YYYY HH:MM:SS" → ISO 8601.
 */
function parseXtbTime(time: string | number): string | null {
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

export function isXtbFormat(buffer: Buffer): boolean {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    return wb.SheetNames.some(name =>
      name.toUpperCase().includes('CASH OPERATION')
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
  time: string | number;
  comment: string;
  symbol: string;
  amount: number;
}

// ── Main parser ─────────────────────────────────────────────────────────────

export function parseXtbFile(
  buffer: Buffer,
  importBatch: string,
): { transactions: ParseResult<Transaction>; operations: ParseResult<CashOperation> } {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  const sheetName = wb.SheetNames.find(n =>
    n.toUpperCase().includes('CASH OPERATION')
  );
  if (!sheetName) {
    return {
      transactions: { data: [], skipped: [] },
      operations: { data: [], skipped: [] },
    };
  }

  const sheet = wb.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // ── Extract account currency from metadata rows (1-8) ──
  const accountCurrency = extractAccountCurrency(rows);

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
    if (col0 === 'Total' || col0 === 'Profit/loss' || col0 === '') continue;

    if (isNewFormat) {
      // New format: Type[0], Instrument[1], Time[2], Amount[3], ID[4], Comment[5]
      const amountVal = typeof row[3] === 'number' ? row[3] : parseFloat(row[3]?.toString() || '0') || 0;
      rawRows.push({
        rowNum: i + 1,
        id: row[4]?.toString().trim() || '',
        type: col0,
        time: typeof row[2] === 'number' ? row[2] : row[2]?.toString().trim() || '',
        comment: row[5]?.toString().trim() || '',
        symbol: row[1]?.toString().trim() || '', // Instrument = full company name
        amount: amountVal,
      });
    } else {
      // Old format: ID[0], Type[1], Time[2], Comment[3], Symbol[4], Amount[5]
      rawRows.push({
        rowNum: i + 1,
        id: col0,
        type: row[1]?.toString().trim() || '',
        time: typeof row[2] === 'number' ? row[2] : row[2]?.toString().trim() || '',
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
            qty: parseInt(m[1], 10),
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
        qty = parseInt(match[1], 10);
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

      const ids = resolveSymbolIdentifiers(raw.symbol);
      const value = round2(qty * price);

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
        currency: ids.currency,
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
        qty = parseInt(match[1], 10);
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
          price = round2(saleValue / qty);
        } else {
          txSkipped.push({ row: raw.rowNum, reason: 'unparseable_comment', paperName: raw.symbol });
          continue;
        }
      }

      if (qty <= 0) { txSkipped.push({ row: raw.rowNum, reason: 'invalid_quantity', paperName: raw.symbol }); continue; }
      if (price <= 0) { txSkipped.push({ row: raw.rowNum, reason: 'invalid_price', paperName: raw.symbol }); continue; }

      const ids = resolveSymbolIdentifiers(raw.symbol);
      const value = round2(qty * price);

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
        currency: ids.currency,
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
        transactions[idx].commission = round2(transactions[idx].commission + fee);
        transactions[idx].total = round2(
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
        transactions[idx].commission = round2(transactions[idx].commission + fee);
        transactions[idx].total = round2(transactions[idx].value - transactions[idx].commission);
      } else {
        unmatchedFees.push(raw);
      }
    }
  }

  // ── Pass 3: Build cash operations ──
  const operations: CashOperation[] = [];

  for (const raw of rawRows) {
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
      ticker: raw.symbol ? resolveSymbolIdentifiers(raw.symbol).paperName : undefined,
      source: 'xtb',
      importBatch,
    });
  }

  // Add summary row skip
  const totalRow = rawRows.length > 0 ? rawRows[rawRows.length - 1] : null;
  // (Total row is already filtered out in parsing, no action needed)

  return {
    transactions: { data: transactions, skipped: txSkipped },
    operations: { data: operations, skipped: opsSkipped },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractAccountCurrency(rows: any[][]): string {
  // Look for currency in metadata rows (typically row 6, column 4 "Currency")
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      const cell = row[j]?.toString().trim();
      if (cell === 'PLN' || cell === 'USD' || cell === 'EUR' || cell === 'GBP') {
        return cell;
      }
    }
  }
  return 'PLN';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
