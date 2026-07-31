import { getDb } from './connection.js';

/**
 * Prośby o ponowne wgranie wyciągu.
 *
 * Powstały, bo istniejący mechanizm `needs_reimport` (`profile_import_batches`)
 * obsługuje WYŁĄCZNIE importy uniwersalne — wiersze w tej tabeli mają klucz obcy
 * do profilu, a parsery wbudowane (Bossa, mBank, DEGIRO, XTB, IBKR, T212) żadnego
 * profilu nie mają. Po każdej poprawce parsera nie było więc jak powiedzieć
 * użytkownikowi „wgraj plik jeszcze raz" inaczej niż mailem.
 *
 * Notatkę zakładamy TYLKO wtedy, gdy poprawka nie da się zastosować wstecznie:
 * skrypt migracyjny umie naprawić to, co jest w bazie, ale nie odtworzy wierszy,
 * które przy imporcie w ogóle nie powstały.
 */

export interface ReimportNotice {
  id: number;
  source: string;
  reason: string;
  detail: string | null;
  createdAt: string;
}

interface Row {
  id: number;
  source: string;
  reason: string;
  detail: string | null;
  created_at: string;
}

/** Zakłada notatkę; ponowne wywołanie z tą samą parą (source, reason) nic nie robi. */
export function addReimportNotice(
  portfolioId: string,
  notice: { source: string; reason: string; detail?: string },
): boolean {
  const db = getDb(portfolioId);
  const res = db
    .prepare(
      `INSERT INTO reimport_notices (source, reason, detail)
       VALUES (?, ?, ?)
       ON CONFLICT(source, reason) DO NOTHING`,
    )
    .run(notice.source, notice.reason, notice.detail ?? null);
  return res.changes > 0;
}

export function getActiveReimportNotices(portfolioId: string): ReimportNotice[] {
  const db = getDb(portfolioId);
  const rows = db
    .prepare(
      `SELECT id, source, reason, detail, created_at
         FROM reimport_notices
        WHERE dismissed_at IS NULL
        ORDER BY created_at`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    reason: r.reason,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

/** Odłożenie na bok — notatka znika z UI, ale zostaje w bazie jako ślad. */
export function dismissReimportNotice(portfolioId: string, id: number): boolean {
  const db = getDb(portfolioId);
  const res = db
    .prepare(
      `UPDATE reimport_notices SET dismissed_at = datetime('now') WHERE id = ? AND dismissed_at IS NULL`,
    )
    .run(id);
  return res.changes > 0;
}
