import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SkippedRow } from 'shared';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-xtb-reprocess-'));
process.env.DATA_DIR = tmpDir;

const HEADERS = ['ID', 'Type', 'Time', 'Comment', 'Symbol', 'Amount'];
const FILE = 'IKE_12345_2026-01-01_2026-11-02.xlsx';

/** Wiersz kwarantanny w postaci zapisywanej przez parser XTB sprzed PR #267. */
function skippedRow(
  row: number,
  type: string,
  time: string,
  comment: string,
  symbol: string,
  amount: number,
): SkippedRow {
  return {
    row,
    reason: 'unparseable_comment',
    paperName: symbol,
    raw: {
      rawType: type.toLowerCase(),
      headers: HEADERS,
      cells: [String(1000 + row), type, time, comment, symbol, String(amount)],
      hint: {},
    },
  };
}

describe('reprocessXtbQuarantine — komentarze z tickerem odrzucone przed PR #267', () => {
  let reprocess: typeof import('../xtb-quarantine-reprocess.js').reprocessXtbQuarantine;
  let txRepo: typeof import('../../db/transactions-repo.js');
  let qRepo: typeof import('../../db/quarantine-repo.js');
  let connection: typeof import('../../db/connection.js');

  beforeAll(async () => {
    ({ reprocessXtbQuarantine: reprocess } = await import('../xtb-quarantine-reprocess.js'));
    txRepo = await import('../../db/transactions-repo.js');
    qRepo = await import('../../db/quarantine-repo.js');
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    for (const pid of ['t-basic', 't-manual']) connection.closeDb(pid);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedQuarantine(pid: string) {
    qRepo.insertQuarantineRows(
      {
        importBatch: 'batch-1',
        source: 'xtb',
        fileName: FILE,
        skipped: [
          skippedRow(
            6,
            'Stock purchase',
            '2026-10-12T07:48:35',
            'OPEN BUY CLD.PL 5 @ 127.50',
            'CLD.PL',
            -637.5,
          ),
          // Trzy identyczne partial fille — krotność musi przeżyć dedup
          skippedRow(
            7,
            'Stock sale',
            '2026-10-12T07:46:42',
            'CLOSE BUY VRC.PL 1/3 @ 126.40',
            'VRC.PL',
            126.4,
          ),
          skippedRow(
            8,
            'Stock sale',
            '2026-10-12T07:46:42',
            'CLOSE BUY VRC.PL 1/3 @ 126.40',
            'VRC.PL',
            126.4,
          ),
          skippedRow(
            9,
            'Stock sale',
            '2026-10-12T07:46:42',
            'CLOSE BUY VRC.PL 1/3 @ 126.40',
            'VRC.PL',
            126.4,
          ),
          // Stary format bez tickera — nie jest przedmiotem tej naprawy
          skippedRow(
            10,
            'Stock purchase',
            '2026-10-01T09:00:00',
            'Order #1 cash stock purchase',
            'KGH.PL',
            -100,
          ),
        ],
      },
      pid,
    );
  }

  const quarantineStatuses = (pid: string) =>
    connection
      .getDb(pid)
      .prepare(
        'SELECT status, COUNT(*) AS n FROM import_quarantine GROUP BY status ORDER BY status',
      )
      .all();

  it('dry-run pokazuje transakcje i niczego nie zapisuje', async () => {
    seedQuarantine('t-basic');
    const r = await reprocess('t-basic', { apply: false });

    expect(r.items).toHaveLength(4);
    expect(r.items.every((i) => i.tx && !i.error)).toBe(true);
    expect(r.items[0].tx).toMatchObject({
      date: '2026-10-12T07:48:35',
      side: 'K',
      paperName: 'CLD.WA',
      quantity: 5,
      price: 127.5,
      currency: 'PLN',
      importBatch: 'batch-1',
    });
    expect(txRepo.getAllTransactions('t-basic')).toHaveLength(0);
    expect(quarantineStatuses('t-basic')).toEqual([{ status: 'pending', n: 5 }]);
  });

  it('apply księguje wszystkie partial fille i rozwiązuje wiersze; drugi przebieg = no-op', async () => {
    const r = await reprocess('t-basic', { apply: true });
    expect(r.inserted).toBe(4);
    expect(r.resolved).toBe(4);

    const txs = txRepo.getAllTransactions('t-basic');
    expect(txs.filter((t) => t.paperName === 'VRC.WA' && t.side === 'S')).toHaveLength(3);
    // Wiersz w starym formacie zostaje w skrzynce
    expect(quarantineStatuses('t-basic')).toEqual([
      { status: 'pending', n: 1 },
      { status: 'resolved', n: 4 },
    ]);

    const again = await reprocess('t-basic', { apply: true });
    expect(again.items).toHaveLength(0);
    expect(txRepo.getAllTransactions('t-basic')).toHaveLength(4);
  });

  it('transakcja dodana wcześniej ręcznie nie dubluje się', async () => {
    seedQuarantine('t-manual');
    const preview = await reprocess('t-manual', { apply: false });
    const cld = preview.items[0].tx!;
    txRepo.insertTransactionsWithDedup(
      [{ ...cld, source: 'manual', importBatch: undefined }],
      't-manual',
    );

    const r = await reprocess('t-manual', { apply: true });
    expect(r.alreadyPresent).toBe(1);
    expect(r.inserted).toBe(3);
    expect(r.resolved).toBe(4);
    expect(
      txRepo.getAllTransactions('t-manual').filter((t) => t.paperName === 'CLD.WA'),
    ).toHaveLength(1);
  });
});
