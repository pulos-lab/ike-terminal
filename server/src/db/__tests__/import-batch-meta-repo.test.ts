import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-meta-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-meta';

describe('import-batch-meta-repo', () => {
  let upsertImportBatchMeta: typeof import('../import-batch-meta-repo.js').upsertImportBatchMeta;
  let getImportBatchMeta: typeof import('../import-batch-meta-repo.js').getImportBatchMeta;
  let deleteImportBatchMeta: typeof import('../import-batch-meta-repo.js').deleteImportBatchMeta;
  let connection: typeof import('../connection.js');

  beforeAll(async () => {
    ({ upsertImportBatchMeta, getImportBatchMeta, deleteImportBatchMeta } =
      await import('../import-batch-meta-repo.js'));
    connection = await import('../connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upsert + get returns stored result', () => {
    const result = {
      success: true,
      transactionsImported: 10,
      operationsImported: 5,
      detectedSource: 'bossa',
      skipped: [{ row: 2, reason: 'short_row', paperName: 'TEST' }],
      warnings: ['Warning 1'],
      crossFileWarnings: [],
    };

    upsertImportBatchMeta(PID, 'batch-1', result);
    const stored = getImportBatchMeta(PID, 'batch-1');

    expect(stored).not.toBeNull();
    expect(stored!.success).toBe(true);
    expect(stored!.transactionsImported).toBe(10);
    expect(stored!.operationsImported).toBe(5);
    expect(stored!.detectedSource).toBe('bossa');
    expect(stored!.skipped).toHaveLength(1);
    expect(stored!.warnings).toEqual(['Warning 1']);
  });

  it('upsert twice overwrites previous result', () => {
    const result1 = { success: true, transactionsImported: 10, operationsImported: 0 };
    const result2 = { success: true, transactionsImported: 20, operationsImported: 5 };

    upsertImportBatchMeta(PID, 'batch-2', result1);
    upsertImportBatchMeta(PID, 'batch-2', result2);
    const stored = getImportBatchMeta(PID, 'batch-2');

    expect(stored!.transactionsImported).toBe(20);
    expect(stored!.operationsImported).toBe(5);
  });

  it('get returns null for non-existent batch', () => {
    const stored = getImportBatchMeta(PID, 'non-existent');
    expect(stored).toBeNull();
  });

  it('delete removes the meta', () => {
    upsertImportBatchMeta(PID, 'batch-3', {
      success: true,
      transactionsImported: 1,
      operationsImported: 0,
    });
    expect(getImportBatchMeta(PID, 'batch-3')).not.toBeNull();

    deleteImportBatchMeta(PID, 'batch-3');
    expect(getImportBatchMeta(PID, 'batch-3')).toBeNull();
  });

  it('handles complex nested structures', () => {
    const result = {
      success: true,
      transactionsImported: 5,
      operationsImported: 3,
      skipped: [
        { row: 2, reason: 'short_row', paperName: 'A' },
        { row: 5, reason: 'invalid_price', paperName: 'B' },
      ],
      warnings: ['Warning A', 'Warning B'],
      crossFileWarnings: ['Cross warning'],
      quarantineCount: 2,
      duplicatesSkipped: 1,
      tickersResolved: 3,
      tickersUnresolved: ['UNKNOWN1'],
      syntheticSells: 1,
      taxesApplied: 0,
      orphanedSells: [
        {
          isin: 'PL0001',
          ticker: 'T1',
          paperName: 'Paper1',
          missingQuantity: 10,
          firstSellDate: '2026-01-01',
          currency: 'PLN',
        },
      ],
    };

    upsertImportBatchMeta(PID, 'batch-complex', result);
    const stored = getImportBatchMeta(PID, 'batch-complex');

    expect(stored).not.toBeNull();
    expect(stored!.skipped).toHaveLength(2);
    expect(stored!.warnings).toHaveLength(2);
    expect(stored!.crossFileWarnings).toHaveLength(1);
    expect(stored!.tickersResolved).toBe(3);
    expect(stored!.syntheticSells).toBe(1);
    expect(stored!.orphanedSells).toHaveLength(1);
  });
});
