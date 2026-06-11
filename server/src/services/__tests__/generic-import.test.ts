import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection (wzorzec bulk-import)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-generic-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-generic-import';

/**
 * Testy integracyjne importu generycznego: analyze → preview → commit →
 * idempotentny re-commit → reimport. Tymczasowe bazy (portfela + globalna
 * import_profiles.db) w DATA_DIR; ISIN-y ze statycznej TICKER_MAP, żeby
 * rezolucja tickerów nie dotykała sieci.
 */

// Egzotyczny format "nieznanego brokera" — celowo inny niż Bossa/mBank/DEGIRO.
const HEADER = 'Trade date|Security|ISIN code|Direction|Shares|Unit price|Ccy|Client account';
const ROW_CDR = '2025-03-15|CD PROJEKT|PLOPTTC00011|BUY|10|100.00|PLN|PL61109010140000071219812874';
const ROW_KGH = '2025-04-10|KGHM|PLKGHM000017|SELL|5|150.00|PLN|PL61109010140000071219812874';

const csvBuffer = (rows: string[]) => Buffer.from([HEADER, ...rows].join('\n'), 'utf-8');

const PROFILE = {
  specVersion: 1,
  brokerLabel: 'Testowy Broker',
  file: { delimiter: '|', headerRow: { strategy: 'first' } },
  classify: [
    { id: 'trade', when: [{ col: { name: 'Trade date' }, op: 'notEmpty' }], emit: 'trade' },
  ],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'Trade date' } }, formats: ['YYYY-MM-DD'] },
    paperName: { kind: 'column', col: { name: 'Security' } },
    isin: { kind: 'column', col: { name: 'ISIN code' } },
    quantity: { kind: 'column', col: { name: 'Shares' } },
    price: { kind: 'column', col: { name: 'Unit price' } },
    currency: { kind: 'column', col: { name: 'Ccy' }, fallback: 'PLN' },
    side: {
      strategy: 'column',
      col: { name: 'Direction' },
      buyValues: ['BUY'],
      sellValues: ['SELL'],
    },
  },
};

describe('generic-import-service — analyze → preview → commit → reimport', () => {
  let svc: typeof import('../generic-import-service.js');
  let txRepo: typeof import('../../db/transactions-repo.js');
  let profilesRepo: typeof import('../../db/import-profiles-repo.js');
  let connection: typeof import('../../db/connection.js');
  let importsDb: typeof import('../../db/imports-db.js');

  beforeAll(async () => {
    svc = await import('../generic-import-service.js');
    txRepo = await import('../../db/transactions-repo.js');
    profilesRepo = await import('../../db/import-profiles-repo.js');
    connection = await import('../../db/connection.js');
    importsDb = await import('../../db/imports-db.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    importsDb.closeImportsDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('analyze: znany broker (Bossa) → known:true, bez fingerprinta', async () => {
    const bossa = Buffer.from(
      'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta\n' +
        '15.03.2025 10:00:00;KGHM;PLKGHM000017;10;K;150,00;1500,00;3,90;1503,90;PLN',
      'utf-8',
    );
    const result = await svc.analyzeGenericFile({ buffer: bossa, originalname: 'hisPW.csv' });
    expect(result.known).toBe(true);
    expect(result.broker).toBe('bossa');
    expect(result.fingerprint).toBeUndefined();
  });

  it('analyze: nieznany format → fingerprint + nagłówki + ZREDAGOWANA próbka', async () => {
    const result = await svc.analyzeGenericFile({
      buffer: csvBuffer([ROW_CDR, ROW_KGH]),
      originalname: 'unknown-broker.csv',
    });

    expect(result.known).toBe(false);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.delimiter).toBe('|');
    expect(result.headers).toContain('ISIN code');
    expect(result.profile).toBeUndefined(); // biblioteka pusta
    // Redakcja: kolumna "Client account" zamaskowana, ISIN/kwoty zostają
    const sample = result.sampleRows![0];
    expect(sample).toContain('***');
    expect(sample).toContain('PLOPTTC00011');
    expect(sample.join('|')).not.toContain('109010140000');
  });

  it('preview: poprawny profil → wynik bez zapisu do bazy', async () => {
    const result = svc.previewGeneric({ buffer: csvBuffer([ROW_CDR, ROW_KGH]) }, PROFILE);

    expect(result.ok).toBe(true);
    expect(result.transactions?.total).toBe(2);
    expect(result.transactions?.sample[0]).toMatchObject({
      paperName: 'CD PROJEKT',
      isin: 'PLOPTTC00011',
      side: 'K',
      quantity: 10,
      price: 100,
    });
    expect(result.rowTraces?.filter((t) => t.target === 'transaction')).toHaveLength(2);
    expect(txRepo.getTransactionsCount(PID)).toBe(0); // preview nic nie zapisuje
  });

  it('preview: zepsuty profil → ok:false z błędami walidacji (PL)', () => {
    const broken = { ...PROFILE, classify: [{ id: 'x', when: [], emit: 'trade' }] };
    const result = svc.previewGeneric({ buffer: csvBuffer([ROW_CDR]) }, broken);
    expect(result.ok).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('commit z profilem inline: import + profil zapisany jako pending + batch z gzipem', async () => {
    const result = await svc.commitGeneric({
      buffer: csvBuffer([ROW_CDR, ROW_KGH]),
      originalname: 'unknown-broker.csv',
      portfolioId: PID,
      userId: 'user-1',
      profileJson: PROFILE,
    });

    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(2);
    expect(result.detectedSource).toBe('generic');
    expect(result.profileStatus).toBe('pending');
    expect(result.brokerLabel).toBe('Testowy Broker');
    expect(txRepo.getTransactionsCount(PID)).toBe(2);

    // Profil w bibliotece pod fingerprintem pliku
    const analyze = await svc.analyzeGenericFile({
      buffer: csvBuffer([ROW_CDR]),
      originalname: 'x.csv',
    });
    expect(analyze.profile?.summary.id).toBe(result.profileId);
    expect(analyze.profile?.summary.status).toBe('pending');

    // Batch zapisany z surowym plikiem (re-import możliwy)
    const batches = svc.listGenericBatches(PID);
    expect(batches).toHaveLength(1);
    expect(batches[0].importBatch).toBe(result.importBatch);
    expect(batches[0].profileVersion).toBe(1);
  });

  it('re-commit tego samego pliku po profileId → wszystko jako duplikaty', async () => {
    const analyze = await svc.analyzeGenericFile({
      buffer: csvBuffer([ROW_CDR]),
      originalname: 'x.csv',
    });
    const result = await svc.commitGeneric({
      buffer: csvBuffer([ROW_CDR, ROW_KGH]),
      originalname: 'unknown-broker-again.csv',
      portfolioId: PID,
      profileId: analyze.profile!.summary.id,
    });

    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(0);
    expect(result.duplicatesSkipped).toBe(2);
    expect(txRepo.getTransactionsCount(PID)).toBe(2); // bez zmian — idempotencja
  });

  it('edytowany profil inline → nowa wersja pending, stara superseded', async () => {
    const edited = { ...PROFILE, brokerLabel: 'Testowy Broker v2' };
    const result = await svc.commitGeneric({
      buffer: csvBuffer([ROW_CDR, ROW_KGH]),
      originalname: 'unknown-broker.csv',
      portfolioId: PID,
      profileJson: edited,
    });

    expect(result.success).toBe(true);
    expect(result.profileVersion).toBe(2);
    expect(result.duplicatesSkipped).toBe(2); // dane już są — sam profil się zmienił

    // Aktywny = nowa wersja; poprzednia wyparta
    const analyze = await svc.analyzeGenericFile({
      buffer: csvBuffer([ROW_CDR]),
      originalname: 'x.csv',
    });
    expect(analyze.profile?.summary.version).toBe(2);
    expect(analyze.profile?.summary.brokerLabel).toBe('Testowy Broker v2');
  });

  it('reimport batcha: liczba wierszy bez zmian (delete + insert atomowo)', async () => {
    const before = txRepo.getTransactionsCount(PID);
    const batches = svc.listGenericBatches(PID);
    // Najstarszy batch = pierwszy commit — jedyny, do którego należą wiersze
    // (kolejne commity były w całości duplikatami).
    const target = batches[batches.length - 1];

    const result = await svc.reimportGenericBatch(PID, target.importBatch);

    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(2); // wstawione na nowo po delete
    expect(txRepo.getTransactionsCount(PID)).toBe(before);
    // Batch wskazuje teraz aktualną (najnowszą) wersję profilu
    const after = svc.listGenericBatches(PID).find((b) => b.importBatch === target.importBatch);
    expect(after?.profileVersion).toBe(2);
    expect(after?.needsReimport).toBe(false);
  });

  it('analyze: podobny format (dodatkowa kolumna) → sugestia z biblioteki', async () => {
    const similarHeader = `${HEADER}|Extra fee`;
    const similar = Buffer.from([similarHeader, `${ROW_CDR}|0.00`].join('\n'), 'utf-8');
    const result = await svc.analyzeGenericFile({ buffer: similar, originalname: 'similar.csv' });

    expect(result.known).toBe(false);
    expect(result.profile).toBeUndefined(); // inny fingerprint — exact match nie trafia
    expect(result.suggestions?.length).toBeGreaterThan(0);
    expect(result.suggestions![0].similarity).toBeGreaterThanOrEqual(0.75);
  });

  it('commit bez profilu → czytelny błąd', async () => {
    const result = await svc.commitGeneric({
      buffer: csvBuffer([ROW_CDR]),
      originalname: 'x.csv',
      portfolioId: PID,
    });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('profil');
  });
});

describe('sample-redactor', () => {
  it('maskuje kolumny wrażliwe, IBAN-y, e-maile i długie ciągi cyfr', async () => {
    const { redactSampleRows } = await import('../sample-redactor.js');
    const headers = ['Data', 'Nr rachunku', 'Opis', 'Kwota'];
    const rows = [
      ['2025-01-01', 'PL61109010140000071219812874', 'przelew od jan@example.com', '100,50'],
      ['2025-01-02', '12345678901234', 'id klienta 98765432101', '-23909,40'],
    ];
    const redacted = redactSampleRows(headers, rows);

    expect(redacted[0][1]).toBe('***'); // cała kolumna wrażliwa
    expect(redacted[0][2]).toBe('przelew od ***');
    expect(redacted[1][2]).toBe('id klienta ***');
    expect(redacted[0][0]).toBe('2025-01-01'); // daty nietknięte
    expect(redacted[0][3]).toBe('100,50'); // kwoty nietknięte
    expect(redacted[1][3]).toBe('-23909,40');
  });
});
