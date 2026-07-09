import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseXtbFile } from '../xtb-transactions.js';

/**
 * Buduje plik XTB z wierszami o zdefiniowanej liczbie kolumn.
 * Normalnie: 6 kolumn (ID, Type, Time, Comment, Symbol, Amount).
 * Extra cols = dodatkowe puste kolumny za Amount.
 */
async function buildXtbWithExtraCols(extraCols: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('CASH OPERATION HISTORY');
  ws.addRow(['ID', 'Type', 'Time', 'Comment', 'Symbol', 'Amount']);
  // Normalny wiersz z 6 kolumnami + dodatkowe puste
  const row: (string | number)[] = [1, 'deposit', '01/01/2026 10:00:00', 'Wpłata', '', 5000];
  for (let i = 0; i < extraCols; i++) row.push('');
  ws.addRow(row);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

describe('xtb-transactions quarantine', () => {
  it('correct XLSX (6 cols) → data, no quarantine', async () => {
    const buf = await buildXtbWithExtraCols(0);
    const result = await parseXtbFile(buf, 'batch-test', 'test.xlsx');
    expect(result.operations.data.length).toBeGreaterThan(0);
    expect(result.transactions.quarantine).toBeUndefined();
  });

  it('row with extra columns → malformed quarantine', async () => {
    const buf = await buildXtbWithExtraCols(3); // 6 + 3 = 9 cols > expected 6
    const result = await parseXtbFile(buf, 'batch-test', 'test.xlsx');
    expect(result.transactions.quarantine).toBeDefined();
    expect(result.transactions.quarantine).toHaveLength(1);
    expect(result.transactions.quarantine![0].severity).toBe('malformed');
    expect(result.transactions.quarantine![0].reason).toBe('column_count_mismatch');
    expect(result.transactions.quarantine![0].message).toContain('9');
    expect(result.transactions.quarantine![0].message).toContain('6');
  });

  it('row with exactly expected columns → no quarantine', async () => {
    // 6 cols = expected, no quarantine
    const buf = await buildXtbWithExtraCols(0);
    const result = await parseXtbFile(buf, 'batch-test', 'test.xlsx');
    expect(result.transactions.quarantine).toBeUndefined();
  });
});
