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

describe('parseXtbFile — odsetki od wolnych środków', () => {
  // Warianty pisowni XTB: EN ze spacją i z dywizem (normalizowane aliasem typu).
  const interestRows = [
    {
      id: 1,
      type: 'Free funds interest',
      time: '31/01/2024 23:59:00',
      comment: 'Free-funds Interest',
      symbol: '',
      amount: 12.5,
    },
    {
      id: 2,
      type: 'Free-funds Interest Tax',
      time: '31/01/2024 23:59:00',
      comment: 'Free-funds Interest Tax',
      symbol: '',
      amount: -2.38,
    },
  ];

  it('odsetki → other + subkind=interest (kategoria „Odsetki", nie „Inne")', async () => {
    const buf = await buildXtbXlsx([interestRows[0]]);
    const { operations } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    expect(operations.data).toHaveLength(1);
    expect(operations.data[0]).toMatchObject({
      operationType: 'other',
      subkind: 'interest',
      amount: 12.5,
      currency: 'PLN',
      source: 'xtb',
    });
  });

  it('podatek od odsetek zostaje kosztem → fee bez subkind', async () => {
    const buf = await buildXtbXlsx([interestRows[1]]);
    const { operations } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    expect(operations.data).toHaveLength(1);
    expect(operations.data[0]).toMatchObject({ operationType: 'fee', amount: -2.38 });
    // Podatek NIE może dostać subkind='interest' — inaczej wpadłby do przychodowej
    // kategorii "Odsetki" zamiast do kosztów.
    expect(operations.data[0].subkind).toBeUndefined();
  });

  it('oba warianty w jednym pliku nie mieszają się (żaden nie ląduje w unknown)', async () => {
    const buf = await buildXtbXlsx(interestRows);
    const { operations } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    expect(operations.data.filter((o) => o.subkind === 'interest')).toHaveLength(1);
    expect(operations.data.filter((o) => o.operationType === 'fee')).toHaveLength(1);
    expect(operations.skipped.filter((s) => s.reason === 'unknown_type')).toHaveLength(0);
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

  it('unknown_type niesie surową treść wiersza (raw) z hintem do skrzynki "Do wyjaśnienia"', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 7,
        type: 'Dividend Equivalent',
        time: '11/01/2024 09:00:00',
        comment: 'DIV EQ AAPL.US',
        symbol: 'AAPL.US',
        amount: 12.34,
      },
    ]);

    const result = await parseXtbFile(buf, 'batch-1', 'USD_12345_test.xlsx');
    const skip = result.operations.skipped.find((s) => s.reason === 'unknown_type');

    expect(skip?.raw).toBeDefined();
    // Klucz aliasów/zgłoszeń: lower(trim) typu
    expect(skip?.raw?.rawType).toBe('dividend equivalent');
    expect(skip?.raw?.headers).toEqual(['ID', 'Type', 'Time', 'Comment', 'Symbol', 'Amount']);
    expect(skip?.raw?.cells).toContain('Dividend Equivalent');
    expect(skip?.raw?.cells).toContain('DIV EQ AAPL.US');
    expect(skip?.raw?.hint).toMatchObject({
      date: '2024-01-11',
      amount: 12.34,
      currency: 'USD',
      symbol: 'AAPL.US',
    });
  });
});

describe('parseXtbFile — globalne aliasy typów (ParserContext)', () => {
  const rows = [
    {
      id: 1,
      type: 'Dividend Equivalent',
      time: '11/01/2024 09:00:00',
      comment: 'DIV EQ AAPL.US',
      symbol: 'AAPL.US',
      amount: 12.34,
    },
    {
      id: 2,
      type: 'IKE Transfer Bonus',
      time: '12/01/2024 09:00:00',
      comment: 'Bonus transferowy',
      symbol: '',
      amount: 100,
    },
    {
      id: 3,
      type: 'Marketing Spam Fee',
      time: '13/01/2024 09:00:00',
      comment: 'Nieistotne',
      symbol: '',
      amount: 0,
    },
  ];

  it('alias parser_type → wiersz wchodzi w normalny dispatch (pełne parsowanie)', async () => {
    const buf = await buildXtbXlsx(rows);
    const ctx = {
      typeAliases: new Map([
        ['dividend equivalent', { kind: 'parser_type' as const, value: 'dividend' }],
      ]),
    };
    const result = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx', ctx);
    const div = result.operations.data.find((o) => o.operationType === 'dividend');
    expect(div).toMatchObject({ amount: 12.34, currency: 'PLN' });
    // Zaliasowany typ NIE ląduje w unknown
    expect(
      result.operations.skipped.filter(
        (s) => s.reason === 'unknown_type' && s.paperName?.includes('Dividend Equivalent'),
      ),
    ).toHaveLength(0);
  });

  it('alias parser_type z targetem SPOZA katalogu jest ignorowany (wiersz zostaje unknown)', async () => {
    const buf = await buildXtbXlsx([rows[0]]);
    const ctx = {
      typeAliases: new Map([
        ['dividend equivalent', { kind: 'parser_type' as const, value: 'nie-ma-takiego' }],
      ]),
    };
    const result = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx', ctx);
    expect(result.operations.data).toHaveLength(0);
    expect(result.operations.skipped[0]?.reason).toBe('unknown_type');
  });

  it('alias cash_operation → CashOperation wprost z wiersza (typ/subkind/znak z targetu)', async () => {
    const buf = await buildXtbXlsx([rows[1]]);
    const ctx = {
      typeAliases: new Map([
        [
          'ike transfer bonus',
          {
            kind: 'cash_operation' as const,
            value: JSON.stringify({ operationType: 'other', subkind: 'interest', sign: '+' }),
          },
        ],
      ]),
    };
    const result = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx', ctx);
    expect(result.operations.data[0]).toMatchObject({
      operationType: 'other',
      subkind: 'interest',
      amount: 100,
      currency: 'PLN',
      description: 'Bonus transferowy',
      source: 'xtb',
    });
    expect(result.operations.skipped.filter((s) => s.reason === 'unknown_type')).toHaveLength(0);
  });

  it('alias cash_operation z niedozwolonym operationType → wiersz zostaje unknown', async () => {
    const buf = await buildXtbXlsx([rows[1]]);
    const ctx = {
      typeAliases: new Map([
        [
          'ike transfer bonus',
          {
            kind: 'cash_operation' as const,
            value: JSON.stringify({ operationType: 'fx_exchange' }),
          },
        ],
      ]),
    };
    const result = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx', ctx);
    expect(result.operations.data).toHaveLength(0);
    expect(result.operations.skipped[0]?.reason).toBe('unknown_type');
  });

  it('alias ignore → skip aliased_ignore (bez raw, bez warninga unknown)', async () => {
    const buf = await buildXtbXlsx([rows[2]]);
    const ctx = {
      typeAliases: new Map([['marketing spam fee', { kind: 'ignore' as const }]]),
    };
    const result = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx', ctx);
    const skip = result.operations.skipped[0];
    expect(skip?.reason).toBe('aliased_ignore');
    expect(skip?.raw).toBeUndefined();
    expect(result.warnings?.some((w) => w.includes('Nierozpoznane typy'))).toBeFalsy();
  });

  it('wbudowane ALIASES mają pierwszeństwo przed aliasem globalnym', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 9,
        type: 'IKE Deposit',
        time: '10/01/2024 09:00:00',
        comment: 'Wpłata IKE',
        symbol: '',
        amount: 500,
      },
    ]);
    // Złośliwy alias globalny próbujący przejąć wbudowany typ — nie może wygrać.
    const ctx = {
      typeAliases: new Map([['ike deposit', { kind: 'ignore' as const }]]),
    };
    const result = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx', ctx);
    expect(result.operations.data[0]?.operationType).toBe('deposit');
    expect(result.operations.skipped).toHaveLength(0);
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

// ── Waluta konta z prefiksu nazwy pliku ──────────────────────────────────────

describe('parseXtbFile — prefiks IKE_/IKZE_ implikuje PLN', () => {
  const t = '05/03/2024 10:00:00';
  const NO_CURRENCY_WARNING = 'Nie wykryto waluty konta';

  /** Wiersz neutralny walutowo (ratio 1) — pozwala sprawdzić samą detekcję konta. */
  const plnBuy = {
    id: 1,
    type: 'Stock purchase',
    time: t,
    comment: 'OPEN BUY 10 @ 20.00',
    symbol: 'CDR.PL',
    amount: -200,
  };

  it('IKE_<numer>_ → PLN bez warninga o niewykrytej walucie', async () => {
    const buf = await buildXtbXlsx([plnBuy]);
    const { transactions, warnings } = await parseXtbFile(
      buf,
      'b1',
      'IKE_51152547_2006-01-01_2026-07-07.xlsx',
    );
    expect(transactions.data[0].currency).toBe('PLN');
    expect(warnings?.some((w) => w.includes(NO_CURRENCY_WARNING))).toBeFalsy();
  });

  it('IKZE_<numer>_ → PLN bez warninga (niezależnie od wielkości liter)', async () => {
    const buf = await buildXtbXlsx([plnBuy]);
    const { warnings } = await parseXtbFile(buf, 'b1', 'ikze_12345_2020-01-01.xlsx');
    expect(warnings?.some((w) => w.includes(NO_CURRENCY_WARNING))).toBeFalsy();
  });

  it('regresja: prefiks walutowy USD_ nadal wykrywany, nieznany prefiks → PLN + warning', async () => {
    const buf = await buildXtbXlsx([{ ...plnBuy, symbol: 'PLTR.US' }]);
    const usd = await parseXtbFile(buf, 'b1', 'USD_12345_test.xlsx');
    expect(usd.transactions.data[0].currency).toBe('USD');
    expect(usd.warnings?.some((w) => w.includes(NO_CURRENCY_WARNING))).toBeFalsy();

    const unknown = await parseXtbFile(await buildXtbXlsx([plnBuy]), 'b1', 'export_12345.xlsx');
    expect(unknown.transactions.data[0].currency).toBe('PLN');
    expect(unknown.warnings?.some((w) => w.includes(NO_CURRENCY_WARNING))).toBe(true);
  });

  it('prefiks „konto " przed IKE_/WALUTA_ (nazwy z aplikacji XTB PL) → waluta wykryta', async () => {
    const ike = await parseXtbFile(
      await buildXtbXlsx([plnBuy]),
      'b1',
      'konto IKE_52015814_2024-12-31_2026-07-15.xlsx',
    );
    expect(ike.transactions.data[0].currency).toBe('PLN');
    expect(ike.warnings?.some((w) => w.includes(NO_CURRENCY_WARNING))).toBeFalsy();

    const pln = await parseXtbFile(
      await buildXtbXlsx([plnBuy]),
      'b1',
      'konto PLN_51763181_2024-12-31_2026-07-15.xlsx',
    );
    expect(pln.warnings?.some((w) => w.includes(NO_CURRENCY_WARNING))).toBeFalsy();

    const usd = await parseXtbFile(
      await buildXtbXlsx([{ ...plnBuy, symbol: 'PLTR.US' }]),
      'b1',
      'konto USD_12345_2024-12-31_2026-07-15.xlsx',
    );
    expect(usd.transactions.data[0].currency).toBe('USD');
    expect(usd.warnings?.some((w) => w.includes(NO_CURRENCY_WARNING))).toBeFalsy();
  });
});

// ── Dywidenda spółki zagranicznej notowanej na GPW (nowy typ XTB) ────────────

describe('parseXtbFile — „Dividend from foreign company on PL market"', () => {
  const t = '28/05/2026 11:59:03';

  it('księguje się jak zwykła dywidenda (nie unknown_type)', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Dividend from foreign company on PL market',
        time: t,
        comment: 'ASB.PL USD 0.3500/ SHR',
        symbol: 'ASB.PL',
        amount: 35,
      },
    ]);
    const result = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    expect(result.operations.skipped.filter((s) => s.reason === 'unknown_type')).toHaveLength(0);
    expect(result.operations.data).toHaveLength(1);
    const div = result.operations.data[0];
    expect(div.operationType).toBe('dividend');
    expect(div.amount).toBe(35);
    expect(div.currency).toBe('PLN');
    expect(div.ticker).toBe('ASB.WA');
  });

  it('paruje się z withholding tax jak zwykła dywidenda (netto + opis brutto/WHT)', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Dividend from foreign company on PL market',
        time: t,
        comment: 'XYZ.PL USD 1.0000/ SHR',
        symbol: 'XYZ.PL',
        amount: 100,
      },
      {
        id: 2,
        type: 'withholding tax',
        time: t,
        comment: 'XYZ.PL USD WHT 19%',
        symbol: 'XYZ.PL',
        amount: -19,
      },
    ]);
    const result = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const div = result.operations.data.find((o) => o.operationType === 'dividend');
    expect(div?.amount).toBe(81);
    expect(div?.description).toContain('WHT 19%');
    // WHT skonsumowany w netting — nie powstaje osobny fee
    expect(result.operations.data.filter((o) => o.operationType === 'fee')).toHaveLength(0);
  });
});

// ── Kilka dywidend + kilka WHT w tej samej sekundzie (partial fille) ─────────

describe('parseXtbFile — dywidendy i WHT pod wspólnym kluczem symbol|czas (FIFO)', () => {
  const t = '03/07/2026 23:01:11';

  it('każda dywidenda konsumuje WŁASNY wiersz WHT (nie ostatni pod kluczem)', async () => {
    // Wzorzec z realnych plików: dwie dywidendy partial filli w tej samej
    // sekundzie, każda z własnym WHT. Mapa z nadpisywaniem dawała obu ten sam
    // (ostatni) podatek — mała dywidenda z cudzym, większym WHT wychodziła
    // ujemna, a nadmiarowe wiersze WHT znikały.
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'dividend',
        time: t,
        comment: 'XYZ.PL PLN 2.5000/ SHR',
        symbol: 'XYZ.PL',
        amount: 25,
      },
      {
        id: 2,
        type: 'dividend',
        time: t,
        comment: 'XYZ.PL PLN 2.5000/ SHR',
        symbol: 'XYZ.PL',
        amount: 5,
      },
      {
        id: 3,
        type: 'withholding tax',
        time: t,
        comment: 'XYZ.PL PLN WHT 19%',
        symbol: 'XYZ.PL',
        amount: -4.75,
      },
      {
        id: 4,
        type: 'withholding tax',
        time: t,
        comment: 'XYZ.PL PLN WHT 19%',
        symbol: 'XYZ.PL',
        amount: -0.95,
      },
    ]);
    const result = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const divs = result.operations.data.filter((o) => o.operationType === 'dividend');
    expect(divs.map((d) => d.amount)).toEqual([20.25, 4.05]);
    // Oba WHT skonsumowane — brak osobnych fee
    expect(result.operations.data.filter((o) => o.operationType === 'fee')).toHaveLength(0);
  });

  it('nadmiarowy WHT bez własnej dywidendy NIE ginie — wchodzi jako fee', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'dividend',
        time: t,
        comment: 'XYZ.PL PLN 2.5000/ SHR',
        symbol: 'XYZ.PL',
        amount: 10,
      },
      {
        id: 2,
        type: 'withholding tax',
        time: t,
        comment: 'XYZ.PL PLN WHT 19%',
        symbol: 'XYZ.PL',
        amount: -1.9,
      },
      {
        id: 3,
        type: 'withholding tax',
        time: t,
        comment: 'XYZ.PL PLN WHT 19%',
        symbol: 'XYZ.PL',
        amount: -4.75,
      },
    ]);
    const result = await parseXtbFile(buf, 'b1', 'PLN_12345_test.xlsx');
    const div = result.operations.data.find((o) => o.operationType === 'dividend');
    expect(div?.amount).toBe(8.1);
    const fees = result.operations.data.filter((o) => o.operationType === 'fee');
    expect(fees).toHaveLength(1);
    expect(fees[0].amount).toBe(-4.75);
  });
});

// ── Nowy szablon (kolumna Ticker) + wiersze close trade CFD ──────────────────

/** Buduje plik XTB w NOWYM szablonie EN+TICKER (arkusz "Cash Operations"):
 *  Type | Ticker | Instrument | Time | Amount | ID | Comment | Product. */
async function buildXtbXlsxTicker(
  rows: Array<{
    id: number;
    type: string;
    time: string;
    comment: string;
    ticker: string;
    instrument?: string;
    amount: number;
  }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cash Operations');
  ws.addRow(['Type', 'Ticker', 'Instrument', 'Time', 'Amount', 'ID', 'Comment', 'Product']);
  for (const r of rows) {
    ws.addRow([
      r.type,
      r.ticker,
      r.instrument ?? r.ticker,
      r.time,
      r.amount,
      r.id,
      r.comment,
      'My Trades',
    ]);
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

describe('parseXtbFile — szablon z kolumną Ticker a wiersze close trade (CFD)', () => {
  it('Amount sprzedaży pozostaje pełną wartością → implied fxRate, nie dziedziczenie', async () => {
    // Nowy szablon emituje "close trade" WYŁĄCZNIE dla CFD (np. OIL) — obecność
    // takich wierszy nie może przełączać sprzedaży akcji na starą semantykę
    // "Amount = zwrócony nominał otwarcia".
    const buf = await buildXtbXlsxTicker([
      {
        id: 1,
        type: 'Close trade',
        time: '09/04/2026 12:01:07',
        comment: 'Profit of position #2498250532',
        ticker: 'OIL',
        amount: -345.31,
      },
      {
        id: 2,
        type: 'Stock sell',
        time: '14/07/2026 16:32:53',
        comment: 'CLOSE BUY 4 @ 620.00',
        ticker: 'NOVOB.DK',
        amount: 1438.4, // pełna wartość sprzedaży w PLN (kurs DKK/PLN ≈ 0.58)
      },
    ]);
    const result = await parseXtbFile(buf, 'b1', 'konto PLN_12345_2024-01-01_2026-01-01.xlsx');
    const sell = result.transactions.data.find((x) => x.side === 'S');
    expect(sell).toBeDefined();
    expect(sell?.currency).toBe('DKK');
    expect(sell?.paymentCurrency).toBe('PLN');
    expect(sell?.price).toBe(620);
    expect(sell?.fxRate).toBeCloseTo(1438.4 / (4 * 620), 5);
    // Przed fixem plik z jakimkolwiek close trade szedł ścieżką salesWithoutPl
    expect(result.warnings?.some((w) => w.includes('bez wiersza "close trade"'))).toBeFalsy();
  });
});

describe('parseXtbFile — aliasy ISIN (konwersja PDA→akcje REXA→REX)', () => {
  const rexaBuy = (time: string) => ({
    id: 1,
    type: 'Stock purchase',
    time,
    comment: 'OPEN BUY 2 @ 13.69',
    symbol: 'REXA.PL',
    amount: -27.38,
  });

  it('zakup PDA (REXA.PL) w oknie aliasu migruje na REX.WA', async () => {
    const buf = await buildXtbXlsx([rexaBuy('03/06/2026 09:17:41')]);
    const { transactions } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    const buy = transactions.data.find((t) => t.side === 'K');
    expect(buy?.isin).toBe('REX.WA');
    expect(buy?.paperName).toBe('REX.WA');
    expect(buy?.currency).toBe('PLN');
  });

  it('wiersz datowany PO appliesUntil NIE jest aliasowany (ochrona przed reużyciem tickera)', async () => {
    const buf = await buildXtbXlsx([rexaBuy('03/06/2027 09:17:41')]);
    const { transactions } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    const buy = transactions.data.find((t) => t.side === 'K');
    expect(buy?.isin).toBe('REXA.WA');
  });

  it('zwykłe zakupy akcji (REX.PL) przechodzą bez zmian', async () => {
    const buf = await buildXtbXlsx([
      {
        id: 1,
        type: 'Stock purchase',
        time: '02/07/2026 09:30:02',
        comment: 'OPEN BUY 3 @ 12.884',
        symbol: 'REX.PL',
        amount: -38.65,
      },
    ]);
    const { transactions } = await parseXtbFile(buf, 'batch-1', 'PLN_12345_test.xlsx');

    const buy = transactions.data.find((t) => t.side === 'K');
    expect(buy?.isin).toBe('REX.WA');
    expect(buy?.paperName).toBe('REX.WA');
  });
});
