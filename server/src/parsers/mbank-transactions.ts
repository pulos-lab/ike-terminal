import Papa from 'papaparse';
import type { Transaction, ParseResult, SkippedRow } from 'shared';
import {
  parseNumber,
  roundTo2,
  computeTotal,
  validateTradeFields,
  parseDottedDate,
} from './utils.js';

/**
 * Parse mBank eMakler transaction CSV.
 *
 * Real eMakler exports have ~34 lines of bank metadata before the actual data.
 * We scan for the header row, then parse data rows below it.
 *
 * Header: Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta
 *
 * Delimiter: auto-detected (semicolon in older exports, comma in newer ones).
 *
 * mBank does NOT provide ISIN — only instrument name ("Papier").
 * The ISIN field is set to the ticker name; real ISINs are resolved after import.
 *
 * Commission and currency columns may be empty in newer exports.
 * When empty, commission defaults to 0 (charged separately in operations file,
 * similar to DEGIRO), and currency is inferred from the exchange column (Giełda).
 */

/** mBank exchange name → quote currency mapping */
const EXCHANGE_CURRENCY: Record<string, string> = {
  'USA-NASDAQ': 'USD',
  'USA-NYSE': 'USD',
  'USA-AMEX': 'USD',
  'WWA-GPW': 'PLN',
  'WWA-NC': 'PLN',
  'GER-XETRA': 'EUR',
  'GER-FSE': 'EUR',
  'UK-LSE': 'GBP',
};

export function parseMbankTransactions(
  csvContent: string,
  importBatch: string,
): ParseResult<Transaction> {
  const lines = csvContent.split('\n');

  // Find header row — look for line containing "Czas" and "Papier" (or legacy "Walor")
  const { headerIdx, colMap, delimiter } = findHeaderRow(lines);
  if (headerIdx < 0) return { data: [], skipped: [] };

  // Join only data rows (after header) and parse with Papa
  const dataSection = lines.slice(headerIdx + 1).join('\n');
  const result = Papa.parse(dataSection.trim(), {
    delimiter,
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  const transactions: Transaction[] = [];
  const skipped: SkippedRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = headerIdx + 2 + i; // 1-based, accounting for header offset
    const paperName = row ? row[colMap.paper]?.trim() : undefined;

    if (!row || row.length < 6) {
      skipped.push({ row: rowNum, reason: 'short_row', paperName });
      continue;
    }

    const dateStr = row[colMap.date]?.trim();
    const side = row[colMap.side]?.trim();
    const quantity = parseNumber(row[colMap.quantity]);
    const price = parseNumber(row[colMap.price]);
    const priceCurrency = row[colMap.priceCurrency]?.trim();
    const commission = parseNumber(row[colMap.commission]);
    const exchange = row[colMap.exchange]?.trim();

    // Wspólna walidacja pól (utils.validateTradeFields) — mBank wymaga nazwy papieru,
    // ISIN nie istnieje w eksporcie (resolwowany po imporcie).
    const check = validateTradeFields({ date: dateStr, paperName, side, quantity, price });
    if (!check.ok) {
      skipped.push({ row: rowNum, reason: check.reason, paperName: paperName || undefined });
      continue;
    }

    const isoDate = parseDottedDate(dateStr!);
    const value = roundTo2(quantity * price);
    const total = computeTotal(side as 'K' | 'S', value, commission);
    // Infer currency from exchange column when price currency is empty
    const currency = priceCurrency || EXCHANGE_CURRENCY[exchange || ''] || 'PLN';

    transactions.push({
      date: isoDate,
      paperName: paperName!, // zwalidowane w validateTradeFields wyżej
      isin: paperName!, // Placeholder — resolved after import via ticker name
      quantity: Math.round(quantity), // GPW/NC: only whole shares; round removes CSV floating-point noise
      side: side as 'K' | 'S',
      price,
      value,
      commission, // May be 0 when charged separately in operations file (like DEGIRO)
      total,
      currency, // quote — priceCurrency or inferred from exchange
      paymentCurrency: 'PLN', // mBank eMakler IKE/IKZE: account w PLN
      source: 'mbank',
      importBatch,
    });
  }

  return { data: transactions, skipped };
}

/**
 * Detect if CSV content looks like mBank eMakler transaction format.
 * Scans all lines (real exports have ~34 lines of metadata before headers).
 */
export function isMbankFormat(csvContent: string): boolean {
  const lines = csvContent.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    // Real export header: "Czas transakcji;Papier;Giełda;K/S;..."
    // or comma-delimited: "Czas transakcji,Papier,Giełda,K/S,..."
    if (lower.includes('czas transakcji') && lower.includes('papier') && lower.includes('k/s')) {
      return true;
    }
    // Legacy/test format: "Czas;Walor;Giełda;Rodzaj;..."
    if (lower.includes('czas') && lower.includes('walor') && lower.includes('rodzaj')) {
      return true;
    }
  }
  // Also check for mBank metadata markers
  const content = csvContent.substring(0, 2000).toLowerCase();
  return content.includes('emakler') && content.includes('historia transakcji');
}

/**
 * Find header row, auto-detect delimiter, and build column index map.
 * Supports both semicolon (older exports) and comma (newer exports) delimiters.
 * Supports both real export format and legacy/test format.
 */
function findHeaderRow(lines: string[]): {
  headerIdx: number;
  colMap: ColumnMap;
  delimiter: string;
} {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    // Auto-detect delimiter: if the line has semicolons use ';', otherwise ','
    const delimiter = lower.includes(';') ? ';' : ',';
    const cols = line.split(delimiter).map((c) => c.trim().toLowerCase());

    // Real format: "Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta"
    const dateIdx = cols.findIndex((c) => c === 'czas transakcji' || c === 'czas');
    const paperIdx = cols.findIndex((c) => c === 'papier' || c === 'walor');
    const sideIdx = cols.findIndex((c) => c === 'k/s' || c === 'rodzaj');

    if (dateIdx >= 0 && paperIdx >= 0 && sideIdx >= 0) {
      // Find other columns by name
      const exchangeIdx = cols.findIndex(
        (c) => c === 'gie\u0142da' || c === 'gielda' || c === 'gie\u00b3da',
      );
      const quantityIdx = cols.findIndex((c) => c === 'liczba');
      const priceIdx = cols.findIndex((c) => c === 'kurs');

      // Find commission (Prowizja) — may appear before or after Wartość
      const prowizjaIdx = cols.indexOf('prowizja');

      // Price currency is the first Waluta after Kurs
      const priceCurrencyIdx = priceIdx >= 0 ? cols.indexOf('waluta', priceIdx + 1) : -1;

      return {
        headerIdx: i,
        delimiter,
        colMap: {
          date: dateIdx >= 0 ? dateIdx : 0,
          paper: paperIdx >= 0 ? paperIdx : 1,
          exchange: exchangeIdx >= 0 ? exchangeIdx : 2,
          side: sideIdx >= 0 ? sideIdx : 3,
          quantity: quantityIdx >= 0 ? quantityIdx : 4,
          price: priceIdx >= 0 ? priceIdx : 5,
          priceCurrency: priceCurrencyIdx >= 0 ? priceCurrencyIdx : 6,
          commission: prowizjaIdx >= 0 ? prowizjaIdx : 7,
        },
      };
    }
  }

  return { headerIdx: -1, colMap: DEFAULT_COL_MAP, delimiter: ',' };
}

interface ColumnMap {
  date: number;
  paper: number;
  exchange: number;
  side: number;
  quantity: number;
  price: number;
  priceCurrency: number;
  commission: number;
}

const DEFAULT_COL_MAP: ColumnMap = {
  date: 0,
  paper: 1,
  exchange: 2,
  side: 3,
  quantity: 4,
  price: 5,
  priceCurrency: 6,
  commission: 7,
};
