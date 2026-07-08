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
      subkind TEXT,
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
      UNIQUE(isin, split_date)
    );

    CREATE INDEX IF NOT EXISTS idx_splits_isin ON stock_splits(isin);

    -- Spin-offy zastosowane do portfela. Zamrożony jest allocation_pct (jedyna
    -- wielkość zależna od cen rynkowych); ilości silnik wylicza na bieżąco
    -- z transakcji. UNIQUE = idempotencja auto-aplikacji (race-safe przez
    -- ON CONFLICT DO NOTHING w repo). status: applied | skipped_broker | reverted.
    CREATE TABLE IF NOT EXISTS spin_offs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_isin TEXT NOT NULL,
      parent_ticker TEXT NOT NULL,
      child_isin TEXT NOT NULL,
      child_ticker TEXT NOT NULL,
      child_name TEXT,
      ex_date TEXT NOT NULL,
      ratio REAL NOT NULL,
      allocation_pct REAL NOT NULL,
      child_qty REAL NOT NULL,
      currency TEXT NOT NULL,
      parent_price_used REAL,
      child_price_used REAL,
      status TEXT NOT NULL DEFAULT 'applied',
      source TEXT NOT NULL DEFAULT 'map',
      applied_at TEXT DEFAULT (datetime('now')),
      UNIQUE(parent_isin, ex_date)
    );

    CREATE INDEX IF NOT EXISTS idx_spinoffs_child ON spin_offs(child_isin);

    -- Rejestr podatków transakcyjnych (Degiro stamp duty / FTT) doliczonych do
    -- prowizji transakcji. Klucz unikalny czyni doliczanie idempotentnym —
    -- reimport tego samego Account.csv nie zwiększy prowizji drugi raz.
    CREATE TABLE IF NOT EXISTS applied_transaction_taxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      isin TEXT NOT NULL,
      tax_date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      applied_at TEXT DEFAULT (datetime('now')),
      UNIQUE(isin, tax_date, description, amount)
    );

    -- Metadane kontraktów opcyjnych (import IBKR / ręczne dodanie). Instrument w
    -- transactions/ticker_map identyfikowany pseudo-ISIN-em 'OPT:{ticker OCC}';
    -- parametry kontraktu są per kontrakt (nie per transakcja), stąd osobna tabela.
    CREATE TABLE IF NOT EXISTS option_contracts (
      isin TEXT PRIMARY KEY,
      occ_ticker TEXT NOT NULL,
      underlying TEXT NOT NULL,
      expiry TEXT NOT NULL,
      strike REAL NOT NULL,
      option_type TEXT NOT NULL CHECK(option_type IN ('C','P')),
      multiplier REAL NOT NULL DEFAULT 100,
      listing_exch TEXT,
      currency TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
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
  const tmColumns = db.prepare('PRAGMA table_info(ticker_map)').all() as any[];
  if (!tmColumns.some((c: any) => c.name === 'sector')) {
    db.exec('ALTER TABLE ticker_map ADD COLUMN sector TEXT');
  }
  if (!tmColumns.some((c: any) => c.name === 'supersector')) {
    db.exec('ALTER TABLE ticker_map ADD COLUMN supersector TEXT');
  }

  const txColumns = db.prepare('PRAGMA table_info(transactions)').all() as any[];
  if (!txColumns.some((c: any) => c.name === 'category')) {
    db.exec("ALTER TABLE transactions ADD COLUMN category TEXT DEFAULT 'stock'");
  }
  if (!txColumns.some((c: any) => c.name === 'swap')) {
    db.exec('ALTER TABLE transactions ADD COLUMN swap REAL');
    db.exec('ALTER TABLE transactions ADD COLUMN rollover REAL');
  }
  if (!txColumns.some((c: any) => c.name === 'cfd_position_id')) {
    db.exec('ALTER TABLE transactions ADD COLUMN cfd_position_id TEXT');
  }
  if (!txColumns.some((c: any) => c.name === 'cfd_gross_profit')) {
    db.exec('ALTER TABLE transactions ADD COLUMN cfd_gross_profit REAL');
  }
  // PR14 — payment currency (waluta rozliczenia, może być != quote currency)
  if (!txColumns.some((c: any) => c.name === 'payment_currency')) {
    db.exec('ALTER TABLE transactions ADD COLUMN payment_currency TEXT');
  }
  // PR14 — fx rate (kurs wymiany pamiętany przy rozliczeniu foreign → payment)
  if (!txColumns.some((c: any) => c.name === 'fx_rate')) {
    db.exec('ALTER TABLE transactions ADD COLUMN fx_rate REAL');
  }
  // PR16 (bulk-import) — syntetyczne sprzedaże z reconciliation (wezwania skupu, wykupy certyfikatów).
  // Human-readable opis źródła; NULL dla zwykłych transakcji z pliku brokera.
  if (!txColumns.some((c: any) => c.name === 'synthetic_origin')) {
    db.exec('ALTER TABLE transactions ADD COLUMN synthetic_origin TEXT');
  }

  // Migration: poszerzenie stock_splits z UNIQUE(isin) do UNIQUE(isin, split_date) —
  // ISIN może mieć wiele splitów (np. 2:1 a potem 10:1); klucz po samym ISIN-ie
  // po cichu nadpisywał wcześniejsze splity. SQLite nie wspiera ALTER CONSTRAINT,
  // więc tabela jest przebudowywana. Wykrywamy stary constraint po unikalnym
  // indeksie z JEDNĄ kolumną (idx_splits_isin jest nieunikalny, więc nie łapie się).
  const splitsIndexes = db.prepare('PRAGMA index_list(stock_splits)').all() as any[];
  const hasNarrowConstraint = splitsIndexes.some((idx: any) => {
    if (!idx.unique) return false;
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all() as any[];
    return cols.length === 1;
  });
  if (hasNarrowConstraint) {
    db.exec(`
      CREATE TABLE stock_splits_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        isin TEXT NOT NULL,
        ticker TEXT NOT NULL,
        split_date TEXT NOT NULL,
        ratio REAL NOT NULL,
        source TEXT DEFAULT 'auto',
        detected_at TEXT DEFAULT (datetime('now')),
        UNIQUE(isin, split_date)
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
  const migrationFlag = db
    .prepare('SELECT value FROM portfolio_metadata WHERE key = ?')
    .get('pr15_backfill_done') as any;
  if (!migrationFlag) {
    db.exec(`
      UPDATE transactions SET payment_currency = CASE
        WHEN source IN ('bossa', 'mbank') THEN 'PLN'
        WHEN source = 'degiro' THEN 'EUR'
        ELSE currency
      END
      WHERE payment_currency IS NULL OR payment_currency = currency;
    `);
    db.prepare('INSERT INTO portfolio_metadata (key, value) VALUES (?, ?)').run(
      'pr15_backfill_done',
      new Date().toISOString(),
    );
  }

  // P17 — subkind column na cash_operations + reklasyfikacja istniejących rekordów
  // Bossa dla zdarzeń korporacyjnych (capital_return / corporate_action_pending).
  //
  // PRZED P17: "Obniżenie wartości nominalnej GETIN" → operation_type='deposit' (zawyżało MWR).
  //            "Wykup PW - wyrównanie SOLV" → operation_type='other' (ukryte, nie rozpoznane).
  //            "Rozliczenie oferty TICKER" bez cen w tender-offers-map → operation_type='deposit'
  //            (phantom wpłata, inflowuje mianownik XIRR).
  //
  // PO P17: capital_return + subkind=nominal_reduction / redemption_adjustment dla 2 pierwszych;
  //         corporate_action_pending + subkind=unknown_tender / unknown_warrant dla niesparowanych.
  //
  // Migracja idempotentna — WHERE blokują re-apply, a flag w portfolio_metadata gwarantuje
  // że UPDATE'y nie ruszą user's manual edits po pierwszym uruchomieniu.
  const opsColumns = db.prepare('PRAGMA table_info(cash_operations)').all() as any[];
  if (!opsColumns.some((c: any) => c.name === 'subkind')) {
    db.exec('ALTER TABLE cash_operations ADD COLUMN subkind TEXT');
  }
  // Flag v2: wersja v1 błędnie klasyfikowała "Wykup PW - wyrównanie" jako unknown_warrant.
  // Fix reclassyfikuje to na capital_return/redemption_adjustment. Bumpowanie flagi zapewnia
  // że istniejące bazy z v1 dostaną poprawkę na następnym starcie.
  const p17Flag = db
    .prepare('SELECT value FROM portfolio_metadata WHERE key = ?')
    .get('p17_corp_actions_done_v2') as any;
  if (!p17Flag) {
    // 1. Obniżenie nominału (np. GETIN 8250 PLN 2022-12-30) — był zapisany jako deposit.
    //    Humanized description zaczynał się od "Umorzenie akcji % (obniżenie nominału)".
    db.exec(`
      UPDATE cash_operations
      SET operation_type = 'capital_return',
          subkind = 'nominal_reduction'
      WHERE source = 'bossa'
        AND operation_type = 'deposit'
        AND (description LIKE 'Umorzenie akcji%'
             OR description LIKE '%obniżenie nominału%'
             OR description LIKE '%obni\u017cenie nomina\u0142u%');
    `);

    // 2. Wykup PW - wyrównanie (np. SOLV -15.76 USD) — parser nowych importów klasyfikuje
    //    to jako capital_return/redemption_adjustment (korekta po wcześniejszym wykupie —
    //    cash do/z konta, pozycja bez zmian). Migracja uspójnia stare dane.
    //
    //    DWA ŹRÓDŁA rekordów do naprawy:
    //    (a) przed P17 wpadały w 'other' (unknown_operation_type)
    //    (b) przejściowa wersja P17 (v1 migration) klasyfikowała je błędnie jako
    //        corporate_action_pending/unknown_warrant — to było niepoprawne, bo "Wykup PW -
    //        wyrównanie" jest zawsze zamkniętym zdarzeniem (korekta, nie "nieznane"). Fix
    //        przenosi je do właściwej kategorii capital_return.
    //
    //    UWAGA: opis po humanize dla starych rekordów to "Wykup PW - wyrównanie SOLV (kwota brutto)"
    //    (stary humanize nie skracał tego; nowy parser zamienia na "Wyrównanie wykupu SOLV").
    db.exec(`
      UPDATE cash_operations
      SET operation_type = 'capital_return',
          subkind = 'redemption_adjustment'
      WHERE source = 'bossa'
        AND (operation_type = 'other'
             OR (operation_type = 'corporate_action_pending' AND subkind = 'unknown_warrant'))
        AND (description LIKE '%Wykup PW - wyrównanie%'
             OR description LIKE '%Wykup PW - wyr\u00f3wnanie%');
    `);

    // 3. Nieznane wezwania skupu — "Wykup w ofercie skupu TICKER" jako deposit, którego NIE ma
    //    pasującej syntetycznej sprzedaży (transactions.synthetic_origin zawiera 'Wykup w ofercie').
    //    Takie wezwania nigdy nie weszły przez RedemptionMarker (ticker był spoza tender-offers-map).
    //    Reklasyfikuj na corporate_action_pending/unknown_tender. User domknie przez UI.
    db.exec(`
      UPDATE cash_operations
      SET operation_type = 'corporate_action_pending',
          subkind = 'unknown_tender'
      WHERE source = 'bossa'
        AND operation_type = 'deposit'
        AND description LIKE 'Wykup w ofercie skupu%'
        AND NOT EXISTS (
          SELECT 1 FROM transactions t
          WHERE t.synthetic_origin IS NOT NULL
            AND t.synthetic_origin LIKE ('%' || REPLACE(cash_operations.description, 'Wykup w ofercie skupu ', '') || '%')
            AND date(t.date) = date(cash_operations.date)
        );
    `);

    db.prepare('INSERT OR REPLACE INTO portfolio_metadata (key, value) VALUES (?, ?)').run(
      'p17_corp_actions_done_v2',
      new Date().toISOString(),
    );
  }

  // P17 follow-up: deposit z ujemnym amount → withdrawal. Parser Bossy sklasyfikowało
  // "Zwrot nadpłaty — przekroczony limit IKE/IKZE" (i analogiczne) jako `deposit`, ale
  // amount był ujemny — engine filtrował deposit wymagając amount>0, więc te wypływy
  // nie liczyły się do totalWithdrawn ani totalDeposited (znikały z MWR). Fix w parserze
  // naprawia to na nowych importach; migracja uspójnia stare dane. Idempotent — WHERE
  // wymaga amount<0, po UPDATE rekord jest 'withdrawal' → warunek nie matchuje.
  const p17SignFlag = db
    .prepare('SELECT value FROM portfolio_metadata WHERE key = ?')
    .get('p17_deposit_sign_fix') as any;
  if (!p17SignFlag) {
    db.exec(`
      UPDATE cash_operations
      SET operation_type = 'withdrawal'
      WHERE operation_type = 'deposit'
        AND amount < 0;
    `);
    db.prepare('INSERT OR REPLACE INTO portfolio_metadata (key, value) VALUES (?, ?)').run(
      'p17_deposit_sign_fix',
      new Date().toISOString(),
    );
  }

  // P17 follow-up: GreenX Metals (AU0000198939) — dual-listed na ASX Sydney (GRX.AX, AUD)
  // i GPW Warsaw (GRX.WA, PLN). ISIN resolver domyślnie dobierał pierwszy wynik Yahoo by-ISIN
  // (GRX.AX) nawet gdy user kupował przez Bossę w PLN — czyli w UI widoczna była cena z Sydney
  // zamiast GPW. Fix w isin-resolver.ts naprawia to dla NOWYCH importów (preferuje .WA przy
  // txCurrency='PLN'), ale istniejące ticker_map entries zostały z GRX.AX. Ta migracja
  // przestawia je na GRX.WA. Idempotent — WHERE ticker='GRX.AX' po UPDATE nie matchuje.
  const p17GreenxFlag = db
    .prepare('SELECT value FROM portfolio_metadata WHERE key = ?')
    .get('p17_greenx_fix') as any;
  if (!p17GreenxFlag) {
    db.exec(`
      UPDATE ticker_map
      SET ticker = 'GRX.WA',
          exchange = 'GPW',
          currency = 'PLN',
          price_source = 'yahoo'
      WHERE isin = 'AU0000198939'
        AND ticker = 'GRX.AX';
    `);
    db.prepare('INSERT OR REPLACE INTO portfolio_metadata (key, value) VALUES (?, ?)').run(
      'p17_greenx_fix',
      new Date().toISOString(),
    );
  }

  // Ujednolicenie konwencji fxRate — parser DEGIRO zapisywał surowy "Kurs wymiany"
  // (quote per payment, np. 4.3127 PLN za 1 EUR), podczas gdy kanoniczna konwencja
  // Transaction.fxRate to payment-per-quote (1 quote = fxRate × payment) — konsumowana
  // przez payment-currency-reconciler i UI. Inwersja istniejących wierszy DEGIRO.
  // GBX: kolumna DEGIRO jest w pensach za EUR (~87), a price/value trzymamy w GBP —
  // stąd 100/x dla currency='GBP' (LSE w eksportach DEGIRO kwotuje zawsze w GBX).
  // Flaga gwarantuje jednorazowość (podwójna inwersja odtworzyłaby błąd w innej skali).
  const fxConventionFlag = db
    .prepare('SELECT value FROM portfolio_metadata WHERE key = ?')
    .get('fxrate_convention_a_done') as any;
  if (!fxConventionFlag) {
    db.exec(`
      UPDATE transactions
      SET fx_rate = CASE WHEN currency = 'GBP' THEN 100.0 / fx_rate ELSE 1.0 / fx_rate END
      WHERE source = 'degiro' AND fx_rate > 0;
    `);
    db.prepare('INSERT OR REPLACE INTO portfolio_metadata (key, value) VALUES (?, ?)').run(
      'fxrate_convention_a_done',
      new Date().toISOString(),
    );
  }
}
