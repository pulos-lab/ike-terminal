import Papa from 'papaparse';
import type { Transaction, ParseResult, SkippedRow } from 'shared';
import { parseNumber, parseDottedDate } from './utils.js';

/**
 * Bossa sufiksuje tickery instrumentów nietypowych:
 * - `-C` — certyfikat strukturyzowany (np. `4MASS-C`, `HUUUGE-C`)
 * - `-NC-FIX` — NewConnect z ceną fix (`ROBSGROUP-NC-FIX`, `DUALITY-NC-FIX`)
 * - `-NC` — zwykły NewConnect (`PLATIGE-NC`)
 * - `_IPO` — ticker pre-IPO (`HUUUGE_IPO`)
 *
 * Usuwamy sufiks, żeby resolver (Yahoo/Stooq) mógł trafić na realnie notowany papier.
 * Oryginalny paperName zachowujemy w polu `paperName` transakcji — jest to ticker brokera
 * wyświetlany w UI. Kanoniczny ticker idzie do resolvera pośrednio przez `paperName`,
 * po stripowaniu sufiksów.
 *
 * UWAGA: NIE stripujemy dla zwykłych tickerów (nie mają tych sufiksów) — regex musi być ścisły.
 */
const SUFFIX_RE = /(-NC-FIX|-NC|-C|_IPO)$/;

export function canonicalizeBossaTicker(paperName: string): string {
  return paperName.replace(SUFFIX_RE, '');
}

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
    const quantity = parseNumber(row['ilość']);
    const side = row['-']?.trim();
    const price = parseNumber(row['cena']);
    const value = parseNumber(row['wartość']);
    const commission = parseNumber(row['prowizja']);
    const total = parseNumber(row['po prowizji']);
    const currency = row['waluta']?.trim();

    if (!dateStr) { skipped.push({ row: rowNum, reason: 'missing_date', paperName }); continue; }
    if (!isin) { skipped.push({ row: rowNum, reason: 'missing_isin', paperName }); continue; }
    if (side !== 'K' && side !== 'S') { skipped.push({ row: rowNum, reason: 'invalid_side', paperName }); continue; }
    if (quantity <= 0) { skipped.push({ row: rowNum, reason: 'invalid_quantity', paperName }); continue; }

    const isoDate = parseDottedDate(dateStr);

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
      currency: currency || 'PLN',   // quote — co CSV `waluta` mówi o tym trade'ie
      paymentCurrency: 'PLN',         // Bossa IKE/IKZE: account zawsze w PLN → auto-FX widoczny jako glyph gdy currency != PLN
      source: 'bossa',
      importBatch,
    });
  }

  return { data: transactions, skipped };
}

