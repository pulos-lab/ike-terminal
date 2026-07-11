import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { isStrictNumber, detectColumnShift } from '../utils.js';
import { parseBossaTransactions } from '../bossa-transactions.js';
import { parseBossaOperations } from '../bossa-operations.js';
import { parseMbankTransactions } from '../mbank-transactions.js';
import { parseMbankOperations } from '../mbank-operations.js';
import { parseDegiroTransactions } from '../degiro-transactions.js';
import { parseDegiroOperations } from '../degiro-operations.js';
import { parseXtbFile } from '../xtb-transactions.js';
import { decodeCSVBuffer } from '../encoding.js';

/**
 * Walidacja struktury wierszy CSV/XLSX — ochrona przed cichym przesunięciem
 * kolumn (dodatkowy separator w polu przesuwa wartości do złych kolumn,
 * parseNumber('12abc')=12 przechodzi bez sygnału).
 *
 * Zasady (wnioski z review PR #143 — NIE powielać tamtych błędów):
 *  - wykrywamy sygnałami TREŚCI (liczba w kolumnie waluty, tekst w liczbowej,
 *    brak daty), NIE liczbą kolumn,
 *  - nadmiarowe kolumny PO PRAWEJ i puste __parsed_extra (trailing separator)
 *    są nieszkodliwe — tolerowane,
 *  - jeden wspólny helper (utils.detectColumnShift) we WSZYSTKICH parserach,
 *  - odrzucony wiersz = skipped(column_shift) + warning z numerem wiersza
 *    i surową treścią.
 */

// ── Helper: isStrictNumber / detectColumnShift ──────────────────────────────

describe('isStrictNumber', () => {
  it('akceptuje formaty liczb obsługiwane przez parseNumber', () => {
    for (const v of ['150.50', '58,10', '1 234,56', '1.234,56', '1,234.56', '-11,11', '+5', '0']) {
      expect(isStrictNumber(v), v).toBe(true);
    }
  });

  it('odrzuca częściowe dopasowania, które parseNumber cicho przepuszcza', () => {
    for (const v of ['12abc', 'abc', 'PLN', '43,7000 PLN', '12.5.3', 'K']) {
      expect(isStrictNumber(v), v).toBe(false);
    }
  });
});

describe('detectColumnShift', () => {
  it('puste pola nie są sygnałem przesunięcia (braki łapie walidacja parsera)', () => {
    expect(
      detectColumnShift([
        { label: 'kwota', value: '', kind: 'number' },
        { label: 'waluta', value: undefined, kind: 'currency' },
        { label: 'data', value: '  ', kind: 'date' },
      ]),
    ).toHaveLength(0);
  });

  it('flaguje tekst w kolumnie liczbowej, liczbę w walutowej i brak daty', () => {
    const problems = detectColumnShift([
      { label: 'kwota', value: '12abc', kind: 'number' },
      { label: 'waluta', value: '200', kind: 'currency' },
      { label: 'data', value: '58,10', kind: 'date' },
    ]);
    expect(problems).toHaveLength(3);
  });

  it('akceptuje daty we wszystkich konwencjach parserów', () => {
    for (const v of ['25.02.2026', '25.02.2026 09:47:27', '2026-04-13', '27-03-2024']) {
      expect(detectColumnShift([{ label: 'data', value: v, kind: 'date' }]), v).toHaveLength(0);
    }
  });
});

// ── Bossa transakcje (hisPW) ────────────────────────────────────────────────

const BOSSA_TX_HEADER = 'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta';

describe('parseBossaTransactions — przesunięcie kolumn', () => {
  it('dodatkowy średnik w polu wartości → skip column_shift + warning z treścią wiersza', () => {
    // "1;505,00" w kolumnie wartość: prowizja/po prowizji/waluta przesunięte w prawo,
    // 'PLN' ląduje w __parsed_extra, a kolumna waluta dostaje kwotę.
    const csv = [
      BOSSA_TX_HEADER,
      '25.02.2026 10:00:00;KGHM;PLKGHM000017;10;K;150,50;1;505,00;5,00;1510,00;PLN',
    ].join('\n');
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('column_shift');
    expect(result.skipped[0].row).toBe(2);
    expect(result.warnings?.[0]).toContain('Wiersz 2');
    expect(result.warnings?.[0]).toContain('KGHM');
  });

  it('toleruje trailing średnik (__parsed_extra=[""]) i nadmiarową kolumnę po prawej', () => {
    const csv = [
      `${BOSSA_TX_HEADER};Extra`,
      '25.02.2026 10:00:00;KGHM;PLKGHM000017;10;K;150,50;1505,00;5,00;1510,00;PLN;cokolwiek;',
    ].join('\n');
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.skipped).toHaveLength(0);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].price).toBe(150.5);
  });
});

// ── Bossa operacje ──────────────────────────────────────────────────────────

describe('parseBossaOperations — przesunięcie kolumn', () => {
  it('średnik w tytule operacji → kwota ląduje w walucie → skip column_shift', () => {
    // Zgłoszony scenariusz: "Zwrot nadpłaty PRAGMAGO D4;" — tytuł z dodatkowym
    // średnikiem przesuwa kwotę do kolumny waluty.
    const csv = [
      'data;tytuł operacji;szczegóły;kwota;waluta',
      '2026-04-13;Zwrot nadpłaty PRAGMAGO;D4;;200;PLN',
      '2026-04-14;Przelew do DM;;1000,00;PLN',
    ].join('\n');
    const result = parseBossaOperations(csv, 'batch-test');

    const shiftSkips = result.skipped.filter((s) => s.reason === 'column_shift');
    expect(shiftSkips).toHaveLength(1);
    expect(shiftSkips[0].row).toBe(2);
    expect(result.warnings?.some((w) => w.includes('Wiersz 2'))).toBe(true);
    // Zdrowy wiersz przechodzi normalnie.
    expect(result.data).toHaveLength(1);
    expect(result.data[0].amount).toBe(1000);
  });
});

// ── mBank transakcje ────────────────────────────────────────────────────────

const MBANK_TX_HEADER =
  'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta';

describe('parseMbankTransactions — przesunięcie kolumn', () => {
  it('dodatkowy średnik w polu Kurs → waluta dostaje liczbę → skip column_shift', () => {
    const csv = [
      MBANK_TX_HEADER,
      '25.02.2026 09:47:27;KGHM;WWA-GPW;K;10;150;50;PLN;5,00;1505,00;PLN',
      '25.02.2026 10:00:00;PKN;WWA-GPW;K;5;60,00;PLN;3,00;PLN;300,00;PLN',
    ].join('\n');
    const result = parseMbankTransactions(csv, 'batch-test');

    const shiftSkips = result.skipped.filter((s) => s.reason === 'column_shift');
    expect(shiftSkips).toHaveLength(1);
    expect(shiftSkips[0].paperName).toBe('KGHM');
    expect(result.warnings?.some((w) => w.includes('przesun'))).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].paperName).toBe('PKN');
  });
});

// ── mBank operacje ──────────────────────────────────────────────────────────

describe('parseMbankOperations — przesunięcie kolumn', () => {
  it('średnik w Opisie → Kwota dostaje resztę opisu → skip column_shift', () => {
    const csv = [
      'Data;Opis;Kwota',
      '01.03.2026;WYC.BK: 600622; POZ: 1788464;1000,00',
      '02.03.2026;WYC.BK: 600623 POZ: 1788465;500,00',
    ].join('\n');
    const result = parseMbankOperations(csv, 'batch-test');

    const shiftSkips = result.skipped.filter((s) => s.reason === 'column_shift');
    expect(shiftSkips).toHaveLength(1);
    expect(result.warnings?.some((w) => w.includes('Kwota'))).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].amount).toBe(500);
  });
});

// ── DEGIRO transakcje ───────────────────────────────────────────────────────

const DEGIRO_TX_HEADER =
  'Data,Czas,Produkt,ISIN,Giełda referencyjna,Miejsce wykonania,Liczba,Kurs,,' +
  'Wartość lokalna,,Wartość EUR,Kurs wymiany,Opłaty AutoFX,' +
  'Opłata transakcyjna DEGIRO i/lub opłata stron,Razem EUR,Identyfikator zlecenia,';

describe('parseDegiroTransactions — przesunięcie kolumn', () => {
  it('niecytowany przecinek w nazwie produktu → wszystko przesunięte → skip column_shift', () => {
    // "ML SYSTEM, SA" bez cudzysłowów: ISIN='SA', Liczba='XWAR' (tekst) itd.
    const csv = [
      DEGIRO_TX_HEADER,
      '27-03-2024,11:41,ML SYSTEM, SA,PLMLSTM00015,WSE,XWAR,-70,"43,7000",PLN,"3059,00",PLN,"709,30","4,3127","0,00",,"709,30",,id-1',
      '27-03-2024,11:41,ML SYSTEM SA,PLMLSTM00015,WSE,XWAR,-70,"43,7000",PLN,"3059,00",PLN,"709,30","4,3127","0,00",,"709,30",,id-2',
    ].join('\n');
    const result = parseDegiroTransactions(csv, 'batch-test');

    const shiftSkips = result.skipped.filter((s) => s.reason === 'column_shift');
    expect(shiftSkips).toHaveLength(1);
    expect(shiftSkips[0].row).toBe(2);
    expect(result.warnings?.some((w) => w.includes('Wiersz 2'))).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].paperName).toBe('ML SYSTEM SA');
    expect(result.data[0].quantity).toBe(70);
  });
});

// ── DEGIRO operacje (Account) ───────────────────────────────────────────────

const DEGIRO_ACC_HEADER =
  'Data,Czas,Data,Produkt,ISIN,Opis,Kurs,Zmiana,,Saldo,,Identyfikator zlecenia';

describe('parseDegiroOperations — przesunięcie kolumn', () => {
  it('niecytowany przecinek w Opisie → Kurs dostaje tekst → skip column_shift', () => {
    const csv = [
      DEGIRO_ACC_HEADER,
      '01-03-2024,10:00,01-03-2024,,,Depozyt, Trustly,PLN,"1000,00",PLN,"1000,00",',
      '02-03-2024,10:00,02-03-2024,,,Depozyt,,PLN,"500,00",PLN,"1500,00",',
    ].join('\n');
    const result = parseDegiroOperations(csv, 'batch-test');

    const shiftSkips = result.skipped.filter((s) => s.reason === 'column_shift');
    expect(shiftSkips).toHaveLength(1);
    expect(shiftSkips[0].row).toBe(2);
    expect(result.warnings?.some((w) => w.includes('Wiersz 2'))).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].amount).toBe(500);
  });
});

// ── XTB (XLSX) ──────────────────────────────────────────────────────────────

describe('parseXtbFile — walidacja kolumny Amount + prawdziwe numery wierszy', () => {
  /** Arkusz z pustym wierszem 2 — numery skipped/warnings muszą być numerami
   *  ARKUSZA (ExcelJS row.number), nie indeksem po includeEmpty:false. */
  async function buildXtb(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('CASH OPERATION HISTORY');
    ws.getRow(1).values = ['ID', 'Type', 'Time', 'Comment', 'Symbol', 'Amount'];
    // wiersz 2 celowo pusty
    ws.getRow(3).values = [1, 'deposit', '10/01/2024 09:00:00', 'Wpłata', '', 5000];
    ws.getRow(4).values = [2, 'deposit', '11/01/2024 09:00:00', 'Wpłata', '', '12abc'];
    ws.getRow(5).values = [3, 'deposit', '12/01/2024 09:00:00', 'Wpłata', '', '1 234,56'];
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }

  it('tekst w kolumnie Amount → skip column_shift z numerem wiersza ARKUSZA', async () => {
    const { transactions, operations, warnings } = await parseXtbFile(await buildXtb(), 'batch');

    const shiftSkips = transactions.skipped.filter((s) => s.reason === 'column_shift');
    expect(shiftSkips).toHaveLength(1);
    expect(shiftSkips[0].row).toBe(4); // numer arkusza (pusty wiersz 2 nie zaburza)
    expect(warnings?.some((w) => w.includes('Wiersz 4') && w.includes('12abc'))).toBe(true);

    // Zdrowe wpłaty przechodzą; tekstowa kwota "1 234,56" parsowana po europejsku
    // (parseNumber), nie parseFloat=1.
    const deposits = operations.data.filter((o) => o.operationType === 'deposit');
    expect(deposits.map((d) => d.amount).sort((a, b) => a - b)).toEqual([1234.56, 5000]);
  });
});

// ── Golden: realne pliki z import/ — 100% wierszy zdrowych plików przechodzi ─

const IMPORT_DIR = path.resolve(__dirname, '../../../../import');
const hasImportDir = fs.existsSync(IMPORT_DIR);

/** Wszystkie pliki (rekursywnie) spełniające predykat nazwy. */
function listFiles(dir: string, pred: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .filter((f) => pred(path.basename(f).toLowerCase()))
    .map((f) => path.join(dir, f));
}

function expectNoShift(
  file: string,
  result: { skipped: Array<{ reason: string; row: number }>; warnings?: string[] },
  dataLen: number,
) {
  const shifts = result.skipped.filter((s) => s.reason === 'column_shift');
  expect(shifts, `${path.basename(file)}: ${JSON.stringify(shifts)}`).toHaveLength(0);
  const shiftWarnings = (result.warnings ?? []).filter((w) => w.includes('przesun'));
  expect(shiftWarnings, path.basename(file)).toHaveLength(0);
  expect(dataLen, `${path.basename(file)}: brak danych`).toBeGreaterThan(0);
}

describe.skipIf(!hasImportDir)('golden — zdrowe realne pliki bez column_shift', () => {
  it('Bossa hisPW (transakcje)', () => {
    const files = listFiles(path.join(IMPORT_DIR, 'bossa'), (f) => f.startsWith('hispw'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      const result = parseBossaTransactions(csv, 'golden');
      expectNoShift(file, result, result.data.length);
    }
  });

  it('Bossa operacje_bez_transakcji', () => {
    const files = listFiles(path.join(IMPORT_DIR, 'bossa'), (f) => f.includes('operacje'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      const result = parseBossaOperations(csv, 'golden');
      expectNoShift(file, result, result.data.length);
    }
  });

  it('DEGIRO Transactions', () => {
    const files = listFiles(path.join(IMPORT_DIR, 'Degiro'), (f) => f.startsWith('transactions'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      const result = parseDegiroTransactions(csv, 'golden');
      expectNoShift(file, result, result.data.length);
    }
  });

  it('DEGIRO Account (operacje)', () => {
    const files = listFiles(path.join(IMPORT_DIR, 'Degiro'), (f) => f.startsWith('account'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      const result = parseDegiroOperations(csv, 'golden');
      expectNoShift(file, result, result.data.length);
    }
  });

  it('XTB XLSX', async () => {
    const files = listFiles(path.join(IMPORT_DIR, 'xtb'), (f) => f.endsWith('.xlsx'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { transactions, operations, warnings } = await parseXtbFile(
        fs.readFileSync(file),
        'golden',
        path.basename(file),
      );
      const skipped = [...transactions.skipped, ...operations.skipped];
      expectNoShift(file, { skipped, warnings }, transactions.data.length + operations.data.length);
    }
  });
});
