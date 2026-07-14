import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-buyback-'));
process.env.DATA_DIR = tmpDir;

const BOSSA_TX_HEADER = 'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta';
const BOSSA_OPS_HEADER = 'data;tytuł operacji;szczegóły;kwota;waluta';

function txCsv(rows: string[]): Buffer {
  return Buffer.from([BOSSA_TX_HEADER, ...rows].join('\n'), 'utf-8');
}
function opsCsv(rows: string[]): Buffer {
  return Buffer.from([BOSSA_OPS_HEADER, ...rows].join('\n'), 'utf-8');
}

// PLASTBOX (PLPSTBX00016) — Bossa sufiksuje jako "PLASTBOX-FIX" (cena fix).
// Kupno 250 + 760 = 1010 szt. Wycofany z GPW 2022 → przymusowy wykup.
const ROW_BUY_1 =
  '27.08.2020 11:10:35;PLASTBOX-FIX;PLPSTBX00016;760;K;1,80;1368,00;5,20;1373,20;PLN';
const ROW_BUY_2 = '22.09.2020 09:24:33;PLASTBOX-FIX;PLPSTBX00016;250;K;1,64;410,00;0,86;410,86;PLN';

describe('bulkImport — przymusowy wykup akcji (Wykup akcji + sufiks -FIX)', () => {
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
    connection.closeDb('test-buyback');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('"Wykup akcji PLASTBOX" domyka pozycję kupioną jako "PLASTBOX-FIX" (dopasowanie przez sufiks)', async () => {
    const PID = 'test-buyback';
    const result = await bulkImport({
      transactionsFiles: [{ buffer: txCsv([ROW_BUY_1, ROW_BUY_2]), originalname: 'hisPW.csv' }],
      operationsFile: {
        buffer: opsCsv(['2022-02-07;Wykup akcji PLASTBOX (przymusowy);;5238,00;PLN']),
        originalname: 'operacje_bez_transakcji.csv',
      },
      portfolioId: PID,
    });

    expect(result.success).toBe(true);

    const txs = txRepo.getAllTransactions(PID);
    // 2 K + 1 syntetyczna S z przymusowego wykupu
    expect(txs).toHaveLength(3);

    const sell = txs.find((t) => t.side === 'S')!;
    expect(sell).toBeDefined();
    expect(sell.quantity).toBe(1010); // pełne openQty
    expect(sell.value).toBe(5238);
    expect(sell.price).toBeCloseTo(5238 / 1010, 2);
    expect(sell.isin).toBe('PLPSTBX00016');
    expect(sell.syntheticOrigin).toContain('Wykup akcji PLASTBOX');

    // Pozycja domknięta do zera
    const bought = txs.filter((t) => t.side === 'K').reduce((s, t) => s + t.quantity, 0);
    const sold = txs.filter((t) => t.side === 'S').reduce((s, t) => s + t.quantity, 0);
    expect(bought - sold).toBe(0);

    // INWARIANT: paperName zakupów NIE jest normalizowany w bazie — sufiks "-FIX"
    // zostaje (resolver NC / parser generyczny na nim polegają). Dopasowanie do
    // wykupu dzieje się tylko w reconcile, po znormalizowanej nazwie.
    const buys = txs.filter((t) => t.side === 'K');
    expect(buys.every((t) => t.paperName === 'PLASTBOX-FIX')).toBe(true);

    // "Wykup akcji" skonsumowany — nie ma go jako operacji gotówkowej
    const ops = opsRepo.getAllOperations(PID);
    expect(ops.filter((o) => o.amount === 5238)).toHaveLength(0);
    expect(ops.find((o) => o.operationType === 'corporate_action_pending')).toBeUndefined();
  });
});
