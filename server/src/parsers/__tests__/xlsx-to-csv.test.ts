import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { cellToString, sheetToCsv, loadXlsxSheets, looksLikeXlsx } from '../xlsx-to-csv.js';

/**
 * Testy warstwy XLSX→CSV. Syntetyczne skoroszyty budowane w pamięci ExcelJS —
 * pokrywają komórki dat (czas lokalny), formuł (.result), richText oraz
 * wieloarkuszowość. Pełny parytet na realnym XTB pilnuje harness.
 */

async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('cellToString', () => {
  it('data → "YYYY-MM-DD HH:mm:ss" w czasie ścianowym z pliku (UTC, niezależnie od TZ)', () => {
    const d = new Date(Date.UTC(2025, 2, 14, 9, 30, 2)); // ExcelJS: wall-clock w UTC
    expect(cellToString(d)).toBe('2025-03-14 09:30:02');
  });

  it('formuła → wartość z .result', () => {
    expect(cellToString({ formula: 'A1*2', result: 84 } as ExcelJS.CellValue)).toBe('84');
  });

  it('richText → sklejony tekst fragmentów', () => {
    expect(
      cellToString({ richText: [{ text: 'CD ' }, { text: 'Projekt' }] } as ExcelJS.CellValue),
    ).toBe('CD Projekt');
  });

  it('hyperlink-like {text} → text; null/undefined → ""', () => {
    expect(cellToString({ text: 'Apple', hyperlink: 'x' } as ExcelJS.CellValue)).toBe('Apple');
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
  });

  it('liczba i string przez String()', () => {
    expect(cellToString(123.45)).toBe('123.45');
    expect(cellToString('USD')).toBe('USD');
  });
});

describe('sheetToCsv + loadXlsxSheets', () => {
  it('pojedynczy arkusz → CSV ze średnikiem, liczba wierszy', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Transactions');
    ws.addRow(['Date', 'Ticker', 'Qty']);
    ws.addRow(['2025-01-02', 'AAPL', 4]);
    ws.addRow(['2025-01-03', 'MSFT', 2]);

    const buf = await workbookToBuffer(wb);
    const sheets = await loadXlsxSheets(buf);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Transactions');
    expect(sheets[0].rowCount).toBe(3);
    const lines = sheets[0].csv.split(/\r?\n/);
    expect(lines[0]).toBe('Date;Ticker;Qty');
    expect(lines[1]).toBe('2025-01-02;AAPL;4');
  });

  it('wiele arkuszy → wszystkie, w kolejności z pliku', async () => {
    const wb = new ExcelJS.Workbook();
    const t = wb.addWorksheet('Cash Operations');
    t.addRow(['Type', 'Amount']);
    t.addRow(['deposit', 1000]);
    const c = wb.addWorksheet('Closed Positions');
    c.addRow(['Instrument', 'Ticker']);
    c.addRow(['Apple', 'AAPL.US']);
    const empty = wb.addWorksheet('Info'); // arkusz prawie pusty
    empty.addRow(['Wygenerowano']);

    const buf = await workbookToBuffer(wb);
    const sheets = await loadXlsxSheets(buf);
    expect(sheets.map((s) => s.name)).toEqual(['Cash Operations', 'Closed Positions', 'Info']);
    expect(sheets[0].csv.split(/\r?\n/)[1]).toBe('deposit;1000');
    expect(sheets[1].csv.split(/\r?\n/)[1]).toBe('Apple;AAPL.US');
    expect(sheets[2].rowCount).toBe(1); // okładkę odfiltruje próg arkusza-danych wyżej
  });

  it('wartość zawierająca średnik jest cytowana (PapaParse)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Desc']);
    ws.addRow(['a;b']);
    const buf = await workbookToBuffer(wb);
    const sheets = await loadXlsxSheets(buf);
    expect(sheets[0].csv).toContain('"a;b"');
  });
});

describe('looksLikeXlsx', () => {
  it('rozpoznaje sygnaturę ZIP/XLSX, odrzuca tekst', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('X').addRow(['a']);
    const buf = await workbookToBuffer(wb);
    expect(looksLikeXlsx(buf)).toBe(true);
    expect(looksLikeXlsx(Buffer.from('Date,Ticker\n2025-01-01,AAPL', 'utf-8'))).toBe(false);
  });
});

// ── Kontrola archiwum przed dekompresją (zip bomb) ──

/** Minimalny ZIP: sam katalog centralny + EOCD — kontrola nie czyta danych wpisów. */
function fakeZip(entries: { compressed: number; uncompressed: number }[]): Buffer {
  const cen = entries.map((e, i) => {
    const name = Buffer.from(`xl/f${i}.xml`);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt32LE(e.compressed, 20);
    h.writeUInt32LE(e.uncompressed, 24);
    h.writeUInt16LE(name.length, 28);
    return Buffer.concat([h, name]);
  });
  const cd = Buffer.concat(cen);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(0, 16); // katalog od początku bufora
  return Buffer.concat([cd, eocd]);
}

describe('assertSafeXlsxArchive', () => {
  it('przepuszcza realny skoroszyt', async () => {
    const { assertSafeXlsxArchive } = await import('../xlsx-to-csv.js');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('A').addRow(['x', 1]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect(() => assertSafeXlsxArchive(buf)).not.toThrow();
  });

  it('odrzuca wpis z kompresją >200× i >10 MB (bomba)', async () => {
    const { assertSafeXlsxArchive, XlsxRejectedError } = await import('../xlsx-to-csv.js');
    const zip = fakeZip([{ compressed: 20_000, uncompressed: 50 * 1024 * 1024 }]);
    expect(() => assertSafeXlsxArchive(zip)).toThrow(XlsxRejectedError);
  });

  it('odrzuca sumę po rozpakowaniu ponad limit', async () => {
    const { assertSafeXlsxArchive } = await import('../xlsx-to-csv.js');
    const many = Array.from({ length: 20 }, () => ({
      compressed: 5 * 1024 * 1024,
      uncompressed: 9 * 1024 * 1024,
    }));
    expect(() => assertSafeXlsxArchive(fakeZip(many))).toThrow(/zbyt duży/);
  });

  it('odrzuca ZIP64 i śmieci bez katalogu', async () => {
    const { assertSafeXlsxArchive } = await import('../xlsx-to-csv.js');
    expect(() =>
      assertSafeXlsxArchive(fakeZip([{ compressed: 0xffffffff, uncompressed: 0xffffffff }])),
    ).toThrow(/ZIP64/);
    expect(() => assertSafeXlsxArchive(Buffer.alloc(100))).toThrow(/uszkodzony/);
  });

  it('XlsxRejectedError niesie status 400 dla globalnego handlera', async () => {
    const { XlsxRejectedError } = await import('../xlsx-to-csv.js');
    expect(new XlsxRejectedError('x').status).toBe(400);
  });

  it('loadWorkbook: ten sam bufor ładowany raz (cache per obiekt)', async () => {
    const { loadWorkbook } = await import('../xlsx-to-csv.js');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('A').addRow(['x']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const [a, b] = await Promise.all([loadWorkbook(buf), loadWorkbook(buf)]);
    expect(a).toBe(b);
  });
});
