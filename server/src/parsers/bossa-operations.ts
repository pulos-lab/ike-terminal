import Papa from 'papaparse';
import type { CashOperation, OperationType, ParseResult, SkippedRow } from 'shared';

/**
 * Parse Bossa cash operations CSV
 * Format: semicolon delimited, windows-1250 encoding (pre-decoded), comma decimals
 * Columns: data;tytuł operacji;szczegóły;kwota;waluta
 * Date format: YYYY-MM-DD
 */
/** Valid date format: YYYY-MM-DD */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseBossaOperations(csvContent: string, importBatch: string): ParseResult<CashOperation> {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ';',
    header: true,
    skipEmptyLines: true,
  });

  // Validate that the CSV has expected headers — return empty array (not throw)
  const headers = result.meta?.fields || [];
  const hasDataCol = headers.some(h => h.toLowerCase() === 'data');
  const hasKwotaCol = headers.some(h => h.toLowerCase() === 'kwota');
  if (!hasDataCol || !hasKwotaCol) {
    return { data: [], skipped: [] };
  }

  const operations: CashOperation[] = [];
  const skipped: SkippedRow[] = [];

  const rows = result.data as any[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-based, +1 for header
    const dateStr = row['data']?.trim();
    const title = row['tytuł operacji']?.trim() || row['tytu\u0142 operacji']?.trim() || '';
    const details = row['szczegóły']?.trim() || row['szczeg\u00f3\u0142y']?.trim() || '';
    const amount = parsePolishNumber(row['kwota']);
    const currency = row['waluta']?.trim();

    if (!dateStr) { skipped.push({ row: rowNum, reason: 'missing_date', paperName: title }); continue; }
    if (!DATE_RE.test(dateStr)) { skipped.push({ row: rowNum, reason: 'invalid_date', paperName: title }); continue; }
    if (amount === 0) { skipped.push({ row: rowNum, reason: 'zero_amount', paperName: title }); continue; }

    const operationType = classifyOperation(title, amount);

    // Skip transaction settlement records — they belong to transactions, not cash operations
    if (operationType === 'skip') { skipped.push({ row: rowNum, reason: 'settlement_record', paperName: title }); continue; }

    const ticker = parseDividendTicker(title);
    const fxInfo = parseFxRate(title);

    operations.push({
      date: `${dateStr}T00:00:00`,
      operationType,
      description: title,
      details: details || undefined,
      amount,
      currency: currency || 'PLN',
      ticker: ticker || undefined,
      fxRate: fxInfo?.rate,
      fxPair: fxInfo?.pair,
      source: 'bossa',
      importBatch,
    });
  }

  return { data: operations, skipped };
}

function classifyOperation(title: string, amount: number): OperationType | 'skip' {
  if (title.includes('Rozliczenie transakcji')) return 'skip';
  if (title.includes('Przelew')) return amount < 0 ? 'withdrawal' : 'deposit';
  if (title.toLowerCase().includes('dywidendy')) return 'dividend';
  if (title.includes('Wymiana waluty')) return 'fx_exchange';
  if (title.includes('Opłata za transakcj') || title.includes('Op\u0142ata za transakcj')) return 'fee';
  if (title.includes('Zwrot prowizji')) return 'commission_refund';
  return 'other';
}

/**
 * Extract dividend ticker from title
 * "Wypłata dywidendy PLAYWAY" -> "PLAYWAY"
 * "Wypłata dywidendy netto NVO 73% PLN" -> "NVO"
 */
function parseDividendTicker(title: string): string | null {
  const match = title.match(/dywidendy(?:\s+netto)?\s+(\w+)/i);
  return match ? match[1] : null;
}

/**
 * Extract FX rate from title
 * "Wymiana waluty PLN/USD 3.5713" -> { pair: "PLN/USD", rate: 3.5713 }
 */
function parseFxRate(title: string): { pair: string; rate: number } | null {
  const match = title.match(/Wymiana waluty (\w+\/\w+) ([\d.]+)/);
  if (match) {
    return { pair: match[1], rate: parseFloat(match[2]) };
  }
  return null;
}

function parsePolishNumber(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.toString().replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}
