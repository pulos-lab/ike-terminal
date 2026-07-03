/**
 * Repo profili importu generycznego (globalna baza import_profiles.db).
 *
 * Inwarianty statusów per fingerprint:
 * - co najwyżej JEDEN profil 'approved' (globalna prawda po kuracji admina),
 * - co najwyżej JEDEN profil 'pending' (nowy wpis wypiera poprzedni pending
 *   jako 'superseded').
 * Edycja użytkownika NIGDY nie wypiera profilu 'approved' — tworzy nowy
 * 'pending' obok; dopiero zatwierdzenie przez admina (Faza 5) podmienia
 * wersję approved. Lookup preferuje approved nad pending.
 */
import { randomUUID } from 'crypto';
import type { ImportProfile } from 'shared';
import { IMPORT_PROFILE_SPEC_VERSION } from 'shared';
import { getImportsDb } from './imports-db.js';

export type ProfileStatus = 'pending' | 'approved' | 'rejected' | 'superseded';
export type ProfileGeneratedBy = 'llm' | 'manual' | 'admin';

export interface ImportProfileRow {
  id: string;
  fingerprint: string;
  version: number;
  status: ProfileStatus;
  specVersion: number;
  profile: ImportProfile;
  brokerLabel: string | null;
  headerNames: string[];
  delimiter: string;
  /** Zredagowane wiersze próbki (do review admina) — null gdy nie zapisano. */
  sampleRows: string[][] | null;
  generatedBy: ProfileGeneratedBy;
  createdByUserId: string | null;
  createdAt: string;
  usageCount: number;
}

interface RawRow {
  id: string;
  fingerprint: string;
  version: number;
  status: ProfileStatus;
  spec_version: number;
  profile_json: string;
  broker_label: string | null;
  header_names_json: string;
  delimiter: string;
  sample_rows_json: string | null;
  generated_by: ProfileGeneratedBy;
  created_by_user_id: string | null;
  created_at: string;
  usage_count: number;
}

function mapRow(r: RawRow): ImportProfileRow {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    version: r.version,
    status: r.status,
    specVersion: r.spec_version,
    profile: JSON.parse(r.profile_json) as ImportProfile,
    brokerLabel: r.broker_label,
    headerNames: JSON.parse(r.header_names_json) as string[],
    delimiter: r.delimiter,
    sampleRows: r.sample_rows_json ? (JSON.parse(r.sample_rows_json) as string[][]) : null,
    generatedBy: r.generated_by,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    usageCount: r.usage_count,
  };
}

const SELECT_COLS = `id, fingerprint, version, status, spec_version, profile_json, broker_label,
  header_names_json, delimiter, sample_rows_json, generated_by, created_by_user_id,
  created_at, usage_count`;

/** Aktywny profil dla fingerprinta: approved ma pierwszeństwo nad pending. */
export function findActiveProfileByFingerprint(fingerprint: string): ImportProfileRow | null {
  const db = getImportsDb();
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM import_profiles
       WHERE fingerprint = ? AND status IN ('approved','pending')
       ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, version DESC
       LIMIT 1`,
    )
    .get(fingerprint) as RawRow | undefined;
  return row ? mapRow(row) : null;
}

export function getProfileById(id: string): ImportProfileRow | null {
  const db = getImportsDb();
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM import_profiles WHERE id = ?`).get(id) as
    | RawRow
    | undefined;
  return row ? mapRow(row) : null;
}

/** Wszystkie aktywne profile (approved/pending) — do sugestii Jaccarda przy analyze. */
export function listActiveProfiles(): ImportProfileRow[] {
  const db = getImportsDb();
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM import_profiles
       WHERE status IN ('approved','pending') ORDER BY usage_count DESC`,
    )
    .all() as RawRow[];
  return rows.map(mapRow);
}

export interface InsertProfileInput {
  fingerprint: string;
  /** Zwalidowany profil (przez ImportProfileSchema) — repo nie waliduje ponownie. */
  profile: ImportProfile;
  headerNames: string[];
  delimiter: string;
  /** ZREDAGOWANE wiersze próbki (sample-redactor) — nigdy surowe dane. */
  sampleRows: string[][] | null;
  generatedBy: ProfileGeneratedBy;
  createdByUserId?: string;
  llmModel?: string;
  llmConfidence?: number;
}

/**
 * Wstawia nową wersję profilu jako 'pending'. Poprzedni 'pending' dla tego
 * fingerprinta → 'superseded' (+audit). Profil 'approved' pozostaje nietknięty.
 */
export function insertPendingProfile(input: InsertProfileInput): ImportProfileRow {
  const db = getImportsDb();
  const id = randomUUID();

  const run = db.transaction(() => {
    const prevPending = db
      .prepare(`SELECT id FROM import_profiles WHERE fingerprint = ? AND status = 'pending'`)
      .get(input.fingerprint) as { id: string } | undefined;
    if (prevPending) {
      db.prepare(`UPDATE import_profiles SET status = 'superseded' WHERE id = ?`).run(
        prevPending.id,
      );
      db.prepare(
        `INSERT INTO profile_audit (profile_id, action, actor_user_id) VALUES (?, 'superseded', ?)`,
      ).run(prevPending.id, input.createdByUserId ?? null);
    }

    const maxVersion = (
      db
        .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM import_profiles WHERE fingerprint = ?`)
        .get(input.fingerprint) as { v: number }
    ).v;

    db.prepare(
      `INSERT INTO import_profiles
         (id, fingerprint, version, status, spec_version, profile_json, broker_label,
          header_names_json, delimiter, sample_rows_json, generated_by,
          llm_model, llm_confidence, created_by_user_id)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.fingerprint,
      maxVersion + 1,
      IMPORT_PROFILE_SPEC_VERSION,
      JSON.stringify(input.profile),
      input.profile.brokerLabel ?? null,
      JSON.stringify(input.headerNames),
      input.delimiter,
      input.sampleRows ? JSON.stringify(input.sampleRows) : null,
      input.generatedBy,
      input.llmModel ?? null,
      input.llmConfidence ?? null,
      input.createdByUserId ?? null,
    );
    db.prepare(
      `INSERT INTO profile_audit (profile_id, action, actor_user_id) VALUES (?, 'created', ?)`,
    ).run(id, input.createdByUserId ?? null);
  });
  run();

  return getProfileById(id)!;
}

export function bumpProfileUsage(id: string): void {
  getImportsDb()
    .prepare(`UPDATE import_profiles SET usage_count = usage_count + 1 WHERE id = ?`)
    .run(id);
}

// ── profile_import_batches ───────────────────────────────────────────────────

export interface ProfileBatchRow {
  id: number;
  profileId: string;
  profileVersion: number;
  portfolioId: string;
  importBatch: string;
  fileName: string | null;
  needsReimport: boolean;
  importedAt: string;
}

export function recordProfileBatch(input: {
  profileId: string;
  profileVersion: number;
  portfolioId: string;
  importBatch: string;
  fileName?: string;
}): void {
  getImportsDb()
    .prepare(
      `INSERT INTO profile_import_batches
         (profile_id, profile_version, portfolio_id, import_batch, file_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(portfolio_id, import_batch) DO UPDATE SET
         profile_id = excluded.profile_id,
         profile_version = excluded.profile_version,
         file_name = excluded.file_name,
         needs_reimport = 0,
         imported_at = datetime('now')`,
    )
    .run(
      input.profileId,
      input.profileVersion,
      input.portfolioId,
      input.importBatch,
      input.fileName ?? null,
    );
}

export function listProfileBatches(portfolioId: string): ProfileBatchRow[] {
  const rows = getImportsDb()
    .prepare(
      `SELECT id, profile_id, profile_version, portfolio_id, import_batch, file_name,
              needs_reimport, imported_at
       FROM profile_import_batches WHERE portfolio_id = ?
       ORDER BY imported_at DESC, id DESC`,
    )
    .all(portfolioId) as Array<{
    id: number;
    profile_id: string;
    profile_version: number;
    portfolio_id: string;
    import_batch: string;
    file_name: string | null;
    needs_reimport: number;
    imported_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    profileVersion: r.profile_version,
    portfolioId: r.portfolio_id,
    importBatch: r.import_batch,
    fileName: r.file_name,
    needsReimport: r.needs_reimport === 1,
    importedAt: r.imported_at,
  }));
}

/** Pojedynczy batch (bez pliku) — wyłącznie dla portfela właściciela (scoping w WHERE). */
export function getProfileBatch(portfolioId: string, importBatch: string): ProfileBatchRow | null {
  const r = getImportsDb()
    .prepare(
      `SELECT id, profile_id, profile_version, portfolio_id, import_batch, file_name,
              needs_reimport, imported_at
       FROM profile_import_batches WHERE portfolio_id = ? AND import_batch = ?`,
    )
    .get(portfolioId, importBatch) as
    | {
        id: number;
        profile_id: string;
        profile_version: number;
        portfolio_id: string;
        import_batch: string;
        file_name: string | null;
        needs_reimport: number;
        imported_at: string;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    profileId: r.profile_id,
    profileVersion: r.profile_version,
    portfolioId: r.portfolio_id,
    importBatch: r.import_batch,
    fileName: r.file_name,
    needsReimport: r.needs_reimport === 1,
    importedAt: r.imported_at,
  };
}

// ── Kuracja admina (Faza 5) ──────────────────────────────────────────────────

export interface AdminProfileRow extends ImportProfileRow {
  llmModel: string | null;
  llmConfidence: number | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Batche zaimportowane DOWOLNĄ wersją tego fingerprinta. */
  batchCount: number;
  /** Z tego: oflagowane do ponownego importu. */
  needsReimportCount: number;
}

const ADMIN_SELECT = `p.id, p.fingerprint, p.version, p.status, p.spec_version, p.profile_json,
  p.broker_label, p.header_names_json, p.delimiter, p.sample_rows_json, p.generated_by,
  p.created_by_user_id, p.created_at, p.usage_count,
  p.llm_model, p.llm_confidence, p.reviewed_by_user_id, p.reviewed_at, p.review_note,
  (SELECT COUNT(*) FROM profile_import_batches b
     JOIN import_profiles p2 ON p2.id = b.profile_id
    WHERE p2.fingerprint = p.fingerprint) AS batch_count,
  (SELECT COUNT(*) FROM profile_import_batches b
     JOIN import_profiles p2 ON p2.id = b.profile_id
    WHERE p2.fingerprint = p.fingerprint AND b.needs_reimport = 1) AS needs_reimport_count`;

type AdminRawRow = RawRow & {
  llm_model: string | null;
  llm_confidence: number | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  batch_count: number;
  needs_reimport_count: number;
};

function mapAdminRow(r: AdminRawRow): AdminProfileRow {
  return {
    ...mapRow(r),
    llmModel: r.llm_model,
    llmConfidence: r.llm_confidence,
    reviewedByUserId: r.reviewed_by_user_id,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
    batchCount: r.batch_count,
    needsReimportCount: r.needs_reimport_count,
  };
}

/** Lista profili do kolejki review — domyślnie pending, najstarsze pierwsze. */
export function listProfilesForAdmin(status?: ProfileStatus): AdminProfileRow[] {
  const db = getImportsDb();
  const where = status ? `WHERE p.status = ?` : '';
  const rows = db
    .prepare(
      `SELECT ${ADMIN_SELECT} FROM import_profiles p ${where}
       ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.created_at ASC`,
    )
    .all(...(status ? [status] : [])) as AdminRawRow[];
  return rows.map(mapAdminRow);
}

export function getProfileForAdmin(id: string): AdminProfileRow | null {
  const row = getImportsDb()
    .prepare(`SELECT ${ADMIN_SELECT} FROM import_profiles p WHERE p.id = ?`)
    .get(id) as AdminRawRow | undefined;
  return row ? mapAdminRow(row) : null;
}

export interface AuditRow {
  id: number;
  profileId: string;
  action: string;
  actorUserId: string | null;
  diff: unknown;
  createdAt: string;
}

export function listProfileAudit(profileId: string): AuditRow[] {
  const rows = getImportsDb()
    .prepare(
      `SELECT id, profile_id, action, actor_user_id, diff_json, created_at
       FROM profile_audit WHERE profile_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(profileId) as Array<{
    id: number;
    profile_id: string;
    action: string;
    actor_user_id: string | null;
    diff_json: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    action: r.action,
    actorUserId: r.actor_user_id,
    diff: r.diff_json ? JSON.parse(r.diff_json) : null,
    createdAt: r.created_at,
  }));
}

/** Sekcje profilu różniące się między dwiema wersjami (diff do audytu/UI). */
export function profileChangedSections(a: ImportProfile, b: ImportProfile): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(
    (k) =>
      JSON.stringify((a as Record<string, unknown>)[k]) !==
      JSON.stringify((b as Record<string, unknown>)[k]),
  );
}

/**
 * Edycja admina: nowa wersja 'pending' (generatedBy='admin') na bazie wersji
 * bazowej — kopiuje nagłówki/delimiter/próbki; audit 'edited' z listą
 * zmienionych sekcji. Zwraca nowy wiersz (do natychmiastowego approve).
 */
export function adminEditProfile(input: {
  baseId: string;
  profile: ImportProfile;
  adminUserId: string;
}): AdminProfileRow {
  const base = getProfileById(input.baseId);
  if (!base) throw new Error('Profil bazowy nie istnieje');

  const inserted = insertPendingProfile({
    fingerprint: base.fingerprint,
    profile: input.profile,
    headerNames: base.headerNames,
    delimiter: base.delimiter,
    sampleRows: base.sampleRows,
    generatedBy: 'admin',
    createdByUserId: input.adminUserId,
  });
  getImportsDb()
    .prepare(
      `INSERT INTO profile_audit (profile_id, action, actor_user_id, diff_json)
       VALUES (?, 'edited', ?, ?)`,
    )
    .run(
      inserted.id,
      input.adminUserId,
      JSON.stringify({
        baseId: base.id,
        baseVersion: base.version,
        changedSections: profileChangedSections(base.profile, input.profile),
      }),
    );
  return getProfileForAdmin(inserted.id)!;
}

/**
 * Zatwierdzenie profilu (musi być 'pending'): poprzedni 'approved' tego
 * fingerprinta → 'superseded'; batche zaimportowane INNYMI wersjami →
 * needs_reimport=1. Zwraca liczbę oflagowanych batchy.
 */
export function approveProfile(input: { id: string; adminUserId: string; note?: string }): {
  flaggedBatches: number;
} {
  const db = getImportsDb();
  let flagged = 0;
  const run = db.transaction(() => {
    const target = getProfileById(input.id);
    if (!target) throw new Error('Profil nie istnieje');
    if (target.status !== 'pending') {
      throw new Error(`Zatwierdzić można tylko profil 'pending' (ten jest '${target.status}')`);
    }

    const prevApproved = db
      .prepare(
        `SELECT id FROM import_profiles WHERE fingerprint = ? AND status = 'approved' AND id != ?`,
      )
      .get(target.fingerprint, target.id) as { id: string } | undefined;
    if (prevApproved) {
      db.prepare(`UPDATE import_profiles SET status = 'superseded' WHERE id = ?`).run(
        prevApproved.id,
      );
      db.prepare(
        `INSERT INTO profile_audit (profile_id, action, actor_user_id) VALUES (?, 'superseded', ?)`,
      ).run(prevApproved.id, input.adminUserId);
    }

    db.prepare(
      `UPDATE import_profiles
         SET status = 'approved', reviewed_by_user_id = ?, reviewed_at = datetime('now'),
             review_note = ?
       WHERE id = ?`,
    ).run(input.adminUserId, input.note ?? null, input.id);
    db.prepare(
      `INSERT INTO profile_audit (profile_id, action, actor_user_id, diff_json)
       VALUES (?, 'approved', ?, ?)`,
    ).run(input.id, input.adminUserId, input.note ? JSON.stringify({ note: input.note }) : null);

    // Batche tego formatu zaimportowane inną wersją → do ponownego importu.
    const res = db
      .prepare(
        `UPDATE profile_import_batches SET needs_reimport = 1
         WHERE profile_id IN (SELECT id FROM import_profiles WHERE fingerprint = ? AND id != ?)`,
      )
      .run(target.fingerprint, target.id);
    flagged = res.changes;
  });
  run();
  return { flaggedBatches: flagged };
}

/** Odrzucenie profilu 'pending' (z notą dla audytu). */
export function rejectProfile(input: { id: string; adminUserId: string; note?: string }): void {
  const db = getImportsDb();
  const run = db.transaction(() => {
    const target = getProfileById(input.id);
    if (!target) throw new Error('Profil nie istnieje');
    if (target.status !== 'pending') {
      throw new Error(`Odrzucić można tylko profil 'pending' (ten jest '${target.status}')`);
    }
    db.prepare(
      `UPDATE import_profiles
         SET status = 'rejected', reviewed_by_user_id = ?, reviewed_at = datetime('now'),
             review_note = ?
       WHERE id = ?`,
    ).run(input.adminUserId, input.note ?? null, input.id);
    db.prepare(
      `INSERT INTO profile_audit (profile_id, action, actor_user_id, diff_json)
       VALUES (?, 'rejected', ?, ?)`,
    ).run(input.id, input.adminUserId, input.note ? JSON.stringify({ note: input.note }) : null);
  });
  run();
}

/**
 * Jednorazowe wymazanie WSZYSTKICH przechowanych surowych plików. Kolumna
 * raw_file_gz to legacy — plików już nie zapisujemy (prywatność); ta funkcja
 * czyści to, co zapisały starsze wersje. Wołana przy starcie serwera,
 * idempotentna (drugi przebieg: 0 wierszy). Zwraca liczbę wyczyszczonych batchy.
 */
export function purgeAllRawFiles(): number {
  const res = getImportsDb()
    .prepare(`UPDATE profile_import_batches SET raw_file_gz = NULL WHERE raw_file_gz IS NOT NULL`)
    .run();
  return res.changes;
}
