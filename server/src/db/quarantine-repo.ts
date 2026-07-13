import { createHash } from 'node:crypto';
import type { QuarantineCounts, QuarantineRow, SkipReason, SkippedRow } from 'shared';
import { QUARANTINE_REASONS } from 'shared';
import { getDb } from './connection.js';

// Skrzynka "Do wyjaśnienia": pominięte wiersze importu z surową treścią,
// zapisywane WYŁĄCZNIE w bazie portfela użytkownika (surowe pliki nie są
// trzymane na serwerze — to jedyne trwałe miejsce, gdzie user może wrócić
// do nieprzetworzonych wierszy). Do globalnej bazy zgłoszeń trafia dopiero
// zredagowana próbka za jawnym kliknięciem użytkownika.

/** Anty-spam: plik w całkowicie nieobsługiwanym formacie potrafi wygenerować
 * tysiące nieznanych wierszy — powyżej tego limitu nadwyżka NIE trafia do
 * skrzynki, tylko do zagregowanego warninga importu. */
export const MAX_QUARANTINE_PER_BATCH = 200;

/** Ochrona przed patologicznymi plikami — pojedyncza komórka jest ucinana. */
const MAX_CELL_LEN = 500;

export interface InsertQuarantineInput {
  importBatch: string;
  /** BrokerType lub 'generic'. */
  source: string;
  fileName?: string;
  skipped: SkippedRow[];
  /** Pozostały budżet batcha (multi-file: limit MAX_QUARANTINE_PER_BATCH liczy się
   * łącznie dla całego importu, nie per plik). Domyślnie pełny limit. */
  maxRows?: number;
}

export interface InsertQuarantineResult {
  inserted: number;
  /** Wiersze kwalifikujące się, ale odcięte limitem MAX_QUARANTINE_PER_BATCH. */
  overflow: number;
}

/** Hash po TREŚCI wiersza (nie po batch/row_num): re-import tego samego pliku
 * nie przywraca rozstrzygniętych wierszy, a kolizje row_num między plikami
 * multi-file batcha (IBKR) nie sklejają różnych wierszy. */
function rowHash(source: string, rawType: string | undefined, cellsJson: string): string {
  return createHash('sha1')
    .update(`${source}|${rawType ?? ''}|${cellsJson}`)
    .digest('hex');
}

function clampCells(cells: string[]): string[] {
  return cells.map((c) => (c.length > MAX_CELL_LEN ? c.slice(0, MAX_CELL_LEN) : c));
}

/** Filtr kwalifikacji — podwójny warunek: reason ∈ QUARANTINE_REASONS ORAZ
 * parser dołączył surową treść (patrz komentarz przy QUARANTINE_REASONS). */
export function isQuarantineEligible(s: SkippedRow): boolean {
  return s.raw !== undefined && QUARANTINE_REASONS.has(s.reason);
}

/** INSERT OR IGNORE po row_hash — idempotentny przy re-imporcie. Zwraca liczbę
 * faktycznie NOWYCH wpisów (duplikaty treści liczą się jako 0). */
export function insertQuarantineRows(
  input: InsertQuarantineInput,
  portfolioId: string = 'default',
): InsertQuarantineResult {
  const eligible = input.skipped.filter(isQuarantineEligible);
  const budget = Math.max(
    0,
    Math.min(MAX_QUARANTINE_PER_BATCH, input.maxRows ?? MAX_QUARANTINE_PER_BATCH),
  );
  const capped = eligible.slice(0, budget);
  const overflow = eligible.length - capped.length;
  if (capped.length === 0) return { inserted: 0, overflow };

  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO import_quarantine
      (import_batch, source, file_name, row_num, reason, raw_type, headers_json, raw_cells_json, hint_json, row_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  for (const s of capped) {
    const raw = s.raw!;
    const cellsJson = JSON.stringify(clampCells(raw.cells));
    const info = stmt.run(
      input.importBatch,
      input.source,
      input.fileName ?? null,
      s.row,
      s.reason,
      raw.rawType ?? null,
      raw.headers ? JSON.stringify(raw.headers) : null,
      cellsJson,
      raw.hint ? JSON.stringify(raw.hint) : null,
      rowHash(input.source, raw.rawType, cellsJson),
    );
    inserted += info.changes;
  }
  return { inserted, overflow };
}

interface QuarantineDbRow {
  id: number;
  import_batch: string;
  source: string;
  file_name: string | null;
  row_num: number;
  reason: string;
  raw_type: string | null;
  headers_json: string | null;
  raw_cells_json: string;
  hint_json: string | null;
  status: string;
  resolution_kind: string | null;
  resolved_ref_id: number | null;
  user_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

function toQuarantineRow(r: QuarantineDbRow): QuarantineRow {
  return {
    id: r.id,
    importBatch: r.import_batch,
    source: r.source,
    fileName: r.file_name ?? undefined,
    rowNum: r.row_num,
    reason: r.reason as SkipReason,
    rawType: r.raw_type ?? undefined,
    headers: r.headers_json ? JSON.parse(r.headers_json) : undefined,
    cells: JSON.parse(r.raw_cells_json),
    hint: r.hint_json ? JSON.parse(r.hint_json) : undefined,
    status: r.status as QuarantineRow['status'],
    resolutionKind: (r.resolution_kind as QuarantineRow['resolutionKind']) ?? undefined,
    resolvedRefId: r.resolved_ref_id ?? undefined,
    userNote: r.user_note ?? undefined,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? undefined,
  };
}

export function listQuarantineRows(
  status: QuarantineRow['status'] | undefined,
  portfolioId: string = 'default',
): QuarantineRow[] {
  const db = getDb(portfolioId);
  const rows = (
    status
      ? db
          .prepare(
            'SELECT * FROM import_quarantine WHERE status = ? ORDER BY created_at DESC, id DESC',
          )
          .all(status)
      : db.prepare('SELECT * FROM import_quarantine ORDER BY created_at DESC, id DESC').all()
  ) as QuarantineDbRow[];
  return rows.map(toQuarantineRow);
}

export function getQuarantineRow(
  id: number,
  portfolioId: string = 'default',
): QuarantineRow | null {
  const db = getDb(portfolioId);
  const row = db.prepare('SELECT * FROM import_quarantine WHERE id = ?').get(id) as
    | QuarantineDbRow
    | undefined;
  return row ? toQuarantineRow(row) : null;
}

export function countQuarantineByStatus(portfolioId: string = 'default'): QuarantineCounts {
  const db = getDb(portfolioId);
  const rows = db
    .prepare('SELECT status, COUNT(*) as n FROM import_quarantine GROUP BY status')
    .all() as Array<{ status: string; n: number }>;
  const counts: QuarantineCounts = { pending: 0, resolved: 0, ignored: 0, reported: 0 };
  for (const r of rows) {
    if (r.status in counts) counts[r.status as keyof QuarantineCounts] = r.n;
  }
  return counts;
}

export function ignoreQuarantineRow(
  id: number,
  note: string | undefined,
  portfolioId: string = 'default',
): boolean {
  const db = getDb(portfolioId);
  const info = db
    .prepare(
      `UPDATE import_quarantine
       SET status = 'ignored', user_note = COALESCE(?, user_note), resolved_at = datetime('now')
       WHERE id = ? AND status IN ('pending','reported')`,
    )
    .run(note ?? null, id);
  return info.changes > 0;
}

export interface ResolveQuarantineInput {
  kind: 'transaction' | 'cash_operation';
  /** Id wpisu w transactions/cash_operations; null np. dla pary FX (endpoint nie zwraca id nóg). */
  refId?: number;
  note?: string;
}

/** Oznacza wiersz jako rozstrzygnięty — wołane PO udanym zapisie wpisu przez
 * istniejący endpoint ręczny (dialogi dodawania). */
export function resolveQuarantineRow(
  id: number,
  input: ResolveQuarantineInput,
  portfolioId: string = 'default',
): boolean {
  const db = getDb(portfolioId);
  const info = db
    .prepare(
      `UPDATE import_quarantine
       SET status = 'resolved', resolution_kind = ?, resolved_ref_id = ?,
           user_note = COALESCE(?, user_note), resolved_at = datetime('now')
       WHERE id = ? AND status IN ('pending','reported')`,
    )
    .run(input.kind, input.refId ?? null, input.note ?? null, id);
  return info.changes > 0;
}

/** Oznacza wiersz jako zgłoszony do admina ("nie wiem / nieobsługiwane"). */
export function markQuarantineRowReported(
  id: number,
  portfolioId: string = 'default',
  note?: string,
): boolean {
  const db = getDb(portfolioId);
  const info = db
    .prepare(
      `UPDATE import_quarantine
       SET status = 'reported', user_note = COALESCE(?, user_note)
       WHERE id = ? AND status = 'pending'`,
    )
    .run(note ?? null, id);
  return info.changes > 0;
}

export function deleteQuarantineRow(id: number, portfolioId: string = 'default'): boolean {
  const db = getDb(portfolioId);
  return db.prepare('DELETE FROM import_quarantine WHERE id = ?').run(id).changes > 0;
}

/** Kaskada dla DELETE /api/import/clear — usuwane wszystkie wpisy (także
 * resolved: wskazywałyby na usunięte rekordy transactions/cash_operations). */
export function clearQuarantine(portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  return db.prepare('DELETE FROM import_quarantine').run().changes;
}

/** Re-import batcha (generic, deletePreviousBatch): kasujemy tylko PENDING —
 * poprawiony profil może już rozpoznawać te wiersze (wciąż nieznane wrócą po
 * parsowaniu). Ignored/resolved/reported zostają: row_hash blokuje ich powrót,
 * więc decyzja użytkownika przeżywa re-import. */
export function deletePendingQuarantineByBatch(
  importBatch: string,
  portfolioId: string = 'default',
): number {
  const db = getDb(portfolioId);
  return db
    .prepare("DELETE FROM import_quarantine WHERE import_batch = ? AND status = 'pending'")
    .run(importBatch).changes;
}
