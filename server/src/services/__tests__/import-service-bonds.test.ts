import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-bonds-'));
process.env.DATA_DIR = tmpDir;

const BOSSA_TX_HEADER = 'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta';
const BOSSA_OPS_HEADER = 'data;tytuł operacji;szczegóły;kwota;waluta';

function txCsv(rows: string[]): Buffer {
  return Buffer.from([BOSSA_TX_HEADER, ...rows].join('\n'), 'utf-8');
}
function opsCsv(rows: string[]): Buffer {
  return Buffer.from([BOSSA_OPS_HEADER, ...rows].join('\n'), 'utf-8');
}

// Kupno 10 szt DS1030 @ 98,50% (nominał 1000 zł) = 9850 zł + 19,70 prowizji
const ROW_BUY_DS1030 =
  '05.03.2024 10:00:00;DS1030;PL0000112736;10;K;98,50;9850,00;19,70;9869,70;PLN';

describe('bulkImport — wykup obligacji (reconciliation kind=bond)', () => {
  let bulkImport: typeof import('../import-service.js').bulkImport;
  let txRepo: typeof import('../../db/transactions-repo.js');
  let opsRepo: typeof import('../../db/operations-repo.js');
  let connection: typeof import('../../db/connection.js');

  beforeAll(async () => {
    ({ bulkImport } = await import('../import-service.js'));
    txRepo = await import('../../db/transactions-repo.js');
    opsRepo = await import('../../db/operations-repo.js');
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    connection.closeDb('test-bond-full');
    connection.closeDb('test-bond-partial');
    connection.closeDb('test-bond-sub');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('subskrypcja obligacji: syntetyczna K z ceną w % NOMINAŁU (nominał 1000 — regresja 10×)', async () => {
    const PID = 'test-bond-sub';
    // BENEFIT SYSTEMS → BFT0330, nominał 1000 PLN. Zapis 10 000, zwrot 150 → netto 9850,
    // qty = round(9850/1000) = 10, cena = 9850/10/1000·100 = 98,5% nominału.
    const result = await bulkImport({
      transactionsFiles: [],
      operationsFile: {
        buffer: opsCsv([
          '2025-05-29;Zapisy na obligacje BENEFIT SYSTEMS;;-10000,00;PLN',
          '2025-06-09;Zwrot nadpłaty BENEFIT SYSTEMS;;150,00;PLN',
        ]),
        originalname: 'operacje_bez_transakcji.csv',
      },
      portfolioId: PID,
    });

    expect(result.success).toBe(true);

    const txs = txRepo.getAllTransactions(PID);
    expect(txs).toHaveLength(1);
    const buy = txs[0];
    expect(buy.side).toBe('K');
    expect(buy.category).toBe('bond');
    expect(buy.paperName).toBe('BFT0330');
    expect(buy.quantity).toBe(10);
    // KONWENCJA: cena obligacji w % nominału — silnik mnoży ×nominal/100.
    // Bug przed poprawką: price = 1000 (nominał w PLN) → koszt zawyżony 10×.
    expect(buy.price).toBeCloseTo(98.5, 4);
    expect(buy.total).toBeCloseTo(9850, 2);

    // Skonsumowane wiersze pary NIE trafiły do operacji gotówkowych
    const ops = opsRepo.getAllOperations(PID);
    expect(ops.filter((o) => Math.abs(o.amount) === 10000 || o.amount === 150)).toHaveLength(0);
  });

  it('pełny wykup: syntetyczna S zamyka pozycję po 100% nominału, kupon jako dividend+coupon', async () => {
    const PID = 'test-bond-full';
    const result = await bulkImport({
      transactionsFiles: [{ buffer: txCsv([ROW_BUY_DS1030]), originalname: 'hisPW.csv' }],
      operationsFile: {
        buffer: opsCsv([
          '2024-10-25;Wypłata odsetek DS1030;;125,00;PLN',
          '2030-10-25;Wykup obligacji DS1030;;10000,00;PLN',
        ]),
        originalname: 'operacje_bez_transakcji.csv',
      },
      portfolioId: PID,
    });

    expect(result.success).toBe(true);

    const txs = txRepo.getAllTransactions(PID);
    expect(txs).toHaveLength(2); // K + syntetyczna S z wykupu

    const sell = txs.find((t) => t.side === 'S')!;
    expect(sell.quantity).toBe(10);
    expect(sell.price).toBeCloseTo(100); // (10000 / 10) / 1000 × 100 — % nominału
    expect(sell.value).toBe(10000);
    expect(sell.category).toBe('bond');
    expect(sell.syntheticOrigin).toContain('Wykup obligacji DS1030');

    // Pozycja domknięta
    const bought = txs.filter((t) => t.side === 'K').reduce((s, t) => s + t.quantity, 0);
    const sold = txs.filter((t) => t.side === 'S').reduce((s, t) => s + t.quantity, 0);
    expect(bought - sold).toBe(0);

    // Kupon zaksięgowany jako dividend + subkind=coupon
    const ops = opsRepo.getAllOperations(PID);
    const coupon = ops.find((o) => o.subkind === 'coupon');
    expect(coupon).toBeDefined();
    expect(coupon!.operationType).toBe('dividend');
    expect(coupon!.ticker).toBe('DS1030');
    expect(coupon!.amount).toBe(125);
  });

  it('częściowy wykup: qty = amount/nominał, clamp do otwartej pozycji + warning', async () => {
    const PID = 'test-bond-partial';
    const result = await bulkImport({
      transactionsFiles: [{ buffer: txCsv([ROW_BUY_DS1030]), originalname: 'hisPW.csv' }],
      operationsFile: {
        // 5000 zł / 1000 zł nominału = 5 z 10 szt
        buffer: opsCsv(['2027-10-25;Wykup obligacji DS1030;;5000,00;PLN']),
        originalname: 'operacje_bez_transakcji.csv',
      },
      portfolioId: PID,
    });

    expect(result.success).toBe(true);

    const txs = txRepo.getAllTransactions(PID);
    const sell = txs.find((t) => t.side === 'S')!;
    expect(sell.quantity).toBe(5);
    expect(sell.price).toBeCloseTo(100);

    // Otwarta pozycja: 5 szt
    const bought = txs.filter((t) => t.side === 'K').reduce((s, t) => s + t.quantity, 0);
    const sold = txs.filter((t) => t.side === 'S').reduce((s, t) => s + t.quantity, 0);
    expect(bought - sold).toBe(5);

    // Warning o częściowym wykupie
    expect(result.crossFileWarnings?.some((w) => w.includes('częściowy wykup'))).toBe(true);
  });
});
