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
  it('data → "YYYY-MM-DD HH:mm:ss" w czasie lokalnym', () => {
    const d = new Date(2025, 2, 14, 9, 30, 2); // 2025-03-14 09:30:02 lokalnie
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
