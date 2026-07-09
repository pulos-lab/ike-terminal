import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-q-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-quarantine';

const TX_HEADER = 'data;papier;isin;-;ilość;cena;wartość;prowizja;po prowizji;waluta';

const OPS_HEADER = 'data;tytuł operacji;szczegóły;kwota;waluta';

function txCsv(rows: string[]): Buffer {
  return Buffer.from([TX_HEADER, ...rows].join('\n'), 'utf-8');
}

function opsCsv(rows: string[]): Buffer {
  return Buffer.from([OPS_HEADER, ...rows].join('\n'), 'utf-8');
}

// Używamy unikalnych ISIN-ów w każdym teście, żeby dedup nie interferował.
// ISIN-y nie muszą być realne; resolver po prostu nie znajdzie tickera.
const TEST_A_ISIN = 'PLQTEST00001';
const TEST_B_ISIN = 'PLQTEST00002';
const TEST_C_ISIN = 'PLQTEST00003';
const TEST_D_ISIN = 'PLQTEST00004';
const TEST_E_ISIN = 'PLQTEST00005';

describe('bulkImport — quarantine aggregation', () => {
  let bulkImport: typeof import('../import-service.js').bulkImport;
  let txRepo: typeof import('../../db/transactions-repo.js');
  let opRepo: typeof import('../../db/operations-repo.js');
  let connection: typeof import('../../db/connection.js');

  let quarantineRepo: typeof import('../../db/import-quarantine-repo.js');

  beforeAll(async () => {
    ({ bulkImport } = await import('../import-service.js'));
    txRepo = await import('../../db/transactions-repo.js');
    opRepo = await import('../../db/operations-repo.js');
    quarantineRepo = await import('../../db/import-quarantine-repo.js');
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('malformed rows in transactions file → quarantine in result and persisted to DB', async () => {
    const txFile = txCsv([
      `25.02.2026;TESTA;${TEST_A_ISIN};K;10;150,50;1505,00;5,00;1510,00;PLN`,
      // Extra column (__parsed_extra) — malformed
      `25.02.2026;TESTB;${TEST_B_ISIN};S;2;200,00;400,00;1,90;398,10;PLN;extra`,
      // Numeric waluta (semicolon instead of comma) — malformed
      `01.03.2026;TESTC;${TEST_C_ISIN};K;5;90,00;450,00;2,00;452,00;90;90`,
    ]);

    const result = await bulkImport({
      transactionsFiles: [{ buffer: txFile, originalname: 'hisPW.csv' }],
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(1);
    expect(txRepo.getTransactionsCount(PID)).toBe(1);
    expect(result.quarantine).toHaveLength(2);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![1].severity).toBe('malformed');

    // Quarantine persisted to DB
    const stored = quarantineRepo.getQuarantineByBatch(result.importBatch, PID);
    expect(stored).toHaveLength(2);
    expect(stored.every((s) => s.severity === 'malformed')).toBe(true);
  });

  it('invalid currency in transactions file → invalid quarantine, valid rows still inserted', async () => {
    const txFile = txCsv([
      `26.02.2026;TESTD;${TEST_D_ISIN};K;10;150,50;1505,00;5,00;1510,00;PLN`,
      // Invalid currency (XX is not 3 letters)
      `26.02.2026;TESTE;${TEST_E_ISIN};S;2;200,00;400,00;1,90;398,10;XX`,
    ]);

    const result = await bulkImport({
      transactionsFiles: [{ buffer: txFile, originalname: 'hisPW.csv' }],
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(1);
    expect(txRepo.getTransactionsCount(PID)).toBe(2); // 1 previous + 1 new
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('invalid');
    expect(result.quarantine![0].reason).toBe('invalid_currency');
    expect(result.quarantine![0].suggestions).toEqual(['PLN']);
    expect(result.quarantine![0].parsed).toBeDefined();

    // Quarantine persisted to DB
    const stored = quarantineRepo.getQuarantineByBatch(result.importBatch, PID);
    expect(stored).toHaveLength(1);
  });

  it('malformed rows in operations file → quarantine in result and persisted, valid ops inserted', async () => {
    const opsFile = opsCsv([
      // Valid row
      '2026-06-08;Wypłata odsetek z tytułu obligacji PRF0628;;148,19;PLN',
      // Malformed — semicolon instead of comma (waluta becomes numeric)
      '2026-05-22;Wypłata dywidendy VOTUM;;850;19;PLN',
    ]);

    const result = await bulkImport({
      operationsFile: { buffer: opsFile, originalname: 'operacje.csv' },
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    expect(result.operationsImported).toBe(1);
    expect(opRepo.getOperationsCount(PID)).toBe(1);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
  });

  it('both files with quarantine → all quarantine records aggregated into one array', async () => {
    const prevTxCount = txRepo.getTransactionsCount(PID);
    const prevOpCount = opRepo.getOperationsCount(PID);

    const testFIsin = 'PLQTEST00006';
    const txFile = txCsv([
      `27.02.2026;TESTF;${testFIsin};K;5;180,00;900,00;2,90;902,90;PLN`,
      // Malformed
      '01.03.2026;SYNEKTIK;PLSYNEK00012;K;5;90,00;450,00;2,00;452,00;90;90',
    ]);
    // Unique operation data — different from test 3 to avoid dedup
    const opsFile = opsCsv([
      '2026-07-01;Wypłata dywidendy DIGITANET;;385,60;PLN',
      // Malformed
      '2026-05-22;Wypłata dywidendy VOTUM;;850;19;PLN',
      // Invalid currency
      '2026-03-06;Wypłata odsetek;PRF0628;151,84;XX',
    ]);

    const result = await bulkImport({
      transactionsFiles: [{ buffer: txFile, originalname: 'hisPW.csv' }],
      operationsFile: { buffer: opsFile, originalname: 'operacje.csv' },
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(1);
    expect(result.operationsImported).toBe(1);
    expect(txRepo.getTransactionsCount(PID)).toBe(prevTxCount + 1);
    expect(opRepo.getOperationsCount(PID)).toBe(prevOpCount + 1);

    // All quarantine records aggregated (1 tx malformed + 1 ops malformed + 1 ops invalid = 3)
    expect(result.quarantine).toHaveLength(3);
    const malformed = result.quarantine!.filter((q) => q.severity === 'malformed');
    const invalid = result.quarantine!.filter((q) => q.severity === 'invalid');
    expect(malformed).toHaveLength(2);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toBe('invalid_currency');

    // Quarantine persisted to DB
    const stored = quarantineRepo.getQuarantineByBatch(result.importBatch, PID);
    expect(stored).toHaveLength(3);
  });

  it('import result persisted to meta — getImportBatchMeta returns full result', async () => {
    const testIsin = 'PLQTEST00007';
    const txFile = txCsv([`28.02.2026;TESTG;${testIsin};K;10;150,50;1505,00;5,00;1510,00;PLN`]);

    const result = await bulkImport({
      transactionsFiles: [{ buffer: txFile, originalname: 'hisPW.csv' }],
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    const metaRepo = await import('../../db/import-batch-meta-repo.js');
    const meta = metaRepo.getImportBatchMeta(PID, result.importBatch);
    expect(meta).not.toBeNull();
    expect(meta!.success).toBe(true);
    expect(meta!.transactionsImported).toBe(1);
    // skipped/warnings are undefined when empty (conditional spread in import-service)
    expect(meta!.skipped).toBeUndefined();
    expect(meta!.warnings).toBeUndefined();
  });

  it('delete batch cleans meta, quarantine, transactions, and operations', async () => {
    const testIsin = 'PLQTEST00008';
    const txFile = txCsv([
      `01.03.2026;TESTH;${testIsin};K;5;100,00;500,00;2,00;502,00;PLN`,
      // Malformed
      '02.03.2026;TESTI;PLQTEST00009;K;5;90,00;450,00;2,00;452,00;90;90',
    ]);
    const opsFile = opsCsv(['2026-06-01;Wypłata dywidendy;TESTH;100,00;PLN']);

    const importResult = await bulkImport({
      transactionsFiles: [{ buffer: txFile, originalname: 'hisPW.csv' }],
      operationsFile: { buffer: opsFile, originalname: 'operacje.csv' },
      portfolioId: PID,
    });

    expect(importResult.success).toBe(true);
    const batch = importResult.importBatch;

    // Verify quarantine and meta exist
    const qBefore = quarantineRepo.getQuarantineByBatch(batch, PID);
    expect(qBefore.length).toBeGreaterThan(0);
    const metaRepo = await import('../../db/import-batch-meta-repo.js');
    const metaBefore = metaRepo.getImportBatchMeta(PID, batch);
    expect(metaBefore).not.toBeNull();

    // Delete the batch
    const txRemoved = txRepo.deleteTransactionsByBatch(batch, PID);
    const opsRemoved = opRepo.deleteOperationsByBatch(batch, PID);
    const qRemoved = quarantineRepo.deleteQuarantineByBatch(batch, PID);
    metaRepo.deleteImportBatchMeta(PID, batch);

    expect(txRemoved).toBeGreaterThanOrEqual(1);
    expect(opsRemoved).toBeGreaterThanOrEqual(1);
    expect(qRemoved).toBe(qBefore.length);

    // Verify quarantine and meta are gone
    const qAfter = quarantineRepo.getQuarantineByBatch(batch, PID);
    expect(qAfter).toHaveLength(0);
    const metaAfter = metaRepo.getImportBatchMeta(PID, batch);
    expect(metaAfter).toBeNull();
  });
});
