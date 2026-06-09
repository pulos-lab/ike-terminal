import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Transaction, CashOperation } from 'shared';

// DATA_DIR musi być ustawiony PRZED importem config/connection (czytane przy load)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-db-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-clear';

const baseTx: Transaction = {
  date: '2024-01-10',
  paperName: 'Test SA',
  isin: 'PLTEST0000017',
  quantity: 10,
  side: 'K',
  price: 100,
  value: 1000,
  commission: 3,
  total: 1003,
  currency: 'PLN',
  source: 'manual',
};

const baseOp: CashOperation = {
  date: '2024-01-05',
  operationType: 'deposit',
  description: 'Wpłata',
  amount: 5000,
  currency: 'PLN',
  source: 'manual',
};

describe('clearImportedTransactions / clearImportedOperations', () => {
  let txRepo: typeof import('../transactions-repo.js');
  let opRepo: typeof import('../operations-repo.js');
  let connection: typeof import('../connection.js');

  beforeAll(async () => {
    txRepo = await import('../transactions-repo.js');
    opRepo = await import('../operations-repo.js');
    connection = await import('../connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('usuwa wiersze z importu, zostawia ręczne wpisy', () => {
    txRepo.insertTransaction({ ...baseTx }, PID); // manual, bez importBatch
    txRepo.insertTransaction(
      { ...baseTx, date: '2024-02-10', source: 'bossa', importBatch: 'batch-123' },
      PID,
    );
    opRepo.insertOperation({ ...baseOp }, PID); // manual
    opRepo.insertOperation(
      { ...baseOp, date: '2024-02-05', source: 'bossa', importBatch: 'batch-123' },
      PID,
    );

    expect(txRepo.getTransactionsCount(PID)).toBe(2);
    expect(opRepo.getOperationsCount(PID)).toBe(2);

    txRepo.clearImportedTransactions(PID);
    opRepo.clearImportedOperations(PID);

    const remainingTx = txRepo.getAllTransactions(PID);
    expect(remainingTx).toHaveLength(1);
    expect(remainingTx[0].source).toBe('manual');
    expect(remainingTx[0].importBatch).toBeNull();

    const remainingOps = opRepo.getAllOperations(PID);
    expect(remainingOps).toHaveLength(1);
    expect(remainingOps[0].source).toBe('manual');
  });

  it('clearTransactions/clearOperations (pełne czyszczenie dla seeda) nadal usuwa wszystko', () => {
    txRepo.insertTransaction({ ...baseTx }, PID);
    opRepo.insertOperation({ ...baseOp }, PID);

    txRepo.clearTransactions(PID);
    opRepo.clearOperations(PID);

    expect(txRepo.getTransactionsCount(PID)).toBe(0);
    expect(opRepo.getOperationsCount(PID)).toBe(0);
  });
});
