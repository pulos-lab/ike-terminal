import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      paper_name TEXT NOT NULL,
      isin TEXT NOT NULL,
      quantity REAL NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('K', 'S')),
      price REAL NOT NULL,
      value REAL NOT NULL,
      commission REAL NOT NULL,
      total REAL NOT NULL,
      currency TEXT NOT NULL,
      category TEXT DEFAULT 'stock',
      source TEXT DEFAULT 'bossa',
      import_batch TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_isin ON transactions(isin);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);

    CREATE TABLE IF NOT EXISTS cash_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      description TEXT NOT NULL,
      details TEXT,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      ticker TEXT,
      fx_rate REAL,
      fx_pair TEXT,
      source TEXT DEFAULT 'bossa',
      import_batch TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_operations_type ON cash_operations(operation_type);
    CREATE INDEX IF NOT EXISTS idx_operations_date ON cash_operations(date);

    CREATE TABLE IF NOT EXISTS ticker_map (
      isin TEXT PRIMARY KEY,
      ticker TEXT NOT NULL,
      name TEXT,
      exchange TEXT,
      currency TEXT DEFAULT 'PLN',
      price_source TEXT DEFAULT 'auto',
      sector TEXT
    );

    CREATE TABLE IF NOT EXISTS manual_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      isin TEXT,
      ticker TEXT NOT NULL,
      name TEXT NOT NULL,
      quantity REAL NOT NULL,
      avg_price REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'PLN',
      date_added TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_cache (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL NOT NULL,
      volume INTEGER,
      PRIMARY KEY (ticker, date)
    );

    CREATE TABLE IF NOT EXISTS stock_splits (
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

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      date TEXT PRIMARY KEY,
      total_value_pln REAL NOT NULL,
      stock_value_pln REAL NOT NULL,
      cash_balance_pln REAL NOT NULL,
      invested_cumulative REAL NOT NULL,
      return_pct REAL NOT NULL,
      computed_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrations for existing databases
  const tmColumns = db.prepare("PRAGMA table_info(ticker_map)").all() as any[];
  if (!tmColumns.some((c: any) => c.name === 'sector')) {
    db.exec("ALTER TABLE ticker_map ADD COLUMN sector TEXT");
  }

  const txColumns = db.prepare("PRAGMA table_info(transactions)").all() as any[];
  if (!txColumns.some((c: any) => c.name === 'category')) {
    db.exec("ALTER TABLE transactions ADD COLUMN category TEXT DEFAULT 'stock'");
  }

  // Migration: tighten stock_splits UNIQUE from (isin, split_date) to (isin)
  // SQLite doesn't support ALTER CONSTRAINT, so recreate the table
  const splitsIndexes = db.prepare("PRAGMA index_list(stock_splits)").all() as any[];
  const hasOldConstraint = splitsIndexes.some((idx: any) => {
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all() as any[];
    return cols.length === 2; // old constraint had 2 columns (isin, split_date)
  });
  if (hasOldConstraint) {
    db.exec(`
      -- Keep only the latest split per ISIN before migration
      DELETE FROM stock_splits WHERE id NOT IN (
        SELECT MAX(id) FROM stock_splits GROUP BY isin
      );
      -- Recreate with new constraint
      CREATE TABLE stock_splits_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        isin TEXT NOT NULL,
        ticker TEXT NOT NULL,
        split_date TEXT NOT NULL,
        ratio REAL NOT NULL,
        source TEXT DEFAULT 'auto',
        detected_at TEXT DEFAULT (datetime('now')),
        UNIQUE(isin)
      );
      INSERT INTO stock_splits_new SELECT * FROM stock_splits;
      DROP TABLE stock_splits;
      ALTER TABLE stock_splits_new RENAME TO stock_splits;
      CREATE INDEX IF NOT EXISTS idx_splits_isin ON stock_splits(isin);
    `);
  }

  // Composite indexes for duplicate detection during import
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_dedup
      ON transactions(date, isin, side, quantity, price);
    CREATE INDEX IF NOT EXISTS idx_operations_dedup
      ON cash_operations(date, operation_type, amount, currency, ticker);
  `);
}
