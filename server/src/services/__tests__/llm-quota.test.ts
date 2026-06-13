import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających connection (wzorzec projektu)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-llm-quota-'));
process.env.DATA_DIR = tmpDir;

const {
  llmDailyLimit,
  llmQuotaExceeded,
  llmGenerationsUsedToday,
  registerLlmGenerationAttempt,
  resetLlmQuotaForTests,
} = await import('../llm-quota.js');
const { insertPendingProfile } = await import('../../db/import-profiles-repo.js');
const { getImportsDb, closeImportsDb } = await import('../../db/imports-db.js');
const { validateImportProfile } = await import('shared');

const USER = 'user-quota-1';

const PROFILE = (() => {
  const v = validateImportProfile({
    specVersion: 1,
    brokerLabel: 'Q',
    file: { delimiter: ',', headerRow: { strategy: 'first' } },
    classify: [{ id: 'trade', when: [{ col: { name: 'D' }, op: 'notEmpty' }], emit: 'trade' }],
    defaultClass: 'skip',
    trade: {
      date: { source: { kind: 'column', col: { name: 'D' } }, formats: ['YYYY-MM-DD'] },
      paperName: { kind: 'column', col: { name: 'P' } },
      quantity: { kind: 'column', col: { name: 'Q' } },
      price: { kind: 'column', col: { name: 'C' } },
      currency: { kind: 'const', value: 'PLN' },
      side: { strategy: 'column', col: { name: 'S' }, buyValues: ['K'], sellValues: ['S'] },
    },
    needsNameResolution: true,
  });
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.profile;
})();

/** Zapis sukcesu LLM do biblioteki (jak generateProfileForFile) — różny fingerprint. */
function persistLlmSuccess(userId: string, fp: string) {
  insertPendingProfile({
    fingerprint: fp,
    profile: PROFILE,
    headerNames: ['D', 'P', 'S', 'Q', 'C'],
    delimiter: ',',
    sampleRows: null,
    generatedBy: 'llm',
    createdByUserId: userId,
    llmModel: 'mock',
    llmConfidence: 0.95,
  });
}

describe('llm-quota — dzienny limit generacji AI per użytkownik', () => {
  beforeEach(() => {
    resetLlmQuotaForTests();
    delete process.env.GENERIC_IMPORT_LLM_DAILY_LIMIT;
  });
  afterAll(() => {
    closeImportsDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('domyślny limit 20, brak konfiguracji', () => {
    expect(llmDailyLimit()).toBe(20);
  });

  it('próby w pamięci sumują się i przekraczają limit', () => {
    process.env.GENERIC_IMPORT_LLM_DAILY_LIMIT = '3';
    expect(llmQuotaExceeded(USER)).toBe(false);
    registerLlmGenerationAttempt(USER);
    registerLlmGenerationAttempt(USER);
    expect(llmGenerationsUsedToday(USER)).toBe(2);
    expect(llmQuotaExceeded(USER)).toBe(false);
    registerLlmGenerationAttempt(USER);
    expect(llmQuotaExceeded(USER)).toBe(true); // 3 ≥ 3
  });

  it('limit ≤0 = wyłączony', () => {
    process.env.GENERIC_IMPORT_LLM_DAILY_LIMIT = '0';
    for (let i = 0; i < 50; i++) registerLlmGenerationAttempt(USER);
    expect(llmQuotaExceeded(USER)).toBe(false);
  });

  it('sukcesy w bazie liczą się po wyzerowaniu pamięci (przeżywają restart)', () => {
    process.env.GENERIC_IMPORT_LLM_DAILY_LIMIT = '2';
    const u = 'user-persist';
    persistLlmSuccess(u, 'b'.repeat(64));
    persistLlmSuccess(u, 'c'.repeat(64));
    resetLlmQuotaForTests(); // symulacja restartu: pamięć znika, baza zostaje
    expect(llmGenerationsUsedToday(u)).toBe(2);
    expect(llmQuotaExceeded(u)).toBe(true);
  });

  it('limit jest per użytkownik (inny user ma czysty licznik)', () => {
    process.env.GENERIC_IMPORT_LLM_DAILY_LIMIT = '1';
    registerLlmGenerationAttempt(USER);
    expect(llmQuotaExceeded(USER)).toBe(true);
    expect(llmQuotaExceeded('inny-user')).toBe(false);
  });

  it('max(pamięć, baza) — nie podwaja sukcesu policzonego w obu', () => {
    process.env.GENERIC_IMPORT_LLM_DAILY_LIMIT = '5';
    const u = 'user-maxcount';
    registerLlmGenerationAttempt(u); // próba w pamięci
    persistLlmSuccess(u, 'd'.repeat(64)); // ten sam sukces utrwalony
    // 1 próba w pamięci, 1 sukces w bazie → max = 1, nie 2.
    expect(llmGenerationsUsedToday(u)).toBe(1);
    void getImportsDb; // referencja, by lint nie marudził o nieużyty import
  });
});
