import Papa from 'papaparse';
import type { CashOperation, ParseResult, SkippedRow } from 'shared';
import {
  normalizeForDetect,
  parseNumber,
  roundTo2,
  parseDegiroDate,
  detectColumnShift,
  columnShiftWarning,
  rawRowForWarning,
} from './utils.js';

/**
 * Parse DEGIRO Account CSV (cash operations).
 *
 * Format: comma-delimited, UTF-8 encoding, Polish locale.
 *
 * Headers:
 *   Data,Czas,Data,Produkt,ISIN,Opis,Kurs,Zmiana,(currency),Saldo,(currency),Identyfikator zlecenia
 *
 * Column layout (0-indexed):
 *   0  Data                    - transaction date DD-MM-YYYY
 *   1  Czas                    - time HH:MM
 *   2  Data                    - value date DD-MM-YYYY
 *   3  Produkt                 - product name or currency pair (e.g. "EUR/PLN")
 *   4  ISIN                    - ISIN code (for dividend rows)
 *   5  Opis                    - operation description
 *   6  Kurs                    - exchange rate (for FX operations)
 *   7  Zmiana                  - currency of change
 *   8  (unnamed)               - amount change (comma decimal)
 *   9  (currency)              - currency of balance
 *  10  Saldo                   - balance after operation
 *  11  Identyfikator zlecenia  - order ID (present for trade-related FX)
 *
 * Supported operations:
 *   - Dywidenda + Podatek Dywidendowy → paired into single dividend (net amount)
 *   - Depozyt / Depozyt Trustly / Sofort → deposit
 *   - Wypłata → withdrawal
 *   - FX Credit + FX Withdrawal → paired into fx_exchange (all rows, including trade-linked)
 *
 * Wiersze spoza wszystkich list trafiają do skrzynki "Do wyjaśnienia"
 * (unknown_operation_type + raw) — NIE są księgowane, bo Account.csv zawiera
 * też wiersze czysto informacyjne, które zepsułyby saldo. Wyjątek: znana
 * wewnętrzna księgowość DEGIRO (INTERNAL_ROW_PATTERNS) pomijana bez śladu.
 */

/** Opisy podatków transakcyjnych — konsumuje je parseDegiroTransactionTaxes
 * (doliczane do prowizji transakcji), więc pass operacji ma je uznać za
 * obsłużone, a nie zgłaszać jako nieznane. */
const TRANSACTION_TAX_DESCRIPTIONS = [
  'Francuski podatek od transakcji',
  'London/Dublin Stamp Duty',
  'Hong Kong Stamp Duty',
];

/** Wiersze Account.csv celowo pomijane BEZ śladu — obsłużone gdzie indziej albo
 * czysto wewnętrzna księgowość DEGIRO (zweryfikowane na realnych eksportach,
 * ~400 wierszy na plik — jako tickety zalałyby skrzynkę, jako skipy listę
 * ostrzeżeń):
 *  - nogi gotówkowe transakcji („Kupno 4 11 Bit Studios SA@451 PLN (ISIN)") —
 *    transakcje wchodzą z Transactions.csv, zaksięgowanie nogi = podwójny koszt;
 *  - nogi FUZJI — para Kupno+Sprzedaż po tej samej cenie, netto 0;
 *  - fundusz gotówkowy (konwersje jednostek, zmiana ceny) — informacyjne;
 *  - „Degiro Cash Sweep Transfer" — przelew DEGIRO↔FLATEX BANKACCOUNT, obie
 *    kieszenie to w aplikacji jedna pula gotówki;
 *  - „Processed Flatex Withdrawal" — para rezerwacja+rewers (netto 0) obok
 *    księgowanej „flatex Withdrawal". */
const INTERNAL_ROW_PATTERNS: RegExp[] = [
  /^(?:Kupno|Sprzedaż)\s+\d/,
  /^FUZJA:/,
  /^Konwersja funduszu gotówkowego/,
  /^Zmiana ceny funduszu gotówkowego/,
  /^Degiro Cash Sweep Transfer$/,
  /^Processed Flatex Withdrawal$/,
];

interface AccountRow {
  rowNum: number;
  date: string; // DD-MM-YYYY
  time: string; // HH:MM
  product: string;
  isin: string;
  description: string;
  rate: number; // Kurs
  amount: number; // Zmiana
  currency: string;
  orderId: string;
}

export function parseDegiroOperations(
  csvContent: string,
  importBatch: string,
): ParseResult<CashOperation> {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ',',
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  if (rows.length < 2) return { data: [], skipped: [] };

  const header = rows[0];
  if (!isDegiroAccountHeader(header)) return { data: [], skipped: [] };

  // Parse all rows into structured format
  const parsed: AccountRow[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: string[] = [];
  // Surowe komórki per wiersz — potrzebne dla skrzynki "Do wyjaśnienia".
  const rawCells = new Map<number, string[]>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    if (!row || row.length < 8) {
      skipped.push({ row: rowNum, reason: 'short_row' });
      continue;
    }

    const dateStr = row[0]?.trim();
    const time = row[1]?.trim() || '00:00';
    const product = row[3]?.trim() || '';
    const isin = row[4]?.trim() || '';
    const description = row[5]?.trim() || '';
    const rate = parseNumber(row[6]);
    const currency = row[7]?.trim() || '';
    const amount = parseNumber(row[8]);
    const orderId = row[11]?.trim() || '';

    if (!dateStr) {
      skipped.push({ row: rowNum, reason: 'missing_date' });
      continue;
    }
    if (!description) {
      skipped.push({ row: rowNum, reason: 'missing_description' });
      continue;
    }

    // Ochrona przed cichym przesunięciem kolumn — kolumny czytane pozycyjnie,
    // dodatkowy przecinek w polu (np. w opisie) przesuwa Zmianę do złych kolumn.
    // Sygnały treści, nie liczba kolumn; sprawdzamy WYŁĄCZNIE kolumny, które
    // parser konsumuje (0-8) — kolumny Saldo po prawej mają warianty layoutu
    // między eksportami i nie wpływają na wynik importu.
    const shiftProblems = detectColumnShift([
      { label: 'Data', value: dateStr, kind: 'date' },
      { label: 'Kurs', value: row[6], kind: 'number' },
      { label: 'waluta zmiany', value: row[7], kind: 'currency' },
      { label: 'Zmiana', value: row[8], kind: 'number' },
    ]);
    if (shiftProblems.length > 0) {
      skipped.push({ row: rowNum, reason: 'column_shift', paperName: description });
      warnings.push(columnShiftWarning(rowNum, shiftProblems, rawRowForWarning(row, ',')));
      continue;
    }

    const normalizedCurrency = currency === 'NO' ? 'NOK' : currency;
    rawCells.set(rowNum, row);
    parsed.push({
      rowNum,
      date: dateStr,
      time,
      product,
      isin,
      description,
      rate,
      amount,
      currency: normalizedCurrency,
      orderId,
    });
  }

  const operations: CashOperation[] = [];

  // Wiersze pochłonięte przez którąkolwiek z list poniżej — reszta trafia do
  // catch-alla na końcu (wcześniej znikała bez śladu: bez skipped, bez warningu).
  const consumed = new Set<number>();
  const take = (pred: (r: AccountRow) => boolean): AccountRow[] => {
    const hits = parsed.filter(pred);
    for (const r of hits) consumed.add(r.rowNum);
    return hits;
  };

  // ── Dividends: pair gross + tax by ISIN + date + time ──
  // Każdy wiersz podatku może być sparowany TYLKO RAZ — dwie dywidendy tego
  // samego ISIN-u o tym samym timestampie (np. częściowe księgowania) nie mogą
  // odjąć tego samego podatku dwukrotnie.
  const dividendRows = take((r) => r.description === 'Dywidenda');
  const taxRows = take((r) => r.description === 'Podatek Dywidendowy');
  const usedTaxRows = new Set<number>();

  for (const div of dividendRows) {
    const tax = taxRows.find(
      (t) =>
        t.isin === div.isin &&
        t.date === div.date &&
        t.time === div.time &&
        !usedTaxRows.has(t.rowNum),
    );
    if (tax) usedTaxRows.add(tax.rowNum);
    const grossAmount = Math.abs(div.amount);
    const taxAmount = tax ? Math.abs(tax.amount) : 0;
    const netAmount = roundTo2(grossAmount - taxAmount);

    const taxPct = grossAmount > 0 ? Math.round((taxAmount / grossAmount) * 100) : 0;
    const descParts = [div.product];
    if (taxPct > 0) descParts.push(`(podatek ${taxPct}%)`);

    operations.push({
      date: parseDegiroDate(div.date, div.time),
      operationType: 'dividend',
      description: descParts.join(' '),
      amount: netAmount,
      currency: div.currency,
      ticker: div.product || undefined,
      source: 'degiro',
      importBatch,
    });
  }

  // ── Unmatched dividend tax: standalone correction (wzorzec IBKR) ──
  // Podatek bez dywidendy o tym samym ISIN+timestampie (np. korekta WHT
  // z poprzedniego okresu) wcześniej znikał bez śladu i saldo dryfowało.
  for (const tax of taxRows) {
    if (usedTaxRows.has(tax.rowNum)) continue;
    if (tax.amount === 0) {
      skipped.push({ row: tax.rowNum, reason: 'zero_amount', paperName: tax.description });
      continue;
    }
    warnings.push(
      `DEGIRO: Podatek Dywidendowy ${tax.product} ${tax.date} bez pasującej dywidendy w pliku — ` +
        `zaimportowano jako samodzielną korektę`,
    );
    operations.push({
      date: parseDegiroDate(tax.date, tax.time),
      operationType: 'dividend',
      description: `${tax.product} — korekta podatku od dywidendy`,
      amount: tax.amount, // ujemna kwota wprost z CSV
      currency: tax.currency,
      ticker: tax.product || undefined,
      source: 'degiro',
      importBatch,
    });
  }

  // ── Deposits ──
  const depositRows = take((r) => r.description.startsWith('Depozyt'));
  for (const dep of depositRows) {
    if (dep.amount === 0) {
      skipped.push({ row: dep.rowNum, reason: 'zero_amount', paperName: dep.description });
      continue;
    }

    operations.push({
      date: parseDegiroDate(dep.date, dep.time),
      operationType: 'deposit',
      description: dep.description,
      amount: Math.abs(dep.amount),
      currency: dep.currency || 'PLN',
      source: 'degiro',
      importBatch,
    });
  }

  // ── Withdrawals ──
  const withdrawalRows = take(
    (r) => r.description === 'Wypłata' || r.description === 'flatex Withdrawal',
  );
  for (const wd of withdrawalRows) {
    if (wd.amount === 0) {
      skipped.push({ row: wd.rowNum, reason: 'zero_amount', paperName: wd.description });
      continue;
    }

    operations.push({
      date: parseDegiroDate(wd.date, wd.time),
      operationType: 'withdrawal',
      description: wd.description,
      amount: -Math.abs(wd.amount),
      currency: wd.currency || 'PLN',
      source: 'degiro',
      importBatch,
    });
  }

  // ── FX exchanges: ALL rows (with and without orderId) ──
  // Trade-related FX (with orderId) represent auto-conversions when buying/selling
  // foreign stocks — they are real cash movements and must be imported.
  const allFxCredits = take((r) => r.description === 'FX Credit');
  const allFxWithdrawals = take((r) => r.description === 'FX Withdrawal');
  const matchedWithdrawals = new Set<number>();

  for (const credit of allFxCredits) {
    // Try to pair: by orderId first (trade-linked), then by date+time (manual)
    let withdrawal: AccountRow | undefined;

    if (credit.orderId) {
      withdrawal = allFxWithdrawals.find(
        (w) => w.orderId === credit.orderId && !matchedWithdrawals.has(w.rowNum),
      );
    }
    if (!withdrawal) {
      withdrawal = allFxWithdrawals.find(
        (w) =>
          w.date === credit.date && w.time === credit.time && !matchedWithdrawals.has(w.rowNum),
      );
    }

    if (withdrawal) {
      matchedWithdrawals.add(withdrawal.rowNum);

      const fxRate = credit.rate || withdrawal.rate;
      const currencyFrom = withdrawal.currency;
      const currencyTo = credit.currency;
      const fxPair = `${currencyFrom}/${currencyTo}`;

      // FX Withdrawal side — use raw amount (already has correct sign from CSV)
      operations.push({
        date: parseDegiroDate(withdrawal.date, withdrawal.time),
        operationType: 'fx_exchange',
        description: `Wymiana ${currencyFrom}/${currencyTo}`,
        amount: withdrawal.amount,
        currency: currencyFrom,
        fxRate: fxRate || undefined,
        fxPair,
        source: 'degiro',
        importBatch,
      });

      // FX Credit side — use raw amount (already has correct sign from CSV)
      operations.push({
        date: parseDegiroDate(credit.date, credit.time),
        operationType: 'fx_exchange',
        description: `Wymiana ${currencyFrom}/${currencyTo}`,
        amount: credit.amount,
        currency: currencyTo,
        fxRate: fxRate || undefined,
        fxPair,
        source: 'degiro',
        importBatch,
      });
    } else {
      // Unmatched credit — still import for cash balance correctness
      operations.push({
        date: parseDegiroDate(credit.date, credit.time),
        operationType: 'fx_exchange',
        description: `FX Credit ${credit.currency}`,
        amount: credit.amount,
        currency: credit.currency,
        source: 'degiro',
        importBatch,
      });
    }
  }

  // Import any unmatched withdrawals
  for (const wd of allFxWithdrawals) {
    if (!matchedWithdrawals.has(wd.rowNum)) {
      operations.push({
        date: parseDegiroDate(wd.date, wd.time),
        operationType: 'fx_exchange',
        description: `FX Withdrawal ${wd.currency}`,
        amount: wd.amount,
        currency: wd.currency,
        source: 'degiro',
        importBatch,
      });
    }
  }

  // ── Fees / interest / payment charges / DEGIRO transaction fees ──
  const feeDescriptions = [
    'Odsetki',
    'Odsetki krótka sprzedaż',
    'Opłata za płatność Trustly-Sofort',
    'DEGIRO Opłata Transakcyjna i/lub opłata stron trzecich',
    'ADR/GDR Pass-Through Fee',
  ];
  const feeRows = take(
    (r) =>
      feeDescriptions.includes(r.description) ||
      r.description.startsWith('DEGIRO Exchange Connection Fee'),
  );
  for (const fee of feeRows) {
    if (fee.amount === 0) {
      skipped.push({ row: fee.rowNum, reason: 'zero_amount', paperName: fee.description });
      continue;
    }

    operations.push({
      date: parseDegiroDate(fee.date, fee.time),
      operationType: 'fee',
      description: fee.description,
      amount: fee.amount, // keep negative sign
      currency: fee.currency || 'EUR',
      source: 'degiro',
      importBatch,
    });
  }

  // Podatki transakcyjne obsługuje parseDegiroTransactionTaxes (dolicza je do
  // prowizji transakcji) — dla passu operacji są "skonsumowane", nie nieznane.
  take((r) => TRANSACTION_TAX_DESCRIPTIONS.includes(r.description));

  // ── Catch-all: wiersze spoza wszystkich allowlist ──
  // Wcześniej znikały bez śladu. NIE księgujemy ich na ślepo jako 'other'
  // (wiersze informacyjne zepsułyby saldo) — nieznany opis z kwotą ≠ 0 dostaje
  // ticket w skrzynce "Do wyjaśnienia": użytkownik klasyfikuje i dodaje wpis
  // ręcznie (flow resolve) albo ignoruje.
  for (const r of parsed) {
    if (consumed.has(r.rowNum)) continue;
    if (r.amount === 0) continue; // informacyjne (np. rezerwacje 0,00)
    if (INTERNAL_ROW_PATTERNS.some((re) => re.test(r.description))) continue;
    skipped.push({
      row: r.rowNum,
      reason: 'unknown_operation_type',
      paperName: r.description,
      raw: {
        rawType: r.description.toLowerCase(),
        headers: header,
        cells: rawCells.get(r.rowNum) ?? [],
        hint: {
          date: parseDegiroDate(r.date, r.time).slice(0, 10),
          amount: r.amount,
          currency: r.currency || undefined,
          symbol: r.product || undefined,
          description: r.description,
        },
      },
    });
  }

  return { data: operations, skipped, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * Extract transaction-specific taxes (Stamp Duty, French transaction tax)
 * from DEGIRO Account CSV. These should be added to the matching transaction's
 * commission rather than stored as separate operations.
 */
export interface TransactionTax {
  isin: string;
  date: string; // ISO 8601
  amount: number; // absolute value (always positive)
  description: string;
}

export function parseDegiroTransactionTaxes(csvContent: string): TransactionTax[] {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ',',
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  if (rows.length < 2) return [];

  const header = rows[0];
  if (!isDegiroAccountHeader(header)) return [];

  const taxDescriptions = TRANSACTION_TAX_DESCRIPTIONS;

  const taxes: TransactionTax[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 8) continue;

    const description = row[5]?.trim() || '';
    if (!taxDescriptions.includes(description)) continue;

    const dateStr = row[0]?.trim();
    const time = row[1]?.trim() || '00:00';
    const isin = row[4]?.trim() || '';
    const amount = parseNumber(row[8]);

    if (!dateStr || !isin || amount === 0) continue;

    taxes.push({
      isin,
      date: parseDegiroDate(dateStr, time),
      amount: Math.abs(amount),
      description,
    });
  }

  return taxes;
}

/**
 * Detect if CSV content looks like DEGIRO Account format.
 * Distinguished from DEGIRO Transactions by having "Opis" column instead of "Kurs wymian".
 */
export function isDegiroAccountFormat(csvContent: string): boolean {
  const firstLine = csvContent.split('\n')[0] || '';
  const lower = normalizeForDetect(firstLine);
  return (
    lower.includes('produkt') &&
    lower.includes('isin') &&
    lower.includes('opis') &&
    !lower.includes('kurs wymian')
  ); // Transactions CSV has "Kurs wymian", Account does not
}

function isDegiroAccountHeader(header: string[]): boolean {
  if (!header || header.length < 8) return false;
  const h0 = header[0]?.trim().toLowerCase();
  const h3 = header[3]?.trim().toLowerCase();
  const h5 = header[5]?.trim().toLowerCase();
  return h0 === 'data' && h3 === 'produkt' && h5 === 'opis';
}
