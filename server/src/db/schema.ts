import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      paper_name TEXT NOT NULL,
      isin TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('K', 'S')),
      price REAL NOT NULL,
      value REAL NOT NULL,
      commission REAL NOT NULL,
      total REAL NOT NULL,
      currency TEXT NOT NULL,
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
      quantity INTEGER NOT NULL,
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
  const columns = db.prepare("PRAGMA table_info(ticker_map)").all() as any[];
  if (!columns.some((c: any) => c.name === 'sector')) {
    db.exec("ALTER TABLE ticker_map ADD COLUMN sector TEXT");
  }
}
