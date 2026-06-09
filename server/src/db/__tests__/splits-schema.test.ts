import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.js';

describe('stock_splits schema — UNIQUE(isin, split_date)', () => {
  it('świeża baza pozwala na wiele splitów per ISIN (różne daty)', () => {
    const db = new Database(':memory:');
    initSchema(db);

    const stmt = db.prepare(
      `INSERT INTO stock_splits (isin, ticker, split_date, ratio, source) VALUES (?, ?, ?, ?, 'auto')`,
    );
    stmt.run('US0000000001', 'TEST', '2023-01-01', 4);
    stmt.run('US0000000001', 'TEST', '2024-06-10', 2);

    const rows = db.prepare('SELECT * FROM stock_splits WHERE isin = ?').all('US0000000001');
    expect(rows).toHaveLength(2);

    // duplikat (isin, split_date) nadal zabroniony
    expect(() => stmt.run('US0000000001', 'TEST', '2024-06-10', 2)).toThrow();
    db.close();
  });

  it('migruje starą bazę z UNIQUE(isin) zachowując dane', () => {
    const db = new Database(':memory:');
    // Stary kształt tabeli sprzed migracji
    db.exec(`
      CREATE TABLE stock_splits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        isin TEXT NOT NULL,
        ticker TEXT NOT NULL,
        split_date TEXT NOT NULL,
        ratio REAL NOT NULL,
        source TEXT DEFAULT 'auto',
        detected_at TEXT DEFAULT (datetime('now')),
        UNIQUE(isin)
      );
      CREATE INDEX IF NOT EXISTS idx_splits_isin ON stock_splits(isin);
      INSERT INTO stock_splits (isin, ticker, split_date, ratio) VALUES ('US0000000001', 'TEST', '2024-06-10', 10);
    `);

    initSchema(db);

    // Dane przeżyły migrację
    const rows = db.prepare('SELECT * FROM stock_splits').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].ratio).toBe(10);

    // Teraz drugi split dla tego samego ISIN-u jest możliwy
    db.prepare(
      `INSERT INTO stock_splits (isin, ticker, split_date, ratio) VALUES ('US0000000001', 'TEST', '2025-01-15', 2)`,
    ).run();
    expect(db.prepare('SELECT COUNT(*) as c FROM stock_splits').get()).toEqual({ c: 2 });

    // Migracja jest idempotentna — ponowny initSchema nie psuje tabeli
    initSchema(db);
    expect(db.prepare('SELECT COUNT(*) as c FROM stock_splits').get()).toEqual({ c: 2 });
    db.close();
  });
});
