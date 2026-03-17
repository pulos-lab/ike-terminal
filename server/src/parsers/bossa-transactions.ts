import Papa from 'papaparse';
import type { Transaction, ParseResult, SkippedRow } from 'shared';

/**
 * Parse Bossa transaction CSV (hisPW.csv / hisPW-2.csv format)
 * Format: semicolon delimited, windows-1250 encoding (pre-decoded), comma decimals
 * Columns: data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta
 * Date format: DD.MM.YYYY HH:MM:SS
 */
/**
 * Detect Bossa CSV format by checking for characteristic headers: data, papier, isin
 * Uses semicolon delimiter and has 'papier' column (unique to Bossa)
 */
export function isBossaFormat(csvContent: string): boolean {
  const firstLine = csvContent.split('\n')[0] || '';
  const lower = firstLine.toLowerCase();
  return lower.includes('data') && lower.includes('papier') && lower.includes('isin');
}

export function parseBossaTransactions(csvContent: string, importBatch: string): ParseResult<Transaction> {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ';',
    header: true,
    skipEmptyLines: true,
  });

  // Validate that the CSV has expected headers — return empty array (not throw)
  const headers = result.meta?.fields || [];
  const hasDataCol = headers.some(h => h.toLowerCase() === 'data');
  const hasIsinCol = headers.some(h => h.toLowerCase() === 'isin');
  if (!hasDataCol || !hasIsinCol) {
    return { data: [], skipped: [] };
  }

  const transactions: Transaction[] = [];
  const skipped: SkippedRow[] = [];

  const rows = result.data as any[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-based, +1 for header
    const dateStr = row['data']?.trim();
    const paperName = row['papier']?.trim();
    const isin = row['isin']?.trim();
    const quantity = parsePolishNumber(row['ilość']);
    const side = row['-']?.trim();
    const price = parsePolishNumber(row['cena']);
    const value = parsePolishNumber(row['wartość']);
    const commission = parsePolishNumber(row['prowizja']);
    const total = parsePolishNumber(row['po prowizji']);
    const currency = row['waluta']?.trim();

    if (!dateStr) { skipped.push({ row: rowNum, reason: 'missing_date', paperName }); continue; }
    if (!isin) { skipped.push({ row: rowNum, reason: 'missing_isin', paperName }); continue; }
    if (side !== 'K' && side !== 'S') { skipped.push({ row: rowNum, reason: 'invalid_side', paperName }); continue; }
    if (quantity <= 0) { skipped.push({ row: rowNum, reason: 'invalid_quantity', paperName }); continue; }

    const isoDate = parseBossaDate(dateStr);

    transactions.push({
      date: isoDate,
      paperName: paperName || '',
      isin,
      quantity: Math.round(quantity),
      side,
      price,
      value,
      commission,
      total,
      currency: currency || 'PLN',
      source: 'bossa',
      importBatch,
    });
  }

  return { data: transactions, skipped };
}

/**
 * Parse DD.MM.YYYY HH:MM:SS to ISO 8601
 */
function parseBossaDate(dateStr: string): string {
  // "25.02.2026 09:47:27" -> "2026-02-25T09:47:27"
  const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2}:\d{2})/);
  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}T${match[4]}`;
  }
  // Fallback: try DD.MM.YYYY without time
  const dateOnly = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (dateOnly) {
    return `${dateOnly[3]}-${dateOnly[2]}-${dateOnly[1]}T00:00:00`;
  }
  return dateStr;
}

/**
 * Parse Polish number format: "1 234,56" -> 1234.56
 */
function parsePolishNumber(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.toString().replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}
