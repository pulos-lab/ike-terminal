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
      synthetic_origin TEXT,
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
      sector TEXT,
      supersector TEXT
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
  if (!tmColumns.some((c: any) => c.name === 'supersector')) {
    db.exec("ALTER TABLE ticker_map ADD COLUMN supersector TEXT");
  }

  const txColumns = db.prepare("PRAGMA table_info(transactions)").all() as any[];
  if (!txColumns.some((c: any) => c.name === 'category')) {
    db.exec("ALTER TABLE transactions ADD COLUMN category TEXT DEFAULT 'stock'");
  }
  if (!txColumns.some((c: any) => c.name === 'swap')) {
    db.exec("ALTER TABLE transactions ADD COLUMN swap REAL");
    db.exec("ALTER TABLE transactions ADD COLUMN rollover REAL");
  }
  if (!txColumns.some((c: any) => c.name === 'cfd_position_id')) {
    db.exec("ALTER TABLE transactions ADD COLUMN cfd_position_id TEXT");
  }
  if (!txColumns.some((c: any) => c.name === 'cfd_gross_profit')) {
    db.exec("ALTER TABLE transactions ADD COLUMN cfd_gross_profit REAL");
  }
  // PR14 — payment currency (waluta rozliczenia, może być != quote currency)
  if (!txColumns.some((c: any) => c.name === 'payment_currency')) {
    db.exec("ALTER TABLE transactions ADD COLUMN payment_currency TEXT");
  }
  // PR14 — fx rate (kurs wymiany pamiętany przy rozliczeniu foreign → payment)
  if (!txColumns.some((c: any) => c.name === 'fx_rate')) {
    db.exec("ALTER TABLE transactions ADD COLUMN fx_rate REAL");
  }
  // PR16 (bulk-import) — syntetyczne sprzedaże z reconciliation (wezwania skupu, wykupy certyfikatów).
  // Human-readable opis źródła; NULL dla zwykłych transakcji z pliku brokera.
  if (!txColumns.some((c: any) => c.name === 'synthetic_origin')) {
    db.exec("ALTER TABLE transactions ADD COLUMN synthetic_origin TEXT");
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
    CREATE INDEX IF NOT EXISTS idx_transactions_cfd_dedup
      ON transactions(cfd_position_id, side, date)
      WHERE cfd_position_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_operations_dedup
      ON cash_operations(date, operation_type, amount, currency, ticker);

    CREATE TABLE IF NOT EXISTS portfolio_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // PR15 — one-time backfill paymentCurrency per source (runs once, gated przez flag w metadata).
  // Pokrywa rekordy zbackfillowane w PR14 jako paymentCurrency=currency oraz świeże NULL.
  // Po wykonaniu nie nadpisuje ponownie (user manual edits są bezpieczne).
  const migrationFlag = db.prepare("SELECT value FROM portfolio_metadata WHERE key = ?").get('pr15_backfill_done') as any;
  if (!migrationFlag) {
    db.exec(`
      UPDATE transactions SET payment_currency = CASE
        WHEN source IN ('bossa', 'mbank') THEN 'PLN'
        WHEN source = 'degiro' THEN 'EUR'
        ELSE currency
      END
      WHERE payment_currency IS NULL OR payment_currency = currency;
    `);
    db.prepare("INSERT INTO portfolio_metadata (key, value) VALUES (?, ?)").run('pr15_backfill_done', new Date().toISOString());
  }
}
