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

// ── Fixtures importu multi-plik (osobny broker, dwa różne formaty) ──
const MF_PID = 'test-generic-mf';
const MF_TX_HEADER = 'Date,Symbol,ISIN,Side,Qty,Price,Curr';
const mfTx = (rows: string[]) => Buffer.from([MF_TX_HEADER, ...rows].join('\n'), 'utf-8');
const MF_OPS_HEADER = 'Date,Type,Amount,Currency,Note';
const mfOps = (rows: string[]) => Buffer.from([MF_OPS_HEADER, ...rows].join('\n'), 'utf-8');

const MF_TX_PROFILE = {
  specVersion: 1,
  brokerLabel: 'MF Broker',
  file: { delimiter: ',', headerRow: { strategy: 'first' } },
  classify: [{ id: 'trade', when: [{ col: { name: 'Date' }, op: 'notEmpty' }], emit: 'trade' }],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    paperName: { kind: 'column', col: { name: 'Symbol' } },
    isin: { kind: 'column', col: { name: 'ISIN' } },
    quantity: { kind: 'column', col: { name: 'Qty' } },
    price: { kind: 'column', col: { name: 'Price' } },
    currency: { kind: 'column', col: { name: 'Curr' }, fallback: 'PLN' },
    side: { strategy: 'column', col: { name: 'Side' }, buyValues: ['BUY'], sellValues: ['SELL'] },
  },
};
const MF_OPS_PROFILE = {
  specVersion: 1,
  brokerLabel: 'MF Broker',
  file: { delimiter: ',', headerRow: { strategy: 'first' } },
  classify: [
    {
      id: 'dep',
      when: [{ col: { name: 'Type' }, op: 'equals', values: ['Deposit'] }],
      emit: 'deposit',
    },
    {
      id: 'div',
      when: [{ col: { name: 'Type' }, op: 'equals', values: ['Dividend'] }],
      emit: 'dividend',
    },
  ],
  defaultClass: 'skip',
  deposit: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Amount' } },
    currency: { kind: 'column', col: { name: 'Currency' }, fallback: 'PLN' },
    description: { kind: 'column', col: { name: 'Note' } },
  },
  dividend: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Amount' } },
    currency: { kind: 'column', col: { name: 'Currency' }, fallback: 'PLN' },
    description: { kind: 'column', col: { name: 'Note' } },
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
    connection.closeDb(MF_PID);
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
    // P1: sugestia niesie pełny profileJson (file+classify) — kreator klonuje go do
    // adopcji bez ponownej generacji LLM (label/wersja zależą od kolejności testów).
    const sp = result.suggestions![0].profileJson as { file?: unknown; classify?: unknown };
    expect(sp.file).toBeDefined();
    expect(sp.classify).toBeDefined();
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

  // ── Import multi-plik (MF_PID/PID2 — izolacja liczników od PID powyżej) ──

  it('multi-plik: analyze → documents per plik (z file + różne fingerprinty)', async () => {
    const result = await svc.analyzeGenericFiles([
      {
        buffer: mfTx(['2025-05-01,CD PROJEKT,PLOPTTC00011,BUY,10,100.00,PLN']),
        originalname: 'mf-trades.csv',
      },
      { buffer: mfOps(['2025-05-03,Deposit,1000.00,PLN,wplata']), originalname: 'mf-ops.csv' },
    ]);
    expect(result.known).toBe(false);
    expect(result.documents).toHaveLength(2);
    const byFile = Object.fromEntries(result.documents!.map((d) => [d.file, d]));
    expect(byFile['mf-trades.csv'].headers).toContain('Symbol');
    expect(byFile['mf-ops.csv'].headers).toContain('Type');
    expect(byFile['mf-trades.csv'].fingerprint).not.toBe(byFile['mf-ops.csv'].fingerprint);
  });

  it('multi-plik: wszystkie pliki znane (Bossa×2) → documents [] + knownFiles 2', async () => {
    // Regresja: gdy WSZYSTKIE pliki obsługuje parser wbudowany, `documents` MUSI
    // być pustą tablicą (nie undefined), żeby kreator pokazał blok knownFiles
    // zamiast wpaść w legacy-fallback z pustym mapowaniem.
    const bossa = Buffer.from(
      'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta\n' +
        '15.03.2025 10:00:00;KGHM;PLKGHM000017;10;K;150,00;1500,00;3,90;1503,90;PLN',
      'utf-8',
    );
    const result = await svc.analyzeGenericFiles([
      { buffer: bossa, originalname: 'hisPW.csv' },
      { buffer: bossa, originalname: 'hisPW-usd.csv' },
    ]);

    expect(result.known).toBeFalsy();
    expect(result.documents).toEqual([]);
    expect(result.knownFiles).toHaveLength(2);
    expect(result.knownFiles?.every((k) => k.broker === 'bossa')).toBe(true);
  });

  it('multi-plik: commit scala transakcje (plik A) + operacje (plik B) w jeden import', async () => {
    const opsRepo = await import('../../db/operations-repo.js');
    const result = await svc.commitGenericDocuments({
      files: [
        {
          buffer: mfTx([
            '2025-05-01,CD PROJEKT,PLOPTTC00011,BUY,10,100.00,PLN',
            '2025-05-02,KGHM,PLKGHM000017,BUY,5,150.00,PLN',
          ]),
          originalname: 'mf-trades.csv',
        },
        {
          buffer: mfOps([
            '2025-05-03,Deposit,1000.00,PLN,wplata',
            '2025-05-04,Dividend,50.00,PLN,CDR dywidenda',
          ]),
          originalname: 'mf-ops.csv',
        },
      ],
      inputs: [
        { file: 'mf-trades.csv', profileJson: MF_TX_PROFILE },
        { file: 'mf-ops.csv', profileJson: MF_OPS_PROFILE },
      ],
      portfolioId: MF_PID,
    });
    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(2);
    expect(result.operationsImported).toBe(2);
    expect(txRepo.getTransactionsCount(MF_PID)).toBe(2);
    expect(opsRepo.getOperationsCount(MF_PID)).toBe(2);
    const batches = svc.listGenericBatches(MF_PID);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.fileName).sort()).toEqual(['mf-ops.csv', 'mf-trades.csv']);
  });

  it('multi-plik: re-import jednego batcha (raw per plik) — operacje nietknięte', async () => {
    const opsRepo = await import('../../db/operations-repo.js');
    const txBatch = svc.listGenericBatches(MF_PID).find((b) => b.fileName === 'mf-trades.csv')!;
    const before = txRepo.getTransactionsCount(MF_PID);
    const result = await svc.reimportGenericBatch(MF_PID, txBatch.importBatch);
    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(2);
    expect(txRepo.getTransactionsCount(MF_PID)).toBe(before); // delete + insert
    expect(opsRepo.getOperationsCount(MF_PID)).toBe(2); // inny batch — bez zmian
  });

  it('multi-plik: te same nagłówki w 2 plikach (per-waluta) → 1 profil, 2 batche', async () => {
    const PID2 = 'test-generic-mf2';
    const result = await svc.commitGenericDocuments({
      files: [
        {
          buffer: mfTx(['2025-06-01,CD PROJEKT,PLOPTTC00011,BUY,3,100.00,PLN']),
          originalname: 'cur-PLN.csv',
        },
        {
          buffer: mfTx(['2025-06-02,KGHM,PLKGHM000017,BUY,7,150.00,PLN']),
          originalname: 'cur-USD.csv',
        },
      ],
      inputs: [
        { file: 'cur-PLN.csv', profileJson: MF_TX_PROFILE },
        { file: 'cur-USD.csv', profileJson: MF_TX_PROFILE },
      ],
      portfolioId: PID2,
    });
    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(2);
    const batches = svc.listGenericBatches(PID2);
    expect(batches).toHaveLength(2);
    expect(new Set(batches.map((b) => b.profileId)).size).toBe(1); // jeden profil dla obu plików
    connection.closeDb(PID2);
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
