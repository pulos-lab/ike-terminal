import Papa from 'papaparse';
import type { Transaction, ParseResult, SkippedRow } from 'shared';
import {
  normalizeForDetect,
  parseNumber,
  roundTo2,
  computeTotal,
  validateTradeFields,
  parseDottedDate,
  detectColumnShift,
  columnShiftWarning,
  rawRowForWarning,
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
): ParseResult<Transaction> & { warnings?: string[] } {
  const lines = csvContent.split('\n');

  // Find header row — look for line containing "Czas" and "Papier" (or legacy "Walor")
  const { headerIdx, colMap, delimiter } = findHeaderRow(lines);
  if (headerIdx < 0 || !colMap) return { data: [], skipped: [] };

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
  const warnings: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = headerIdx + 2 + i; // 1-based, accounting for header offset
    const paperName = row ? row[colMap.paper]?.trim() : undefined;

    if (!row || row.length < 6) {
      skipped.push({ row: rowNum, reason: 'short_row', paperName });
      continue;
    }

    // Kolumny z indeksem −1 = nieobecne w nagłówku → pole traktowane jako puste
    // (prowizja 0, waluta z giełdy / PLN) zamiast czytania zgadywanego indeksu.
    const at = (idx: number): string | undefined => (idx >= 0 ? row[idx] : undefined);
    const dateStr = at(colMap.date)?.trim();
    const side = at(colMap.side)?.trim();
    const quantity = parseNumber(at(colMap.quantity));
    const price = parseNumber(at(colMap.price));
    const priceCurrency = at(colMap.priceCurrency)?.trim();
    const commission = parseNumber(at(colMap.commission));
    const exchange = at(colMap.exchange)?.trim();

    // Ochrona przed cichym przesunięciem kolumn (dodatkowy separator w którymś polu):
    // sygnały treści, nie liczba kolumn. Kolumny z indeksem −1 dają undefined = brak sygnału.
    const shiftProblems = detectColumnShift([
      { label: 'Czas transakcji', value: dateStr, kind: 'date' },
      { label: 'Liczba', value: at(colMap.quantity), kind: 'number' },
      { label: 'Kurs', value: at(colMap.price), kind: 'number' },
      { label: 'Prowizja', value: at(colMap.commission), kind: 'number' },
      { label: 'Waluta', value: priceCurrency, kind: 'currency' },
    ]);
    if (shiftProblems.length > 0) {
      skipped.push({ row: rowNum, reason: 'column_shift', paperName: paperName || undefined });
      warnings.push(columnShiftWarning(rowNum, shiftProblems, rawRowForWarning(row, delimiter)));
      continue;
    }

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

  // Jedno zagregowane ostrzeżenie gdy w nagłówku brakuje opcjonalnych kolumn —
  // wcześniej kod zgadywał stałe indeksy (prowizja→7, waluta→6, giełda→2) i mógł
  // cicho czytać złe kolumny. Teraz pole jest nieobecne + user dostaje informację.
  const missingCols: string[] = [];
  if (colMap.commission < 0) missingCols.push('Prowizja (przyjęto 0)');
  if (colMap.priceCurrency < 0) missingCols.push('Waluta kursu (inferowana z giełdy lub PLN)');
  if (colMap.exchange < 0) missingCols.push('Giełda (waluta domyślnie PLN)');
  if (missingCols.length > 0 && transactions.length > 0) {
    warnings.push(
      `mBank: w nagłówku pliku brakuje kolumn: ${missingCols.join('; ')} — ` +
        `zweryfikuj prowizje i waluty zaimportowanych transakcji.`,
    );
  }

  return { data: transactions, skipped, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * Detect if CSV content looks like mBank eMakler transaction format.
 * Scans all lines (real exports have ~34 lines of metadata before headers).
 */
export function isMbankFormat(csvContent: string): boolean {
  const lines = csvContent.split('\n');
  for (const line of lines) {
    const lower = normalizeForDetect(line);
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
  const content = normalizeForDetect(csvContent.substring(0, 2000));
  return content.includes('emakler') && content.includes('historia transakcji');
}

/**
 * Find header row, auto-detect delimiter, and build column index map.
 * Supports both semicolon (older exports) and comma (newer exports) delimiters.
 * Supports both real export format and legacy/test format.
 */
function findHeaderRow(lines: string[]): {
  headerIdx: number;
  colMap: ColumnMap | null;
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

      // Indeksy pozycyjne TYLKO tam, gdzie są niezbędne dla znanego formatu legacy
      // ("Czas;Walor;Giełda;Rodzaj;Liczba;Kurs;..."): liczba→4 i kurs→5 — bez nich
      // legacy nie sparsowałby się wcale (pola obowiązkowe walidacji). Pozostałe
      // kolumny (giełda/waluta/prowizja) przy braku nagłówka dostają −1 = pole
      // NIEOBECNE: prowizja = 0, waluta z giełdy lub PLN. Zgadywanie stałych
      // indeksów (2/6/7) potrafiło cicho czytać złe kolumny w wariantach layoutu.
      return {
        headerIdx: i,
        delimiter,
        colMap: {
          date: dateIdx,
          paper: paperIdx,
          exchange: exchangeIdx,
          side: sideIdx,
          quantity: quantityIdx >= 0 ? quantityIdx : 4,
          price: priceIdx >= 0 ? priceIdx : 5,
          priceCurrency: priceCurrencyIdx,
          commission: prowizjaIdx,
        },
      };
    }
  }

  return { headerIdx: -1, colMap: null, delimiter: ',' };
}

interface ColumnMap {
  date: number;
  paper: number;
  /** −1 = kolumna nieobecna w nagłówku — brak inferencji waluty z giełdy */
  exchange: number;
  side: number;
  quantity: number;
  price: number;
  /** −1 = kolumna nieobecna w nagłówku — waluta inferowana z giełdy / PLN */
  priceCurrency: number;
  /** −1 = kolumna nieobecna w nagłówku — prowizja przyjęta jako 0 */
  commission: number;
}
