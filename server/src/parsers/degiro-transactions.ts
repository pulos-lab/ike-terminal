import Papa from 'papaparse';
import type { Transaction, ParseResult, SkippedRow } from 'shared';

/**
 * Parse DEGIRO Transactions CSV.
 *
 * Format: comma-delimited, UTF-8 encoding.
 *
 * Headers (Polish locale):
 *   Data,Czas,Produkt,ISIN,Giełda referenc,Miejsce wykonania,Liczba,Kurs,,
 *   Wartość lokalna,,Wartość,,Kurs wymian,Opłata transakcyjna,,Razem,,
 *   Identyfikator zlecenia
 *
 * Empty-name columns are currency columns that follow their corresponding value column.
 * E.g. col[7]=Kurs (price), col[8]=currency of price (PLN/USD/EUR/etc.)
 *
 * Column layout (0-indexed):
 *   0  Data                    - date DD-MM-YYYY
 *   1  Czas                    - time HH:MM
 *   2  Produkt                 - product name
 *   3  ISIN                    - ISIN (directly provided!)
 *   4  Giełda referenc         - reference exchange (WSE, NDQ, NSY, EPA, etc.)
 *   5  Miejsce wykonania       - execution venue (XWAR, CDED, ARCX, etc.)
 *   6  Liczba                  - quantity (negative=sell, positive=buy)
 *   7  Kurs                    - price per share
 *   8  (currency)              - currency of price
 *   9  Wartość lokalna         - local value (qty * price)
 *  10  (currency)              - currency of local value
 *  11  Wartość                 - value in EUR (account currency)
 *  12  (currency)              - always EUR
 *  13  Kurs wymian             - FX rate (empty for EUR trades)
 *  14  Opłata transakcyjna     - transaction fee (negative or zero)
 *  15  (currency)              - currency of fee
 *  16  Razem                   - total (value + fee) in EUR
 *  17  (currency)              - always EUR
 *  18  Identyfikator zlecenia  - order ID (UUID)
 *
 * Side detection:
 *   - Liczba > 0 AND Wartość lokalna < 0 → BUY (K)  (money going out)
 *   - Liczba < 0 AND Wartość lokalna > 0 → SELL (S)  (money coming in)
 *   - Corporate actions (e.g. SPAC mergers): Liczba sign + Wartość lokalna sign
 *
 * Short selling: DEGIRO allows short selling — a sell (negative Liczba) before
 * a buy is a short sale. Our K/S model handles this correctly.
 *
 * Partial fills: Same order ID may appear across multiple rows.
 * We import each row as a separate transaction (preserving the actual fills).
 */

export function parseDegiroTransactions(csvContent: string, importBatch: string): ParseResult<Transaction> {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ',',
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  if (rows.length < 2) return { data: [], skipped: [] };

  // Validate header row
  const header = rows[0];
  if (!isDegiroHeader(header)) return { data: [], skipped: [] };

  const transactions: Transaction[] = [];
  const skipped: SkippedRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1; // 1-based
    const product = row ? row[2]?.trim() : undefined;

    if (!row || row.length < 16) { skipped.push({ row: rowNum, reason: 'short_row', paperName: product }); continue; }

    const dateStr = row[0]?.trim();
    const timeStr = row[1]?.trim();
    const isin = row[3]?.trim();
    const liczba = parseDegiroNumber(row[6]);
    const price = parseDegiroNumber(row[7]);
    const priceCurrency = row[8]?.trim();
    const localValue = parseDegiroNumber(row[9]);
    const fee = parseDegiroNumber(row[14]);

    if (!dateStr) { skipped.push({ row: rowNum, reason: 'missing_date', paperName: product }); continue; }
    if (!product) { skipped.push({ row: rowNum, reason: 'missing_name' }); continue; }
    if (!isin) { skipped.push({ row: rowNum, reason: 'missing_isin', paperName: product }); continue; }
    if (liczba === 0) { skipped.push({ row: rowNum, reason: 'invalid_quantity', paperName: product }); continue; }

    // Skip corporate actions (e.g. SPAC mergers) where price is 0
    if (price === 0 && localValue !== 0) {
      skipped.push({ row: rowNum, reason: 'corporate_action', paperName: product });
      continue;
    }

    // Determine side from sign of Liczba
    const side: 'K' | 'S' = liczba > 0 ? 'K' : 'S';
    const quantity = Math.abs(Math.round(liczba));
    const absPrice = Math.abs(price);

    if (quantity <= 0) { skipped.push({ row: rowNum, reason: 'invalid_quantity', paperName: product }); continue; }
    if (absPrice <= 0) { skipped.push({ row: rowNum, reason: 'invalid_price', paperName: product }); continue; }

    const value = roundTo2(quantity * absPrice);
    const commission = Math.abs(fee); // fee is negative in DEGIRO

    // Total: for buy = value + commission, for sell = value - commission
    const total = side === 'K'
      ? roundTo2(value + commission)
      : roundTo2(value - commission);

    // Use the trade currency (from the price column), not the account EUR
    const currency = normalizeCurrency(priceCurrency || 'EUR');

    const isoDate = parseDegiroDate(dateStr, timeStr);

    transactions.push({
      date: isoDate,
      paperName: product,
      isin,
      quantity,
      side,
      price: absPrice,
      value,
      commission,
      total,
      currency,
      source: 'degiro',
      importBatch,
    });
  }

  return { data: transactions, skipped };
}

/**
 * Detect if CSV content looks like DEGIRO Transactions format.
 */
export function isDegiroFormat(csvContent: string): boolean {
  const firstLine = csvContent.split('\n')[0] || '';
  const lower = firstLine.toLowerCase();
  // DEGIRO-specific: comma-delimited, has 'isin', 'produkt', 'kurs wymian'
  return lower.includes('produkt') &&
    lower.includes('isin') &&
    lower.includes('kurs wymian');
}

/**
 * Validate the header row contains expected DEGIRO column names.
 */
function isDegiroHeader(header: string[]): boolean {
  if (!header || header.length < 16) return false;
  const h0 = header[0]?.trim().toLowerCase();
  const h2 = header[2]?.trim().toLowerCase();
  const h3 = header[3]?.trim().toLowerCase();
  return h0 === 'data' && h2 === 'produkt' && h3 === 'isin';
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
 * Parse number with either comma or dot as decimal separator.
 * DEGIRO uses dots (e.g. 762.0000) but some locale exports may use commas.
 */
function parseDegiroNumber(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.toString().replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Normalize currency codes.
 * Handles GBX (pence) → GBX (kept as-is, price is in pence).
 */
function normalizeCurrency(currency: string): string {
  const upper = currency.toUpperCase().trim();
  // GBX = British pence — keep as-is since price is in pence
  return upper || 'EUR';
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}
