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

  it('P3: obcy XLSX z arkuszem „CASH OPERATION …" o innych kolumnach → NIE XTB', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('CASH OPERATION TRACKER');
    ws.addRow(['Project', 'Hours', 'Cost', 'Notes']); // brak kolumn XTB
    ws.addRow(['Alpha', 8, 1200, 'n/a']);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(await isXtbFormat(buf)).toBe(false);
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

describe('parseXtbFile — stary format: cena sprzedaży z P/L', () => {
  const oldFormatRows = (pl: number) => [
    {
      id: 1,
      type: 'Stock purchase',
      time: '10/01/2024 09:00:00',
      comment: 'OPEN BUY 80 @ 19.32',
      symbol: 'JSW.PL',
      amount: -1545.6,
    },
    {
      id: 2,
      type: 'Stock sale',
      time: '15/01/2024 10:00:00',
      comment: 'Return position #123 open nominal value',
      symbol: 'JSW.PL',
      amount: 1545.6,
    },
    {
      id: 3,
      type: 'close trade',
      time: '15/01/2024 10:00:00',
      comment: 'P/L',
      symbol: 'JSW.PL',
      amount: pl,
    },
  ];

  it('poprawna para Amount + P/L wyprowadza cenę sprzedaży', async () => {
    const buf = await buildXtbXlsx(oldFormatRows(454.4));
    const { transactions } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    const sell = transactions.data.find((t) => t.side === 'S');
    expect(sell?.quantity).toBe(80);
    // (1545.6 + 454.4) / 80 = 25
    expect(sell?.price).toBe(25);
  });

  it('ujemna wartość sprzedaży (P/L < -Amount) → skipped invalid_price, bez NaN w output', async () => {
    // saleValue = 1545.6 + (-2000) = -454.4 → cena niewyprowadzalna
    const buf = await buildXtbXlsx(oldFormatRows(-2000));
    const { transactions } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    // Tylko kupno przechodzi; sprzedaż wpada do skipped
    expect(transactions.data.filter((t) => t.side === 'S')).toHaveLength(0);
    const skip = transactions.skipped.find((s) => s.reason === 'invalid_price');
    expect(skip).toBeDefined();
    expect(skip?.paperName).toBe('JSW.PL');

    // Żadna transakcja nie może mieć NaN/Infinity w cenie ani wartości
    for (const t of transactions.data) {
      expect(Number.isFinite(t.price)).toBe(true);
      expect(Number.isFinite(t.value)).toBe(true);
      expect(Number.isFinite(t.total)).toBe(true);
    }
  });

  it('zerowa wartość sprzedaży (P/L = -Amount) → skipped invalid_price', async () => {
    const buf = await buildXtbXlsx(oldFormatRows(-1545.6));
    const { transactions } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    expect(transactions.data.filter((t) => t.side === 'S')).toHaveLength(0);
    expect(transactions.skipped.some((s) => s.reason === 'invalid_price')).toBe(true);
  });
});

describe('parseXtbFile — nieznane typy operacji', () => {
  it('wiersz z nieznanym typem → skipped unknown_type z nazwą typu + zagregowany warning', async () => {
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
        type: 'Mystery Operation',
        time: '11/01/2024 09:00:00',
        comment: 'Tajemniczy wiersz',
        symbol: 'ABC.PL',
        amount: -42,
      },
    ]);

    const result = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    // Per-row trace w skipped — user może odnaleźć wiersz po nazwie typu i symbolu
    const skip = result.operations.skipped.find((s) => s.reason === 'unknown_type');
    expect(skip).toBeDefined();
    expect(skip?.paperName).toContain('Mystery Operation');
    expect(skip?.paperName).toContain('ABC.PL');

    // Zagregowany warning z listą typów zostaje
    expect(result.warnings?.some((w) => w.includes('Mystery Operation'))).toBe(true);

    // Znany typ (deposit) NIE wpada do unknown_type
    expect(result.operations.skipped.filter((s) => s.reason === 'unknown_type')).toHaveLength(1);
  });
});

describe('parseXtbFile — prowizje przy dwóch trade-ach w tej samej sekundzie', () => {
  it('każda prowizja konsumuje kolejny trade (FIFO), nie dubluje się na jednym', async () => {
    const time = '10/01/2024 14:30:15';
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time,
        comment: 'OPEN BUY 10 @ 20.00',
        symbol: 'PLTR.US',
        amount: -200,
      },
      {
        id: 2,
        type: 'Stock purchase',
        time,
        comment: 'OPEN BUY 5 @ 20.00',
        symbol: 'PLTR.US',
        amount: -100,
      },
      { id: 3, type: 'commission', time, comment: 'prowizja 1', symbol: 'PLTR.US', amount: -1 },
      { id: 4, type: 'commission', time, comment: 'prowizja 2', symbol: 'PLTR.US', amount: -2 },
    ]);

    const { transactions } = await parseXtbFile(buf, 'batch-1', 'USD_12345_test.xlsx');
    expect(transactions.data).toHaveLength(2);

    // Pierwsza prowizja → pierwszy trade, druga → drugi (przedtem obie lądowały na tym samym)
    expect(transactions.data[0].commission).toBe(1);
    expect(transactions.data[0].total).toBe(201);
    expect(transactions.data[1].commission).toBe(2);
    expect(transactions.data[1].total).toBe(102);
  });

  it('nadmiarowa prowizja (więcej prowizji niż trade-ów) kumuluje się na ostatnim trade', async () => {
    const time = '10/01/2024 14:30:15';
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time,
        comment: 'OPEN BUY 10 @ 20.00',
        symbol: 'PLTR.US',
        amount: -200,
      },
      { id: 2, type: 'commission', time, comment: 'prowizja 1', symbol: 'PLTR.US', amount: -1 },
      { id: 3, type: 'commission', time, comment: 'prowizja 2', symbol: 'PLTR.US', amount: -2 },
    ]);

    const { transactions } = await parseXtbFile(buf, 'batch-1', 'USD_12345_test.xlsx');
    expect(transactions.data).toHaveLength(1);
    expect(transactions.data[0].commission).toBe(3);
  });
});
