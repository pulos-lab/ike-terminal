import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SkippedRow } from 'shared';

// DATA_DIR musi być ustawiony PRZED importem config/connection (czytane przy load)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-quarantine-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-quarantine';

const unknownRow = (row: number, rawType: string, cell = 'x'): SkippedRow => ({
  row,
  reason: 'unknown_type',
  paperName: rawType,
  raw: {
    rawType,
    headers: ['Type', 'Amount'],
    cells: [rawType, cell],
    hint: { amount: 1, currency: 'PLN' },
  },
});

describe('quarantine-repo', () => {
  let repo: typeof import('../quarantine-repo.js');
  let connection: typeof import('../connection.js');

  beforeAll(async () => {
    repo = await import('../quarantine-repo.js');
    connection = await import('../connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('zapisuje tylko wiersze kwalifikujące się (reason ∈ QUARANTINE_REASONS ORAZ raw obecne)', () => {
    const skipped: SkippedRow[] = [
      unknownRow(2, 'mystery op'),
      // unknown_type BEZ raw — celowy skip, nie wchodzi
      { row: 3, reason: 'unknown_type', paperName: 'no-raw' },
      // raw obecne, ale reason walidacyjny — nie wchodzi
      {
        row: 4,
        reason: 'invalid_price',
        raw: { cells: ['a'], rawType: 'x' },
      },
    ];
    const r = repo.insertQuarantineRows(
      { importBatch: 'b1', source: 'xtb', fileName: 'f.xlsx', skipped },
      PID,
    );
    expect(r.inserted).toBe(1);

    const rows = repo.listQuarantineRows(undefined, PID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      importBatch: 'b1',
      source: 'xtb',
      fileName: 'f.xlsx',
      rowNum: 2,
      reason: 'unknown_type',
      rawType: 'mystery op',
      cells: ['mystery op', 'x'],
      status: 'pending',
    });
    expect(rows[0].hint).toMatchObject({ amount: 1, currency: 'PLN' });
  });

  it('re-import tej samej treści (inny batch) NIE dubluje wpisu — dedup po row_hash', () => {
    const r = repo.insertQuarantineRows(
      { importBatch: 'b2', source: 'xtb', skipped: [unknownRow(9, 'mystery op')] },
      PID,
    );
    expect(r.inserted).toBe(0);
    expect(repo.listQuarantineRows(undefined, PID)).toHaveLength(1);
  });

  it('limit maxRows ucina nadwyżkę i raportuje overflow', () => {
    const many = Array.from({ length: 10 }, (_, i) => unknownRow(10 + i, `typ-${i}`));
    const r = repo.insertQuarantineRows(
      { importBatch: 'b3', source: 'generic', skipped: many, maxRows: 4 },
      PID,
    );
    expect(r.inserted).toBe(4);
    expect(r.overflow).toBe(6);
  });

  it('ignore zmienia status pending → ignored; ponowny insert tej treści nie wraca', () => {
    const row = repo.listQuarantineRows('pending', PID)[0];
    expect(repo.ignoreQuarantineRow(row.id, 'to nie transakcja', PID)).toBe(true);
    expect(repo.getQuarantineRow(row.id, PID)?.status).toBe('ignored');
    expect(repo.getQuarantineRow(row.id, PID)?.userNote).toBe('to nie transakcja');

    // idempotencja decyzji: identyczna treść przy re-imporcie → INSERT OR IGNORE
    const again = repo.insertQuarantineRows(
      { importBatch: 'b4', source: 'generic', skipped: [unknownRow(99, row.rawType!)] },
      PID,
    );
    // ta sama treść co zignorowany wpis → 0 nowych (chyba że cells się różnią)
    expect(
      repo.listQuarantineRows(undefined, PID).filter((q) => q.rawType === row.rawType),
    ).toHaveLength(1);
    expect(again.inserted).toBe(0);
  });

  it('ignore nie działa na już rozstrzygniętych (404 semantyka)', () => {
    const ignored = repo.listQuarantineRows('ignored', PID)[0];
    expect(repo.ignoreQuarantineRow(ignored.id, undefined, PID)).toBe(false);
  });

  it('countQuarantineByStatus liczy per status', () => {
    const counts = repo.countQuarantineByStatus(PID);
    expect(counts.ignored).toBe(1);
    expect(counts.pending).toBeGreaterThan(0);
    expect(counts.resolved).toBe(0);
  });

  it('deletePendingQuarantineByBatch kasuje tylko pending danego batcha', () => {
    // Zignorowany wcześniej wiersz pochodzi z b3 (ostatni wstawiony) — zostaje.
    const before = repo.countQuarantineByStatus(PID);
    const deleted = repo.deletePendingQuarantineByBatch('b3', PID);
    expect(deleted).toBe(3);
    const after = repo.countQuarantineByStatus(PID);
    expect(after.pending).toBe(before.pending - 3);
    expect(after.ignored).toBe(before.ignored);
  });

  it('clearQuarantine czyści wszystko (kaskada DELETE /api/import/clear)', () => {
    expect(repo.clearQuarantine(PID)).toBeGreaterThan(0);
    expect(repo.listQuarantineRows(undefined, PID)).toHaveLength(0);
  });

  it('tnie patologicznie długie komórki do 500 znaków', () => {
    const long = 'a'.repeat(2000);
    repo.insertQuarantineRows(
      {
        importBatch: 'b5',
        source: 'xtb',
        skipped: [
          {
            row: 1,
            reason: 'unknown_type',
            raw: { rawType: 'long', cells: [long] },
          },
        ],
      },
      PID,
    );
    const row = repo.listQuarantineRows(undefined, PID)[0];
    expect(row.cells[0]).toHaveLength(500);
  });
});
