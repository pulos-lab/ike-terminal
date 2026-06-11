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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
