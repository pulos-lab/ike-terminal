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
  rawFileGz?: Buffer;
}): void {
  getImportsDb()
    .prepare(
      `INSERT INTO profile_import_batches
         (profile_id, profile_version, portfolio_id, import_batch, file_name, raw_file_gz)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(portfolio_id, import_batch) DO UPDATE SET
         profile_id = excluded.profile_id,
         profile_version = excluded.profile_version,
         file_name = excluded.file_name,
         raw_file_gz = excluded.raw_file_gz,
         needs_reimport = 0,
         imported_at = datetime('now')`,
    )
    .run(
      input.profileId,
      input.profileVersion,
      input.portfolioId,
      input.importBatch,
      input.fileName ?? null,
      input.rawFileGz ?? null,
    );
}

export function listProfileBatches(portfolioId: string): ProfileBatchRow[] {
  const rows = getImportsDb()
    .prepare(
      `SELECT id, profile_id, profile_version, portfolio_id, import_batch, file_name,
              needs_reimport, imported_at
       FROM profile_import_batches WHERE portfolio_id = ? ORDER BY imported_at DESC`,
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

/** Batch + surowy plik (gzip) — wyłącznie dla portfela właściciela (scoping w WHERE). */
export function getProfileBatchWithRaw(
  portfolioId: string,
  importBatch: string,
): (ProfileBatchRow & { rawFileGz: Buffer | null }) | null {
  const r = getImportsDb()
    .prepare(
      `SELECT id, profile_id, profile_version, portfolio_id, import_batch, file_name,
              raw_file_gz, needs_reimport, imported_at
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
        raw_file_gz: Buffer | null;
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
    rawFileGz: r.raw_file_gz,
    needsReimport: r.needs_reimport === 1,
    importedAt: r.imported_at,
  };
}
