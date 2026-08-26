import Papa from 'papaparse';
import type { Transaction, SkippedRow, ParseResult } from 'shared';
import { applyIsinAlias } from 'shared';
import {
  normalizeForDetect,
  parseNumber,
  computeTotal,
  roundTo2,
  validateTradeFields,
  parseDashedDateTime,
  detectColumnShift,
  columnShiftWarning,
  rawRowForWarning,
} from './utils.js';

/**
 * Parse ING Biuro Maklerskie transaction CSV (historiaTransakcji_*.csv).
 *
 * Format: semicolon delimited, Windows-1250 (pre-decoded), 9 kolumn pozycyjnych:
 *   Data transakcji;Numer zlecenia;Papier;Kierunek;Ilość;Kurs;Wartość;Prowizja;Wartość z prowizją
 *
 * Świeże eksporty (2023+) NIE MAJĄ wiersza nagłówka — detekcja i parsowanie idą
 * po kształcie wiersza. Archiwalne eksporty (~2020, sampel public-samples/
 * pl-archiwum-2021/myfund__ING.csv) mają nagłówek ORAZ czas z myślnikami
 * (`09-00-00` zamiast `09:00:00`) — wspieramy obie odmiany.
 *
 * Pułapki formatu (zmierzone na realnym pliku):
 * - Kurs/Wartość: przecinek dziesiętny + NBSP (0xA0) jako separator tysięcy;
 *   Prowizja w TYM SAMYM wierszu ma KROPKĘ dziesiętną. parseNumber radzi sobie
 *   z oboma per pole (ostatni separator = dziesiętny).
 * - Fill częściowy = osobny wiersz z tym samym numerem zlecenia (legalny duplikat
 *   klucza dedupu przy identycznej cenie — dedup zliczeniowy w repo je zachowuje).
 * - Ticker to długi skrót GPW (PKNORLEN, CDPROJEKT) bez ISIN — zapisujemy
 *   pseudo-ISIN (isin = ticker, konwencja mBank); realny ISIN doszywa
 *   import-service joinem po numerze zlecenia z pliku historii finansowej.
 *
 * Waluta: ING wykonuje transakcje WYŁĄCZNIE w PLN (potwierdzone przez posiadacza
 * rachunku; waluty obce to tylko wpływy dywidend/wykupów na subkonta) —
 * currency i paymentCurrency = 'PLN' na sztywno, bez fxRate.
 */

/**
 * Wiersz danych ING: "29-08-2023 14:25:33;843790613;ETFSP500;Kupno;35;190,20;…"
 * Anchory trzymają fałszywe trafienia z daleka: pełny timestamp (DEGIRO ma datę
 * bez czasu), wielocyfrowy numer zlecenia i dosłowny token Kierunku.
 */
const ING_ROW_RE = /^\d{2}-\d{2}-\d{4} \d{2}[:-]\d{2}[:-]\d{2};\d{6,};[^;]+;(?:Kupno|Sprzeda[żz]);/;

/** Liczba kolumn formatu ING. */
const ING_COLUMNS = 9;

/** Ile pierwszych niepustych linii musi pasować do ING_ROW_RE w wariancie bezgłówkowym. */
const DETECT_SAMPLE_LINES = 5;

function isIngHeaderLine(line: string): boolean {
  const cols = line.split(';').map(normalizeForDetect);
  return (
    cols.includes('data transakcji') && cols.includes('numer zlecenia') && cols.includes('kierunek')
  );
}

/**
 * Detect ING transaction CSV — wariant z nagłówkiem (archiwum 2021) po nazwach
 * kolumn, wariant bezgłówkowy (bieżące eksporty) po kształcie pierwszych wierszy.
 */
export function isIngFormat(csvContent: string): boolean {
  const lines = csvContent.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return false;

  if (isIngHeaderLine(lines[0])) return true;

  const sample = lines.slice(0, DETECT_SAMPLE_LINES);
  return sample.every((line) => ING_ROW_RE.test(line) && line.split(';').length === ING_COLUMNS);
}

export function parseIngTransactions(
  csvContent: string,
  importBatch: string,
): ParseResult<Transaction> {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ';',
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  const transactions: Transaction[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: string[] = [];
  /** Wiersze, w których „Wartość z prowizją" z pliku ≠ wartość ± prowizja. */
  let totalMismatches = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    // Wiersz nagłówka (archiwalny wariant) — pomijany bez śladu w skipped.
    if (i === 0 && row.some((c) => normalizeForDetect(c ?? '') === 'numer zlecenia')) {
      continue;
    }

    if (!row || row.length < ING_COLUMNS) {
      skipped.push({ row: rowNum, reason: 'short_row' });
      continue;
    }

    const [dateStr, orderId, ticker, sideStr, qtyStr, priceStr, valueStr, commissionStr, totalStr] =
      row.map((c) => c?.trim() ?? '');

    // Ochrona przed przesunięciem kolumn — sygnały treści, nie liczba kolumn.
    const shiftProblems = detectColumnShift([
      { label: 'Data transakcji', value: dateStr, kind: 'date' },
      { label: 'Ilość', value: qtyStr, kind: 'number' },
      { label: 'Kurs', value: priceStr, kind: 'number' },
      { label: 'Wartość', value: valueStr, kind: 'number' },
      { label: 'Prowizja', value: commissionStr, kind: 'number' },
      { label: 'Wartość z prowizją', value: totalStr, kind: 'number' },
    ]);
    if (shiftProblems.length > 0) {
      skipped.push({ row: rowNum, reason: 'column_shift', paperName: ticker });
      warnings.push(columnShiftWarning(rowNum, shiftProblems, rawRowForWarning(row, ';')));
      continue;
    }

    const sideNorm = normalizeForDetect(sideStr);
    const side: 'K' | 'S' | '' = sideNorm === 'kupno' ? 'K' : sideNorm === 'sprzedaz' ? 'S' : '';
    const quantity = parseNumber(qtyStr);
    const price = parseNumber(priceStr);

    const check = validateTradeFields({
      date: dateStr,
      paperName: ticker,
      side,
      quantity,
      price,
    });
    if (!check.ok) {
      skipped.push({ row: rowNum, reason: check.reason, paperName: ticker });
      continue;
    }

    const isoDate = parseDashedDateTime(dateStr);
    const value = parseNumber(valueStr);
    const commission = parseNumber(commissionStr);
    // Przeliczamy total z części (wzorzec mBank); kolumnę z pliku traktujemy jako
    // sumę kontrolną — rozjazd sygnalizujemy zbiorczo, ale nie odrzucamy wiersza.
    const total = computeTotal(side as 'K' | 'S', value, commission);
    const fileTotal = parseNumber(totalStr);
    if (fileTotal !== 0 && Math.abs(roundTo2(fileTotal) - total) > 0.01) {
      totalMismatches++;
    }

    // Pseudo-ISIN = ticker (konwencja mBank); alias PDA→akcje (ZKA1→ZABKA) przed
    // zapisem, żeby obie nogi pozycji zbiegły do jednego papieru.
    const alias = applyIsinAlias(ticker, ticker, isoDate);

    transactions.push({
      date: isoDate,
      paperName: alias.paperName,
      isin: alias.isin,
      quantity: Math.round(quantity),
      side: side as 'K' | 'S',
      price,
      value,
      commission,
      total,
      currency: 'PLN',
      paymentCurrency: 'PLN',
      source: 'ing',
      importBatch,
      orderId: orderId || undefined,
    });
  }

  if (totalMismatches > 0) {
    warnings.push(
      `ING: w ${totalMismatches} wierszach „Wartość z prowizją" z pliku różni się od wyliczonej ` +
        `(wartość ± prowizja) o więcej niż 0,01 — zweryfikuj te transakcje w historii.`,
    );
  }

  return {
    data: transactions,
    skipped,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
