import Papa from 'papaparse';
import type { Transaction, ParseResult, SkippedRow } from 'shared';
import { parseNumber, roundTo2 } from './utils.js';

/**
 * Parse DEGIRO Transactions CSV.
 *
 * Supports two format variants:
 *
 * OLD format (19 columns, ~2021):
 *   Data,Czas,Produkt,ISIN,Giełda referenc,Miejsce wykonania,Liczba,Kurs,,
 *   Wartość lokalna,,Wartość,,Kurs wymian,Opłata transakcyjna,,Razem,,
 *   Identyfikator zlecenia
 *
 * NEW format (17-18 columns, ~2022+):
 *   Data,Czas,Produkt,ISIN,Giełda referencyjna,Miejsce wykonania,Liczba,Kurs,,
 *   Wartość lokalna,,Wartość EUR,Kurs wymiany,Opłaty AutoFX,
 *   Opłata transakcyjna DEGIRO i/lub opłata stron,Razem EUR,
 *   Identyfikator zlecenia,
 *
 * Common columns (same position in both formats):
 *   0  Data                    - date DD-MM-YYYY
 *   1  Czas                    - time HH:MM
 *   2  Produkt                 - product name
 *   3  ISIN                    - ISIN
 *   4  Giełda referenc(yjna)   - reference exchange
 *   5  Miejsce wykonania       - execution venue
 *   6  Liczba                  - quantity (negative=sell, positive=buy)
 *   7  Kurs                    - price per share
 *   8  (currency)              - currency of price
 *   9  Wartość lokalna         - local value (qty * price)
 *  10  (currency)              - currency of local value
 *
 * Fee column differs:
 *   OLD: col[14] = Opłata transakcyjna (value), col[15] = currency
 *   NEW: dynamically found by header name containing "opłata transakcyjna"
 *
 * Side detection:
 *   - Liczba > 0 → BUY (K)
 *   - Liczba < 0 → SELL (S) (includes short sells)
 */

interface ColumnMap {
  fee: number; // index of fee column
  fxRate: number; // index of "Kurs wymiany" (NEW format), -1 if not present
}

export function parseDegiroTransactions(
  csvContent: string,
  importBatch: string,
): ParseResult<Transaction> {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ',',
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  if (rows.length < 2) return { data: [], skipped: [] };

  const header = rows[0];
  if (!isDegiroHeader(header)) return { data: [], skipped: [] };

  // Dynamically find fee column by header name
  const colMap = mapColumns(header);

  const transactions: Transaction[] = [];
  const skipped: SkippedRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1; // 1-based
    const product = row ? row[2]?.trim() : undefined;

    if (!row || row.length < 14) {
      skipped.push({ row: rowNum, reason: 'short_row', paperName: product });
      continue;
    }

    const dateStr = row[0]?.trim();
    const timeStr = row[1]?.trim();
    const isin = row[3]?.trim();
    const liczba = parseNumber(row[6]);
    const price = parseNumber(row[7]);
    const priceCurrency = row[8]?.trim();
    const localValue = parseNumber(row[9]);
    const fee = parseNumber(row[colMap.fee]);
    const fxRateRaw = colMap.fxRate >= 0 ? parseNumber(row[colMap.fxRate]) : 0;

    if (!dateStr) {
      skipped.push({ row: rowNum, reason: 'missing_date', paperName: product });
      continue;
    }
    if (!product) {
      skipped.push({ row: rowNum, reason: 'missing_name' });
      continue;
    }
    if (!isin) {
      skipped.push({ row: rowNum, reason: 'missing_isin', paperName: product });
      continue;
    }
    if (liczba === 0) {
      skipped.push({ row: rowNum, reason: 'invalid_quantity', paperName: product });
      continue;
    }

    // Skip corporate actions (e.g. SPAC mergers) where price is 0
    if (price === 0 && localValue !== 0) {
      skipped.push({ row: rowNum, reason: 'corporate_action', paperName: product });
      continue;
    }

    // Determine side from sign of Liczba
    const side: 'K' | 'S' = liczba > 0 ? 'K' : 'S';
    const quantity = Math.abs(liczba); // keep fractional shares
    const absPrice = Math.abs(price);

    if (quantity <= 0) {
      skipped.push({ row: rowNum, reason: 'invalid_quantity', paperName: product });
      continue;
    }
    if (absPrice <= 0) {
      skipped.push({ row: rowNum, reason: 'invalid_price', paperName: product });
      continue;
    }

    // Use the trade currency (from the price column), not the account EUR
    const currency = normalizeCurrency(priceCurrency || 'EUR');
    const isGbx = (priceCurrency || '').toUpperCase().trim() === 'GBX';

    // GBX prices are in pence — convert to GBP (÷100) for consistent cash balances
    const effectivePrice = isGbx ? roundTo2(absPrice / 100) : absPrice;
    const value = roundTo2(quantity * effectivePrice);

    // DEGIRO charges commission separately in EUR (via "DEGIRO Opłata Transakcyjna"
    // entries in Account.csv), NOT in the trade currency. Setting commission=0 here
    // prevents double-counting; the EUR fee is imported as a fee operation instead.
    const commission = 0;

    // Total = value only (commission is tracked separately in EUR)
    const total = value;

    const isoDate = parseDegiroDate(dateStr, timeStr);

    transactions.push({
      date: isoDate,
      paperName: product,
      isin,
      quantity,
      side,
      price: effectivePrice,
      value,
      commission,
      total,
      currency, // quote — z kolumny 8 (priceCurrency)
      paymentCurrency: 'EUR', // default — DEGIRO base account EUR; faktyczna waluta
      // rozliczenia wyliczana post-insert przez
      // reconcilePaymentCurrencies() (symulacja salda walut).
      // Z wyłączonym auto-FX user może trzymać PLN/USD i płacić
      // bezpośrednio z salda danej waluty.
      fxRate: fxRateRaw > 0 ? fxRateRaw : undefined, // z NEW format "Kurs wymiany"; undefined dla OLD format
      source: 'degiro',
      importBatch,
    });
  }

  return { data: transactions, skipped };
}

/**
 * Detect if CSV content looks like DEGIRO Transactions format.
 * Supports both old and new header variants.
 */
export function isDegiroFormat(csvContent: string): boolean {
  const firstLine = csvContent.split('\n')[0] || '';
  const lower = firstLine.toLowerCase();
  // Must have DEGIRO-specific columns
  if (!lower.includes('produkt') || !lower.includes('isin')) return false;
  // Old format: "kurs wymian" (abbreviated), new format: "kurs wymiany" or "opłaty autofx"
  return lower.includes('kurs wymian') || lower.includes('opłaty autofx');
}

/**
 * Validate the header row contains expected DEGIRO column names.
 */
function isDegiroHeader(header: string[]): boolean {
  if (!header || header.length < 14) return false;
  const h0 = header[0]?.trim().toLowerCase();
  const h2 = header[2]?.trim().toLowerCase();
  const h3 = header[3]?.trim().toLowerCase();
  return h0 === 'data' && h2 === 'produkt' && h3 === 'isin';
}

/**
 * Dynamically map column indices by searching header names.
 * Falls back to fixed index 14 (old format) if no match found.
 */
function mapColumns(header: string[]): ColumnMap {
  let feeIdx = 14; // default for old format
  let fxRateIdx = -1;

  for (let i = 0; i < header.length; i++) {
    const name = header[i]?.trim().toLowerCase() || '';
    if (
      (name.includes('opłata transakcyjna') || name.includes('oplata transakcyjna')) &&
      feeIdx === 14
    ) {
      feeIdx = i;
    }
    // NEW format: "Kurs wymiany" / "Exchange Rate"
    if (fxRateIdx === -1 && (name.includes('kurs wymiany') || name.includes('exchange rate'))) {
      fxRateIdx = i;
    }
  }

  return { fee: feeIdx, fxRate: fxRateIdx };
}

/**
 * Parse DEGIRO date (DD-MM-YYYY) + time (HH:MM) to ISO 8601.
 */
function parseDegiroDate(dateStr: string, timeStr?: string): string {
  const match = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (match) {
    const time = timeStr ? `${timeStr}:00` : '00:00:00';
    return `${match[3]}-${match[2]}-${match[1]}T${time}`;
  }
  return dateStr;
}

/**
 * Normalize currency codes.
 * GBX (pence) → GBP, NO → NOK.
 */
function normalizeCurrency(currency: string): string {
  const upper = currency.toUpperCase().trim();
  if (upper === 'GBX') return 'GBP';
  if (upper === 'NO') return 'NOK';
  return upper || 'EUR';
}
