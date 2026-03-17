import Papa from 'papaparse';
import type { Transaction, ParseResult, SkippedRow } from 'shared';

/**
 * Parse mBank eMakler transaction CSV.
 *
 * Real eMakler exports have ~34 lines of bank metadata before the actual data.
 * We scan for the header row, then parse data rows below it.
 *
 * Header: Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta
 *
 * mBank does NOT provide ISIN — only instrument name ("Papier").
 * The ISIN field is set to the ticker name; real ISINs are resolved after import.
 */
export function parseMbankTransactions(csvContent: string, importBatch: string): ParseResult<Transaction> {
  const lines = csvContent.split('\n');

  // Find header row — look for line containing "Czas" and "Papier" (or legacy "Walor")
  const { headerIdx, colMap } = findHeaderRow(lines);
  if (headerIdx < 0) return { data: [], skipped: [] };

  // Join only data rows (after header) and parse with Papa
  const dataSection = lines.slice(headerIdx + 1).join('\n');
  const result = Papa.parse(dataSection.trim(), {
    delimiter: ';',
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

    if (!row || row.length < 9) { skipped.push({ row: rowNum, reason: 'short_row', paperName }); continue; }

    const dateStr = row[colMap.date]?.trim();
    const side = row[colMap.side]?.trim();
    const quantity = parsePolishNumber(row[colMap.quantity]);
    const price = parsePolishNumber(row[colMap.price]);
    const priceCurrency = row[colMap.priceCurrency]?.trim();
    const commission = parsePolishNumber(row[colMap.commission]);
    const commissionCurrency = row[colMap.commissionCurrency]?.trim() || priceCurrency;

    if (!dateStr) { skipped.push({ row: rowNum, reason: 'missing_date', paperName }); continue; }
    if (!paperName) { skipped.push({ row: rowNum, reason: 'missing_name' }); continue; }
    if (side !== 'K' && side !== 'S') { skipped.push({ row: rowNum, reason: 'invalid_side', paperName }); continue; }
    if (quantity <= 0) { skipped.push({ row: rowNum, reason: 'invalid_quantity', paperName }); continue; }
    if (price <= 0) { skipped.push({ row: rowNum, reason: 'invalid_price', paperName }); continue; }

    const isoDate = parseMbankDate(dateStr);
    const value = roundTo2(quantity * price);
    const total = side === 'K'
      ? roundTo2(value + commission)
      : roundTo2(value - commission);
    const currency = priceCurrency || 'PLN';

    transactions.push({
      date: isoDate,
      paperName,
      isin: paperName, // Placeholder — resolved after import via ticker name
      quantity: Math.round(quantity),
      side: side as 'K' | 'S',
      price,
      value,
      commission,
      total,
      currency,
      source: 'mbank',
      importBatch,
    });
  }

  return { data: transactions, skipped };
}

/**
 * Detect if CSV content looks like mBank eMakler format.
 * Scans all lines (real exports have ~34 lines of metadata before headers).
 */
export function isMbankFormat(csvContent: string): boolean {
  const lines = csvContent.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    // Real export header: "Czas transakcji;Papier;Giełda;K/S;..."
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
 * Find header row and build column index map.
 * Supports both real export format and legacy/test format.
 */
function findHeaderRow(lines: string[]): { headerIdx: number; colMap: ColumnMap } {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const cols = line.split(';').map(c => c.trim().toLowerCase());

    // Real format: "Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta"
    const dateIdx = cols.findIndex(c => c === 'czas transakcji' || c === 'czas');
    const paperIdx = cols.findIndex(c => c === 'papier' || c === 'walor');
    const sideIdx = cols.findIndex(c => c === 'k/s' || c === 'rodzaj');

    if (dateIdx >= 0 && paperIdx >= 0 && sideIdx >= 0) {
      // Find other columns by name
      const quantityIdx = cols.findIndex(c => c === 'liczba');
      const priceIdx = cols.findIndex(c => c === 'kurs');

      // Find commission (Prowizja) — may appear before or after Wartość
      const prowizjaIdx = cols.indexOf('prowizja');

      // Price currency is the first Waluta after Kurs
      const priceCurrencyIdx = priceIdx >= 0 ? cols.indexOf('waluta', priceIdx + 1) : -1;
      // Commission currency is the first Waluta after Prowizja
      const commCurrencyIdx = prowizjaIdx >= 0 ? cols.indexOf('waluta', prowizjaIdx + 1) : -1;

      return {
        headerIdx: i,
        colMap: {
          date: dateIdx >= 0 ? dateIdx : 0,
          paper: paperIdx >= 0 ? paperIdx : 1,
          side: sideIdx >= 0 ? sideIdx : 3,
          quantity: quantityIdx >= 0 ? quantityIdx : 4,
          price: priceIdx >= 0 ? priceIdx : 5,
          priceCurrency: priceCurrencyIdx >= 0 ? priceCurrencyIdx : 6,
          commission: prowizjaIdx >= 0 ? prowizjaIdx : 7,
          commissionCurrency: commCurrencyIdx >= 0 ? commCurrencyIdx : 8,
        },
      };
    }
  }

  return { headerIdx: -1, colMap: DEFAULT_COL_MAP };
}

interface ColumnMap {
  date: number;
  paper: number;
  side: number;
  quantity: number;
  price: number;
  priceCurrency: number;
  commission: number;
  commissionCurrency: number;
}

const DEFAULT_COL_MAP: ColumnMap = {
  date: 0, paper: 1, side: 3, quantity: 4,
  price: 5, priceCurrency: 6, commission: 7, commissionCurrency: 8,
};

/**
 * Parse dd.MM.yyyy or dd.MM.yyyy HH:MM:SS to ISO 8601.
 */
function parseMbankDate(dateStr: string): string {
  const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2}:\d{2}:\d{2})?/);
  if (match) {
    const time = match[4] || '00:00:00';
    return `${match[3]}-${match[2]}-${match[1]}T${time}`;
  }
  return dateStr;
}

function parsePolishNumber(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.toString().replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}
