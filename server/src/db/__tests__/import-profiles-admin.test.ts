import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection (wzorzec projektu)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-admin-profiles-'));
process.env.DATA_DIR = tmpDir;

const {
  insertPendingProfile,
  recordProfileBatch,
  adminEditProfile,
  approveProfile,
  rejectProfile,
  listProfilesForAdmin,
  getProfileForAdmin,
  getProfileById,
  findActiveProfileByFingerprint,
  listProfileAudit,
  profileChangedSections,
  sweepRawRetention,
} = await import('../import-profiles-repo.js');
const { getImportsDb, closeImportsDb } = await import('../imports-db.js');
const { validateImportProfile } = await import('shared');

const FP = 'a'.repeat(64);
const HEADERS = ['Data', 'Papier', 'Kierunek', 'Ilość', 'Cena', 'Waluta'];

const RAW_PROFILE = {
  specVersion: 1,
  brokerLabel: 'Broker X',
  file: { delimiter: ';', headerRow: { strategy: 'first' } },
  classify: [{ id: 'trade', when: [{ col: { name: 'Data' }, op: 'notEmpty' }], emit: 'trade' }],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'Data' } }, formats: ['YYYY-MM-DD'] },
    paperName: { kind: 'column', col: { name: 'Papier' } },
    quantity: { kind: 'column', col: { name: 'Ilość' } },
    price: { kind: 'column', col: { name: 'Cena' } },
    currency: { kind: 'column', col: { name: 'Waluta' } },
    side: { strategy: 'column', col: { name: 'Kierunek' }, buyValues: ['K'], sellValues: ['S'] },
  },
  needsNameResolution: true,
};

function validProfile(brokerLabel: string) {
  const validation = validateImportProfile({ ...RAW_PROFILE, brokerLabel });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return validation.profile;
}

function insertPending(brokerLabel: string, userId = 'user-1') {
  return insertPendingProfile({
    fingerprint: FP,
    profile: validProfile(brokerLabel),
    headerNames: HEADERS,
    delimiter: ';',
    sampleRows: [['2025-01-02', 'CDR', 'K', '10', '100', 'PLN']],
    generatedBy: 'llm',
    createdByUserId: userId,
    llmModel: 'mock-model',
    llmConfidence: 0.97,
  });
}

describe('kuracja admina — approve/reject/edycja/retencja', () => {
  afterAll(() => {
    closeImportsDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('approve: pending → approved, stary approved → superseded, batche innych wersji oflagowane', () => {
    const v1 = insertPending('Broker X v1');
    recordProfileBatch({
      profileId: v1.id,
      profileVersion: v1.version,
      portfolioId: 'p-1',
      importBatch: 'batch-1',
      fileName: 'x.csv',
      rawFileGz: Buffer.from('raw'),
    });
    const r1 = approveProfile({ id: v1.id, adminUserId: 'admin', note: 'pierwsza wersja' });
    // Batch zaimportowany TĄ wersją nie wymaga re-importu.
    expect(r1.flaggedBatches).toBe(0);
    expect(getProfileById(v1.id)!.status).toBe('approved');

    // Korekta admina: nowa wersja pending na bazie v1.
    const v2 = adminEditProfile({
      baseId: v1.id,
      profile: validProfile('Broker X poprawiony'),
      adminUserId: 'admin',
    });
    expect(v2.status).toBe('pending');
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.generatedBy).toBe('admin');
    // Approved wciąż nietknięty (edycja nie wypiera).
    expect(getProfileById(v1.id)!.status).toBe('approved');

    const r2 = approveProfile({ id: v2.id, adminUserId: 'admin' });
    expect(r2.flaggedBatches).toBe(1); // batch-1 importowany v1 → do re-importu
    expect(getProfileById(v1.id)!.status).toBe('superseded');
    expect(getProfileById(v2.id)!.status).toBe('approved');
    expect(findActiveProfileByFingerprint(FP)!.id).toBe(v2.id);

    // Audyt: created + edited dla v2, approved; superseded dla v1.
    const auditV2 = listProfileAudit(v2.id).map((a) => a.action);
    expect(auditV2).toContain('edited');
    expect(auditV2).toContain('approved');
    expect(listProfileAudit(v1.id).map((a) => a.action)).toContain('superseded');
  });

  it('reject: tylko pending; odrzucony nie jest aktywny', () => {
    const v3 = insertPending('Broker X v3');
    rejectProfile({ id: v3.id, adminUserId: 'admin', note: 'złe mapowanie' });
    expect(getProfileById(v3.id)!.status).toBe('rejected');
    // Aktywny pozostaje zatwierdzony v2 z poprzedniego testu.
    expect(findActiveProfileByFingerprint(FP)!.brokerLabel).toBe('Broker X poprawiony');
    // Powtórne odrzucenie/zatwierdzenie nie-pending → błąd.
    expect(() => rejectProfile({ id: v3.id, adminUserId: 'admin' })).toThrow(/pending/);
    expect(() => approveProfile({ id: v3.id, adminUserId: 'admin' })).toThrow(/pending/);
  });

  it('lista admina niesie metadane LLM i liczniki batchy', () => {
    const all = listProfilesForAdmin();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const approved = listProfilesForAdmin('approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].batchCount).toBe(1);
    expect(approved[0].needsReimportCount).toBe(1);
    const detail = getProfileForAdmin(approved[0].id)!;
    expect(detail.llmConfidence).toBeNull(); // wersja admina — bez metryk LLM
    expect(detail.sampleRows).not.toBeNull();
  });

  it('profileChangedSections wskazuje tylko różniące się sekcje', () => {
    const a = validProfile('A');
    const b = validProfile('B');
    expect(profileChangedSections(a, b)).toEqual(['brokerLabel']);
    expect(profileChangedSections(a, a)).toEqual([]);
  });

  it('retencja: zeruje raw starsze niż N dni, świeże zostawia', () => {
    const db = getImportsDb();
    // Postarz batch-1 o 100 dni.
    db.prepare(
      `UPDATE profile_import_batches SET imported_at = datetime('now', '-100 days')
       WHERE import_batch = 'batch-1'`,
    ).run();
    const cleared = sweepRawRetention(90);
    expect(cleared).toBe(1);
    const raw = db
      .prepare(`SELECT raw_file_gz FROM profile_import_batches WHERE import_batch = 'batch-1'`)
      .get() as { raw_file_gz: Buffer | null };
    expect(raw.raw_file_gz).toBeNull();
    // Drugi sweep nie ma już czego czyścić.
    expect(sweepRawRetention(90)).toBe(0);
  });
});
