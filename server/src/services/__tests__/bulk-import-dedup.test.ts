import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-bulk-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-bulk-dedup';

const BOSSA_HEADER = 'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta';

function bossaCsv(rows: string[]): Buffer {
  return Buffer.from([BOSSA_HEADER, ...rows].join('\n'), 'utf-8');
}

const ROW_CDR_2023 =
  '15.03.2023 10:00:00;CDPROJEKT;PLOPTTC00011;10;K;100,00;1000,00;3,90;1003,90;PLN';
const ROW_PKN_2024 =
  '20.05.2024 11:00:00;PKNORLEN;PLPKN0000018;20;K;60,00;1200,00;3,90;1203,90;PLN';
const ROW_KGH_2025 = '10.02.2025 12:00:00;KGHM;PLKGHM000017;5;S;150,00;750,00;3,90;746,10;PLN';

describe('bulkImport — dedup między plikami w jednej paczce', () => {
  let bulkImport: typeof import('../import-service.js').bulkImport;
  let txRepo: typeof import('../../db/transactions-repo.js');
  let connection: typeof import('../../db/connection.js');

  beforeAll(async () => {
    ({ bulkImport } = await import('../import-service.js'));
    txRepo = await import('../../db/transactions-repo.js');
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dwa nakładające się pliki w jednym uploadzie nie tworzą duplikatów', async () => {
    // Plik 1: eksport 2023-2024, Plik 2: eksport 2024-2025 — wiersz PKN w obu
    const file1 = bossaCsv([ROW_CDR_2023, ROW_PKN_2024]);
    const file2 = bossaCsv([ROW_PKN_2024, ROW_KGH_2025]);

    const result = await bulkImport({
      transactionsFiles: [
        { buffer: file1, originalname: 'hisPW-2023-2024.csv' },
        { buffer: file2, originalname: 'hisPW-2024-2025.csv' },
      ],
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    // 3 unikalne transakcje, kopia PKN z drugiego pliku zgłoszona jako duplikat
    expect(result.transactionsImported).toBe(3);
    expect(txRepo.getTransactionsCount(PID)).toBe(3);
    expect(result.duplicatesSkipped).toBe(1);
  });

  it('reimport tej samej paczki jest idempotentny', async () => {
    const file1 = bossaCsv([ROW_CDR_2023, ROW_PKN_2024]);
    const file2 = bossaCsv([ROW_PKN_2024, ROW_KGH_2025]);

    const result = await bulkImport({
      transactionsFiles: [
        { buffer: file1, originalname: 'hisPW-2023-2024.csv' },
        { buffer: file2, originalname: 'hisPW-2024-2025.csv' },
      ],
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(0);
    expect(txRepo.getTransactionsCount(PID)).toBe(3);
  });

  it('legalne duplikaty WEWNĄTRZ jednego pliku są zachowane', async () => {
    // Dwa identyczne zakupy tego samego dnia w jednym pliku = dwa realne zlecenia
    const row = '01.07.2025 09:30:00;PZU;PLPZU0000011;10;K;45,00;450,00;1,90;451,90;PLN';
    const file = bossaCsv([row, row]);

    const result = await bulkImport({
      transactionsFiles: [{ buffer: file, originalname: 'hisPW-pzu.csv' }],
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(2);
  });

  it('plik operacji Bossa idzie czystą pętlą registry (klasyfikacja + parsowanie + markery)', async () => {
    // Transakcje: zakup certyfikatu INTLGOLD; operacje: wykup certyfikatów →
    // RedemptionMarker → reconciliation tworzy syntetyczną S zamykającą pozycję.
    // Test pilnuje, że po przeniesieniu detekcji/parsowania operacji Bossy do
    // PARSER_REGISTRY cały flow (classifyFile → parseOperations → markery) działa.
    const txFile = bossaCsv([
      '01.02.2023 10:00:00;INTLGOLD;PLINTL000017;10;K;100,00;1000,00;0,00;1000,00;PLN',
    ]);
    const opsFile = Buffer.from(
      [
        'data;tytuł operacji;szczegóły;kwota;waluta',
        '2023-01-20;Przelew do DM BO;;1000.00;PLN',
        '2023-06-30;Wykup certyfikatów INTLGOLD;;1200.00;PLN',
      ].join('\n'),
      'utf-8',
    );

    const result = await bulkImport({
      transactionsFiles: [{ buffer: txFile, originalname: 'hisPW-intl.csv' }],
      operationsFile: { buffer: opsFile, originalname: 'operacje_bez_transakcji.csv' },
      portfolioId: PID,
    });

    expect(result.success).toBe(true);
    expect(result.detectedSource).toBe('bossa');
    expect(result.detectedOperationsSource).toBe('bossa');
    expect(result.transactionsImported).toBe(1); // zakup INTLGOLD
    expect(result.operationsImported).toBe(1); // deposit (wykup poszedł jako marker, nie operacja)
    expect(result.syntheticSells).toBe(1); // syntetyczna S z reconciliation wykupu
  });
});
