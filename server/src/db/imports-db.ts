/**
 * Globalna baza importu generycznego — `data/import_profiles.db`.
 *
 * Profile są FORMAT-level (opisują układ CSV brokera, zero danych użytkownika),
 * więc żyją poza bazami per-portfel i są współdzielone między użytkownikami —
 * wzorzec price_history.db. auth.db celowo nietknięta (należy do better-auth).
 *
 * Tabele:
 * - import_profiles        — wersjonowane profile keyed by fingerprint nagłówków,
 * - profile_audit          — ślad zmian (created/edited/approved/rejected/superseded),
 * - profile_import_batches — który import (portfel+batch) użył której wersji profilu,
 * - unknown_type_reports   — zagregowane zgłoszenia nieznanych typów operacji ze
 *                            skrzynki "Do wyjaśnienia" (kind: classified = luka
 *                            parsera, unsupported = brak funkcjonalności); trzyma
 *                            WYŁĄCZNIE zredagowaną próbkę (sample-redactor).
 *
 * Prywatność: plików użytkownika NIE przechowujemy. Kolumna `raw_file_gz` to legacy
 * (niezapisywana; czyszczona przy starcie przez `purgeAllRawFiles`). Re-import po
 * korekcie profilu wymaga ponownego wgrania pliku przez użytkownika. W
 * `sample_rows_json` ląduje WYŁĄCZNIE zredagowana próbka (sample-redactor) — to ją
 * widzi admin przy review.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

let db: Database.Database | null = null;

export function getImportsDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(config.dataDir, 'import_profiles.db');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // Jak w connection.ts: prod (systemd ProtectSystem=strict) nie ma zapisywalnego
    // /tmp — pliki tymczasowe SQLite muszą zostać w pamięci.
    db.pragma('temp_store = MEMORY');
    db.exec(`
      CREATE TABLE IF NOT EXISTS import_profiles (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','superseded')),
        spec_version INTEGER NOT NULL,
        profile_json TEXT NOT NULL,
        broker_label TEXT,
        header_names_json TEXT NOT NULL,
        delimiter TEXT NOT NULL,
        sample_rows_json TEXT,
        generated_by TEXT NOT NULL CHECK(generated_by IN ('llm','manual','admin')),
        llm_model TEXT,
        llm_confidence REAL,
        created_by_user_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_by_user_id TEXT,
        reviewed_at TEXT,
        review_note TEXT,
        usage_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(fingerprint, version)
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_fp ON import_profiles(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_profiles_status ON import_profiles(status);

      CREATE TABLE IF NOT EXISTS profile_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('created','edited','approved','rejected','superseded')),
        actor_user_id TEXT,
        diff_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_profile ON profile_audit(profile_id);

      CREATE TABLE IF NOT EXISTS profile_import_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        profile_version INTEGER NOT NULL,
        portfolio_id TEXT NOT NULL,
        import_batch TEXT NOT NULL,
        file_name TEXT,
        raw_file_gz BLOB, -- legacy, nieużywane: plików nie przechowujemy (purgeAllRawFiles czyści)
        needs_reimport INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(portfolio_id, import_batch)
      );
      CREATE INDEX IF NOT EXISTS idx_batches_portfolio ON profile_import_batches(portfolio_id);
      CREATE INDEX IF NOT EXISTS idx_batches_profile ON profile_import_batches(profile_id);

      CREATE TABLE IF NOT EXISTS unknown_type_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker TEXT NOT NULL,
        raw_type TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('classified','unsupported')),
        headers_json TEXT,
        sample_cells_json TEXT,
        suggestions_json TEXT NOT NULL DEFAULT '[]',
        reporter_ids_json TEXT NOT NULL DEFAULT '[]',
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','rejected','wont_fix')),
        first_reported_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_reported_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_by_user_id TEXT,
        reviewed_at TEXT,
        review_note TEXT,
        UNIQUE(broker, raw_type, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_utr_status ON unknown_type_reports(status);
    `);
  }
  return db;
}

/** Zamknięcie połączenia — testy (tymczasowe DATA_DIR) i graceful shutdown. */
export function closeImportsDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
