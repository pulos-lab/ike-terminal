import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-bsi-'));
process.env.DATA_DIR = tmpDir;
process.env.NO_ISIN_RESOLVE = '1';

const PID = 'test-bond-sub-info';

const TX_HEADER = 'data;papier;isin;-;ilość;cena;wartość;prowizja;po prowizji;waluta';
const OPS_HEADER = 'data;tytuł operacji;szczegóły;kwota;waluta';

function txCsv(rows: string[]): Buffer {
  return Buffer.from([TX_HEADER, ...rows].join('\n'), 'utf-8');
}

function opsCsv(rows: string[]): Buffer {
  return Buffer.from([OPS_HEADER, ...rows].join('\n'), 'utf-8');
}

describe('bond subscription — info messages in ImportResult + ImportBatchInfo', () => {
  let bulkImport: typeof import('../import-service.js').bulkImport;
  let getAllImportBatches: typeof import('../../db/import-batches-repo.js').getAllImportBatches;
  let connection: typeof import('../../db/connection.js');

  beforeAll(async () => {
    ({ bulkImport } = await import('../import-service.js'));
    ({ getAllImportBatches } = await import('../../db/import-batches-repo.js'));
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports bond allocation as info with synthetic count', async () => {
    const result = await bulkImport({
      transactionsFiles: [
        {
          buffer: txCsv(['2025-05-29;SOME;PLGFPRE00453;-;75;100;7500;0;7500;PLN']),
          originalname: 'tx.csv',
        },
      ],
      operationsFile: {
        buffer: opsCsv([
          '2025-06-09;Zwrot nadpłaty PRAGMAGO D4;;200,00;PLN',
          '2025-05-29;Zapisy na obligacje PRAGMAGO D4;;-7500,00;PLN',
        ]),
        originalname: 'ops.csv',
      },
      portfolioId: PID,
    });

    expect(result.success).toBe(true);

    // info messages about bond subscription + synthetic summary
    expect(result.info).toBeDefined();
    expect(result.info!.length).toBe(2);
    expect(result.info![0]).toContain('PRAGMAGO D4');
    expect(result.info![0]).toContain('PRF0628');
    expect(result.info![0]).toContain('73');
    expect(result.info![0]).toContain('7300.00');
    expect(result.info![1]).toContain('Utworzono 1 syntetycznych transakcji');

    // syntheticTransactions count
    expect(result.syntheticTransactions).toBe(1);

    // ImportBatchInfo should also surface info + syntheticTransactionsCount
    const batches = getAllImportBatches(PID);
    const batch = batches.find((b) => b.importBatch === result.importBatch);
    expect(batch).toBeDefined();
    expect(batch!.info).toBeDefined();
    expect(batch!.info!.length).toBe(2);
    expect(batch!.info![0]).toContain('PRF0628');
    expect(batch!.syntheticTransactionsCount).toBe(1);
  });

  it('no bond allocations = no info, syntheticTransactions=0', async () => {
    const result = await bulkImport({
      transactionsFiles: [
        {
          buffer: txCsv(['2025-05-29;SOME;PLQTEST00999;-;10;50;500;0;500;PLN']),
          originalname: 'tx.csv',
        },
      ],
      operationsFile: {
        buffer: opsCsv(['2025-05-27;Przelew do DM BOŚ;;-26019,00;PLN']),
        originalname: 'ops.csv',
      },
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    expect(result.info).toBeUndefined();
    expect(result.syntheticTransactions).toBeUndefined();
  });
});
