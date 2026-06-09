import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseXtbFile, isXtbFormat } from '../xtb-transactions.js';

/**
 * Buduje minimalny plik XTB (arkusz CASH OPERATION HISTORY) w pamięci.
 * Układ kolumn: OLD EN — ID | Type | Time | Comment | Symbol | Amount.
 */
async function buildXtbXlsx(
  rows: Array<{
    id: number;
    type: string;
    time: string;
    comment: string;
    symbol: string;
    amount: number;
  }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('CASH OPERATION HISTORY');
  ws.addRow(['ID', 'Type', 'Time', 'Comment', 'Symbol', 'Amount']);
  for (const r of rows) {
    ws.addRow([r.id, r.type, r.time, r.comment, r.symbol, r.amount]);
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

describe('parseXtbFile — deposits/withdrawals', () => {
  it('rozpoznaje format XTB', async () => {
    const buf = await buildXtbXlsx([]);
    expect(await isXtbFormat(buf)).toBe(true);
  });

  it('zwykła wpłata i wypłata zachowują naturalne znaki', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'deposit',
        time: '10/01/2024 09:00:00',
        comment: 'Wpłata',
        symbol: '',
        amount: 5000,
      },
      {
        id: 2,
        type: 'withdrawal',
        time: '12/01/2024 09:00:00',
        comment: 'Wypłata',
        symbol: '',
        amount: -1000,
      },
    ]);

    const { operations } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');
    const deposit = operations.data.find((o) => o.operationType === 'deposit');
    const withdrawal = operations.data.find((o) => o.operationType === 'withdrawal');

    expect(deposit?.amount).toBe(5000);
    expect(withdrawal?.amount).toBe(-1000);
    expect(deposit?.currency).toBe('PLN');
  });

  it('storno wpłaty (ujemny deposit) trafia jako withdrawal, nie fałszywa wpłata', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'deposit',
        time: '10/01/2024 09:00:00',
        comment: 'Wpłata',
        symbol: '',
        amount: 5000,
      },
      {
        id: 2,
        type: 'deposit',
        time: '11/01/2024 09:00:00',
        comment: 'Korekta wpłaty',
        symbol: '',
        amount: -5000,
      },
    ]);

    const { operations } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');
    const reversal = operations.data.find((o) => o.description === 'Korekta wpłaty');

    expect(reversal?.operationType).toBe('withdrawal');
    expect(reversal?.amount).toBe(-5000);
    // suma wpłat netto = 0, a nie 10000
    const totalDeposits = operations.data
      .filter((o) => o.operationType === 'deposit')
      .reduce((s, o) => s + o.amount, 0);
    expect(totalDeposits).toBe(5000);
  });

  it('odwrócona wypłata (dodatni withdrawal) trafia jako deposit', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'withdrawal',
        time: '10/01/2024 09:00:00',
        comment: 'Zwrot wypłaty',
        symbol: '',
        amount: 1000,
      },
    ]);

    const { operations } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');
    expect(operations.data[0]?.operationType).toBe('deposit');
    expect(operations.data[0]?.amount).toBe(1000);
  });

  it('wpłata z nieparsowalną datą trafia do skipped z powodem invalid_date', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'deposit',
        time: 'nie-data',
        comment: 'Zepsuta wpłata',
        symbol: '',
        amount: 5000,
      },
    ]);

    const { operations } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');
    expect(operations.data).toHaveLength(0);
    expect(operations.skipped).toHaveLength(1);
    expect(operations.skipped[0].reason).toBe('invalid_date');
  });
});
