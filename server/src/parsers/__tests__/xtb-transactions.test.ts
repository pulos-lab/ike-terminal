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

// ── Detekcja waluty notowania z kwoty rozliczenia (konto PLN + instrument USD) ──

describe('parseXtbFile — detekcja waluty z |Amount| vs qty×cena', () => {
  const t = '05/03/2024 10:00:00';

  it('kupno USD z konta PLN: currency z suffixu, fxRate implikowany, cena w USD', async () => {
    // EIMI-like: 83 szt @ 45.73 USD, debet PLN = 83×45.73×3.6995
    const amountPln = -(83 * 45.73 * 3.6995);
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: t,
        comment: 'OPEN BUY 83 @ 45.73',
        symbol: 'EIMI.US',
        amount: amountPln,
      },
    ]);
    const { transactions, warnings } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    expect(transactions.data).toHaveLength(1);
    const tx = transactions.data[0];
    expect(tx.currency).toBe('USD');
    expect(tx.paymentCurrency).toBe('PLN');
    expect(tx.price).toBe(45.73); // NIE przeliczona
    expect(tx.value).toBeCloseTo(83 * 45.73, 2);
    expect(tx.fxRate).toBeCloseTo(3.6995, 4);
    // total × fxRate odtwarza debet PLN z pliku
    expect(tx.total * tx.fxRate!).toBeCloseTo(Math.abs(amountPln), 0);
    expect(warnings?.some((w) => w.includes('EIMI.US → USD'))).toBe(true);
  });

  it('ratio ≈ 1 (ISAC.UK na koncie USD): status quo — waluta konta, bez fxRate', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: t,
        comment: 'OPEN BUY 2 @ 104.46',
        symbol: 'ISAC.UK',
        amount: -208.92,
      },
    ]);
    const { transactions } = await parseXtbFile(buf, 'b1', 'USD_12345_test.xlsx');
    const tx = transactions.data[0];
    expect(tx.currency).toBe('USD');
    expect(tx.paymentCurrency).toBe('USD');
    expect(tx.fxRate).toBeUndefined();
  });

  it('sprzedaż z wierszem close trade: kurs z (|Amount| + P/L) / (qty×cena)', async () => {
    // Realne liczby PLTR: sprzedaż 64 @ 26.07 USD; Amount = zwrócony nominał
    // 3918.85 PLN, P/L = 2249.35 PLN → kurs 6168.20/1668.48 ≈ 3.6969
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'close trade',
        time: t,
        comment: 'Profit of position #312803969',
        symbol: 'PLTR.US',
        amount: 2249.35,
      },
      {
        id: 2,
        type: 'Stock sale',
        time: t,
        comment: 'CLOSE BUY 64 @ 26.07',
        symbol: 'PLTR.US',
        amount: 3918.85,
      },
    ]);
    const { transactions } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    expect(transactions.data).toHaveLength(1);
    const tx = transactions.data[0];
    expect(tx.side).toBe('S');
    expect(tx.currency).toBe('USD');
    expect(tx.price).toBe(26.07);
    expect(tx.fxRate).toBeCloseTo((3918.85 + 2249.35) / (64 * 26.07), 5);
  });

  it('partial fille zamykane w tej samej sekundzie: każda sprzedaż konsumuje WŁASNY close trade (FIFO)', async () => {
    // Scenariusz BABA z realnego pliku: 2 sprzedaże "CLOSE BUY 2/4" pod tym samym
    // kluczem symbol|czas, każda z własnym wierszem close trade. Sumowanie P/L
    // pod kluczem wliczałoby obu sprzedażom łączny P/L → kursy 2.92/2.69 zamiast ~3.66.
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'close trade',
        time: t,
        comment: 'Profit of position #315689317',
        symbol: 'BABA.US',
        amount: -432.07,
      },
      {
        id: 2,
        type: 'Stock sale',
        time: t,
        comment: 'CLOSE BUY 2/4 @ 222.03',
        symbol: 'BABA.US',
        amount: 2057.02,
      },
      {
        id: 3,
        type: 'close trade',
        time: t,
        comment: 'Profit of position #321161138',
        symbol: 'BABA.US',
        amount: -330.2,
      },
      {
        id: 4,
        type: 'Stock sale',
        time: t,
        comment: 'CLOSE BUY 2/4 @ 222.03',
        symbol: 'BABA.US',
        amount: 1955.15,
      },
    ]);
    const { transactions } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const sells = transactions.data.filter((x) => x.side === 'S');
    expect(sells).toHaveLength(2);
    // FIFO: pierwsza sprzedaż bierze pierwszy P/L, druga — drugi.
    expect(sells[0].fxRate).toBeCloseTo((2057.02 - 432.07) / (2 * 222.03), 4); // ≈3.659
    expect(sells[1].fxRate).toBeCloseTo((1955.15 - 330.2) / (2 * 222.03), 4); // ≈3.659
    expect(sells.every((s) => s.currency === 'USD')).toBe(true);
  });

  it('sprzedaż bez close trade po kupnie FX (stary szablon): etykieta z pamięci, fxRate undefined', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: '01/03/2024 10:00:00',
        comment: 'OPEN BUY 64 @ 16.00',
        symbol: 'PLTR.US',
        amount: -(64 * 16 * 3.8),
      },
      // Obcy wiersz close trade — plik MA wiersze close trade (stary szablon,
      // Amount sprzedaży = zwrócony nominał), ale nie dla tej sprzedaży.
      {
        id: 2,
        type: 'close trade',
        time: '02/03/2024 10:00:00',
        comment: 'Profit of position #999',
        symbol: 'INNY.US',
        amount: 10,
      },
      {
        id: 3,
        type: 'Stock sale',
        time: t,
        comment: 'CLOSE BUY 64 @ 26.07',
        symbol: 'PLTR.US',
        amount: 3891.2, // zwrócony nominał otwarcia, BEZ pary close trade
      },
    ]);
    const { transactions, warnings } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const sell = transactions.data.find((x) => x.side === 'S' && x.paperName.startsWith('PLTR'))!;
    expect(sell.currency).toBe('USD');
    expect(sell.paymentCurrency).toBe('PLN');
    expect(sell.fxRate).toBeUndefined();
    expect(warnings?.some((w) => w.includes('close trade') && w.includes('PLTR.US'))).toBe(true);
  });

  it('nowy szablon (zero wierszy close trade w pliku): Amount sprzedaży = pełna wartość → kurs wprost', async () => {
    // Zweryfikowane na realnym eksporcie IKE_*: PEO 0.3507 @ 228.90 → Amount 80.28
    // (ratio 1.0), UBI.FR 15 @ 4.000 → Amount 252.04 (ratio = EURPLN 4.20).
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock sell',
        time: t,
        comment: 'CLOSE BUY 15 @ 4.000',
        symbol: 'UBI.FR',
        amount: 252.04,
      },
      {
        id: 2,
        type: 'Stock sell',
        time: t,
        comment: 'CLOSE BUY 0.3507/2 @ 228.90',
        symbol: 'PEO.PL',
        amount: 80.28,
      },
    ]);
    const { transactions } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const ubi = transactions.data.find((x) => x.paperName.startsWith('UBI'))!;
    expect(ubi.currency).toBe('EUR');
    expect(ubi.fxRate).toBeCloseTo(252.04 / 60, 4); // ≈4.2007
    const peo = transactions.data.find((x) => x.paperName.startsWith('PEO'))!;
    expect(peo.currency).toBe('PLN'); // ratio ≈ 1 → waluta konta
    expect(peo.fxRate).toBeUndefined();
  });

  it('partial fill: ratio liczony z ilości częściowej z regexa', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: t,
        comment: 'OPEN BUY 33/60 @ 35.560',
        symbol: 'ANR.US',
        amount: -(33 * 35.56 * 4.2),
      },
    ]);
    const { transactions } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const tx = transactions.data[0];
    expect(tx.quantity).toBe(33);
    expect(tx.currency).toBe('USD');
    expect(tx.fxRate).toBeCloseTo(4.2, 4);
  });

  it('prowizja (waluta konta) przeliczona na walutę notowania przez fxRate', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: t,
        comment: 'OPEN BUY 10 @ 20.00',
        symbol: 'PLTR.US',
        amount: -(10 * 20 * 3.7),
      },
      { id: 2, type: 'commission', time: t, comment: 'prowizja', symbol: 'PLTR.US', amount: -7.4 },
    ]);
    const { transactions } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const tx = transactions.data[0];
    expect(tx.fxRate).toBeCloseTo(3.7, 4);
    expect(tx.commission).toBeCloseTo(2, 2); // 7.40 PLN / 3.70 = 2.00 USD
    expect(tx.total).toBeCloseTo(200 + 2, 2);
  });

  it('stary format: kupno przez commission-fallback też przechodzi detekcję FX', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: t,
        comment: 'Order #123 cash stock purchase', // nieparsowalny — qty/cena z prowizji
        symbol: 'PLTR.US',
        amount: -(80 * 19.32 * 4.0),
      },
      {
        id: 2,
        type: 'commission',
        time: t,
        comment: 'BUY 80 @ 19.32',
        symbol: 'PLTR.US',
        amount: -3,
      },
    ]);
    const { transactions } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const tx = transactions.data[0];
    expect(tx.quantity).toBe(80);
    expect(tx.currency).toBe('USD');
    expect(tx.fxRate).toBeCloseTo(4.0, 4);
  });

  it('stary format: sprzedaż-fallback (cena z kwot konta) zostaje w walucie konta + warning o mieszanych legach', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: '01/03/2024 10:00:00',
        comment: 'OPEN BUY 80 @ 19.32',
        symbol: 'PLTR.US',
        amount: -(80 * 19.32 * 4.0),
      },
      {
        id: 2,
        type: 'close trade',
        time: t,
        comment: 'Profit of position #1',
        symbol: 'PLTR.US',
        amount: 500,
      },
      {
        id: 3,
        type: 'Stock sale',
        time: t,
        comment: 'Return position #1 open nominal value', // nieparsowalny → fallback
        symbol: 'PLTR.US',
        amount: 6182.4,
      },
    ]);
    const { transactions, warnings } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const sell = transactions.data.find((x) => x.side === 'S')!;
    expect(sell.currency).toBe('PLN'); // cena wyprowadzona z kwot konta
    expect(sell.price).toBeCloseTo((6182.4 + 500) / 80, 2);
    expect(sell.fxRate).toBeUndefined();
    expect(warnings?.some((w) => w.includes('mieszane') && w.includes('PLTR.US'))).toBe(true);
  });

  it('nowy format bez mapy tickerów + FX: cena przeliczona na walutę konta + warning', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: t,
        comment: 'OPEN BUY 10 @ 45.73',
        symbol: 'Some Foreign Company', // brak suffixu i brak Closed Positions
        amount: -1830.0,
      },
    ]);
    const { transactions, warnings } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const tx = transactions.data[0];
    expect(tx.currency).toBe('PLN');
    expect(tx.fxRate).toBeUndefined();
    expect(tx.price).toBeCloseTo(183.0, 2); // 1830 / 10 — spójne z gotówką
    expect(tx.value).toBeCloseTo(1830.0, 2);
    expect(warnings?.some((w) => w.includes('przeliczono na walutę konta'))).toBe(true);
  });

  it('Amount = 0: status quo (waluta konta) + warning o braku weryfikacji', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: t,
        comment: 'OPEN BUY 10 @ 20.00',
        symbol: 'PLTR.US',
        amount: 0,
      },
    ]);
    const { transactions, warnings } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const tx = transactions.data[0];
    expect(tx.currency).toBe('PLN');
    expect(tx.fxRate).toBeUndefined();
    expect(warnings?.some((w) => w.includes('bez kwoty rozliczenia'))).toBe(true);
  });

  it('anomalia: suffix = waluta konta, a kwoty mówią co innego → status quo + warning', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: t,
        comment: 'OPEN BUY 50 @ 34.19',
        symbol: 'DNP.PL',
        amount: -(50 * 34.19 * 3.7), // nie zgadza się mimo .PL na koncie PLN
      },
    ]);
    const { transactions, warnings } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const tx = transactions.data[0];
    expect(tx.currency).toBe('PLN');
    expect(tx.fxRate).toBeUndefined();
    expect(warnings?.some((w) => w.includes('odbiega od ilość×cena'))).toBe(true);
  });

  it('GBP z wykrytym FX: warning o weryfikacji jednostki (GBp vs GBP)', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: t,
        comment: 'OPEN BUY 10 @ 51.32',
        symbol: 'EIMI.UK',
        amount: -(10 * 51.32 * 3.75), // klasa USD na LSE — etykieta GBP z suffixu
      },
    ]);
    const { transactions, warnings } = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const tx = transactions.data[0];
    expect(tx.currency).toBe('GBP'); // etykieta pierwszego rzutu; relabel po resolwerze
    expect(tx.fxRate).toBeCloseTo(3.75, 4);
    expect(warnings?.some((w) => w.includes('GBp'))).toBe(true);
  });
});
