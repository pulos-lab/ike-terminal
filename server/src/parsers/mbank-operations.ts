import Papa from 'papaparse';
import type { CashOperation, ParseResult, SkippedRow } from 'shared';
import { parseNumber, parseDottedDate } from './utils.js';

/**
 * Parse mBank eMakler financial history CSV (eMAKLER_historia_finansowa.Csv).
 *
 * Format: comma or semicolon delimited, Windows-1250 encoding (pre-decoded).
 * Columns: Data, Opis, Kwota
 *
 * Operation types classified from the Opis (description) column:
 *   - "Dywidenda z N PW: ISIN ..."         → dividend
 *   - "WYC.BK: ..."                        → deposit (bank transfer in)
 *   - "WYP.BK: ..."                        → withdrawal (bank transfer out)
 *   - "Blokada środków ..."                → skipped (internal order blocking)
 *   - "Odblokowanie środków ..."           → skipped (internal order unblocking)
 *   - "WYC: ... PW: ISIN"                 → skipped (T+2 transaction settlement)
 *   - other                                → other
 */

// ── Regex patterns for operation classification ──

/** Dividend: "Dywidenda z 4 PW: US5951121038 DP: 2026-03-30 stawka brutto w wal.: 0.15 stawka pod.: 15% kurs przewalutowania: 3.590368 |DVCA10480" */
const DIVIDEND_RE =
  /^Dywidenda\s+z\s+(\d+)\s+PW:\s+(\S+)\s+DP:\s+([\d-]+)\s+stawka brutto w wal\.:\s+([\d.]+)\s+stawka pod\.:\s+(\d+)%(?:\s+kurs przewalutowania:\s+([\d.]+))?/;

/** Bank deposit: "WYC.BK: 600622 POZ: 1788464 ikze" */
const DEPOSIT_RE = /^WYC\.BK:/;

/** Bank withdrawal: "WYP.BK: ..." (assumed pattern based on WYC.BK convention) */
const WITHDRAWAL_RE = /^WYP\.BK:/;

/** Transaction settlement: "WYC: 112082964 NOT: 119127638 ZLC: 105038258 PW: PLKMPTR00012" */
const SETTLEMENT_RE = /^WYC:\s+\d+.*PW:\s+\S+/;

/** Order block: "Blokada środków pod zlecenie ..." */
const BLOCK_RE = /^Blokada\s/;

/** Order unblock: "Odblokowanie środków pod zlecenie ..." */
const UNBLOCK_RE = /^Odblokowanie\s/;

export function parseMbankOperations(
  csvContent: string,
  importBatch: string,
): ParseResult<CashOperation> {
  const lines = csvContent.split('\n');

  const { headerIdx, delimiter } = findOperationsHeader(lines);
  if (headerIdx < 0) return { data: [], skipped: [] };

  const dataSection = lines.slice(headerIdx + 1).join('\n');
  const result = Papa.parse(dataSection.trim(), {
    delimiter,
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  const operations: CashOperation[] = [];
  const skipped: SkippedRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = headerIdx + 2 + i;

    if (!row || row.length < 3) {
      skipped.push({ row: rowNum, reason: 'short_row' });
      continue;
    }

    const dateStr = row[0]?.trim();
    const description = row[1]?.trim();
    const amount = parseNumber(row[2]);

    if (!dateStr) {
      skipped.push({ row: rowNum, reason: 'missing_date', paperName: description });
      continue;
    }
    if (!description) {
      skipped.push({ row: rowNum, reason: 'missing_description' });
      continue;
    }

    const isoDate = parseDottedDate(dateStr);

    // ── Skip internal bookkeeping entries ──
    if (BLOCK_RE.test(description) || UNBLOCK_RE.test(description)) {
      skipped.push({ row: rowNum, reason: 'settlement_record', paperName: description });
      continue;
    }

    // ── Skip T+2 transaction settlements ──
    if (SETTLEMENT_RE.test(description)) {
      skipped.push({ row: rowNum, reason: 'settlement_record', paperName: description });
      continue;
    }

    if (amount === 0) {
      skipped.push({ row: rowNum, reason: 'zero_amount', paperName: description });
      continue;
    }

    // ── Classify operation ──
    const dividendMatch = DIVIDEND_RE.exec(description);
    if (dividendMatch) {
      const [, qtyStr, isin, , grossRateStr, taxPctStr, fxRateStr] = dividendMatch;
      const qty = parseInt(qtyStr, 10);
      const grossRate = parseFloat(grossRateStr);
      const taxPct = parseInt(taxPctStr, 10);
      const fxRate = fxRateStr ? parseFloat(fxRateStr) : undefined;

      operations.push({
        date: isoDate,
        operationType: 'dividend',
        description: `Dywidenda ${isin} (${qty} szt, brutto ${grossRate}/szt, podatek ${taxPct}%${fxRate ? `, kurs ${fxRate}` : ''})`,
        amount,
        currency: 'PLN', // mBank converts dividends to PLN
        ticker: isin,
        fxRate,
        source: 'mbank',
        importBatch,
      });
      continue;
    }

    if (DEPOSIT_RE.test(description)) {
      operations.push({
        date: isoDate,
        operationType: amount > 0 ? 'deposit' : 'withdrawal',
        description,
        amount,
        currency: 'PLN',
        source: 'mbank',
        importBatch,
      });
      continue;
    }

    if (WITHDRAWAL_RE.test(description)) {
      operations.push({
        date: isoDate,
        operationType: amount < 0 ? 'withdrawal' : 'deposit',
        description,
        amount,
        currency: 'PLN',
        source: 'mbank',
        importBatch,
      });
      continue;
    }

    // ── Unknown operation type ──
    operations.push({
      date: isoDate,
      operationType: 'other',
      description,
      amount,
      currency: 'PLN',
      source: 'mbank',
      importBatch,
    });
  }

  return { data: operations, skipped };
}

/**
 * Detect if CSV content looks like mBank eMakler financial history (operations).
 * Header: "Data,Opis,Kwota" or "Data;Opis;Kwota"
 */
export function isMbankOperationsFormat(csvContent: string): boolean {
  const lines = csvContent.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('data') && lower.includes('opis') && lower.includes('kwota')) {
      // Make sure it's not a transaction file (those also have "data" but also "papier")
      if (!lower.includes('papier') && !lower.includes('walor')) {
        return true;
      }
    }
  }
  // Metadata-based detection
  const content = csvContent.substring(0, 2000).toLowerCase();
  return content.includes('emakler') && content.includes('historia finansowa');
}

/**
 * Find the header row and auto-detect delimiter.
 */
function findOperationsHeader(lines: string[]): { headerIdx: number; delimiter: string } {
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('data') && lower.includes('opis') && lower.includes('kwota')) {
      const delimiter = lower.includes(';') ? ';' : ',';
      return { headerIdx: i, delimiter };
    }
  }
  return { headerIdx: -1, delimiter: ',' };
}
