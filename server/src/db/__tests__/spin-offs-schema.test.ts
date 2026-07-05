import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.js';

describe('spin_offs schema — UNIQUE(parent_isin, ex_date)', () => {
  it('pozwala na wiele spin-offów per rodzic (różne daty), blokuje duplikat pary', () => {
    const db = new Database(':memory:');
    initSchema(db);

    const stmt = db.prepare(
      `INSERT INTO spin_offs
         (parent_isin, parent_ticker, child_isin, child_ticker, ex_date, ratio,
          allocation_pct, child_qty, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run('US78409V1044', 'SPGI', 'AUTO_MBGL', 'MBGL', '2026-07-01', 1, 0.08, 10, 'USD');
    stmt.run('US78409V1044', 'SPGI', 'AUTO_OTHR', 'OTHR', '2027-03-15', 0.5, 0.05, 5, 'USD');

    const rows = db.prepare('SELECT * FROM spin_offs WHERE parent_isin = ?').all('US78409V1044');
    expect(rows).toHaveLength(2);

    expect(() =>
      stmt.run('US78409V1044', 'SPGI', 'AUTO_MBGL', 'MBGL', '2026-07-01', 1, 0.08, 10, 'USD'),
    ).toThrow();
    db.close();
  });

  it('ON CONFLICT DO NOTHING zwraca changes=0 dla duplikatu (idempotencja appliera)', () => {
    const db = new Database(':memory:');
    initSchema(db);

    const stmt = db.prepare(
      `INSERT INTO spin_offs
         (parent_isin, parent_ticker, child_isin, child_ticker, ex_date, ratio,
          allocation_pct, child_qty, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(parent_isin, ex_date) DO NOTHING`,
    );
    const first = stmt.run(
      'US78409V1044',
      'SPGI',
      'AUTO_MBGL',
      'MBGL',
      '2026-07-01',
      1,
      0.08,
      10,
      'USD',
    );
    expect(first.changes).toBe(1);

    // Drugi insert (np. równoległy request) — cichy no-op, sygnał dla appliera
    // żeby pominąć side-effecty (bump wersji, invalidacja cache).
    const second = stmt.run(
      'US78409V1044',
      'SPGI',
      'AUTO_MBGL',
      'MBGL',
      '2026-07-01',
      1,
      0.09,
      10,
      'USD',
    );
    expect(second.changes).toBe(0);

    const row = db.prepare('SELECT allocation_pct FROM spin_offs').get() as {
      allocation_pct: number;
    };
    expect(row.allocation_pct).toBe(0.08); // pierwszy zapis pozostaje zamrożony
    db.close();
  });

  it('domyślne status/source i przejścia statusów', () => {
    const db = new Database(':memory:');
    initSchema(db);

    db.prepare(
      `INSERT INTO spin_offs
         (parent_isin, parent_ticker, child_isin, child_ticker, ex_date, ratio,
          allocation_pct, child_qty, currency)
       VALUES ('US78409V1044', 'SPGI', 'AUTO_MBGL', 'MBGL', '2026-07-01', 1, 0.08, 10, 'USD')`,
    ).run();

    const row = db.prepare('SELECT status, source, applied_at FROM spin_offs').get() as any;
    expect(row.status).toBe('applied');
    expect(row.source).toBe('map');
    expect(row.applied_at).toBeTruthy();

    db.prepare(`UPDATE spin_offs SET status = 'reverted' WHERE parent_isin = ?`).run(
      'US78409V1044',
    );
    const updated = db.prepare('SELECT status FROM spin_offs').get() as any;
    expect(updated.status).toBe('reverted');
    db.close();
  });
});
