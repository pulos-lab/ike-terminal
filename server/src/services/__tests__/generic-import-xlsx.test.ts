import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';

// DATA_DIR przed importem modułów dotykających connection (wzorzec projektu)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-generic-xlsx-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-generic-xlsx';

/**
 * Import XLSX uniwersalny: WSZYSTKIE arkusze z danymi przez ten sam silnik,
 * scalone w jeden atomowy import; każdy arkusz = osobny fingerprint/profil/batch.
 * Skoroszyt budowany w pamięci: arkusz „Trades" (transakcje) + „Cash" (operacje)
 * + „Info" (okładka, pomijana).
 */

const TRADE_PROFILE = {
  specVersion: 1,
  brokerLabel: 'XLSX Broker',
  file: { delimiter: ';', headerRow: { strategy: 'first' } },
  classify: [{ id: 'trade', when: [{ col: { name: 'Date' }, op: 'notEmpty' }], emit: 'trade' }],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    paperName: { kind: 'column', col: { name: 'Name' } },
    isin: { kind: 'column', col: { name: 'ISIN' } },
    quantity: { kind: 'column', col: { name: 'Qty' } },
    price: { kind: 'column', col: { name: 'Price' } },
    currency: { kind: 'column', col: { name: 'Ccy' } },
    side: { strategy: 'column', col: { name: 'Side' }, buyValues: ['BUY'], sellValues: ['SELL'] },
  },
};

const CASH_PROFILE = {
  specVersion: 1,
  brokerLabel: 'XLSX Broker',
  file: { delimiter: ';', headerRow: { strategy: 'first' } },
  classify: [
    {
      id: 'deposit',
      when: [{ col: { name: 'Type' }, op: 'equals', values: ['DEPOSIT'] }],
      emit: 'deposit',
    },
    {
      id: 'dividend',
      when: [{ col: { name: 'Type' }, op: 'equals', values: ['DIVIDEND'] }],
      emit: 'dividend',
    },
  ],
  defaultClass: 'skip',
  deposit: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Amount' } },
    currency: { kind: 'column', col: { name: 'Ccy' } },
  },
  dividend: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Amount' } },
    currency: { kind: 'column', col: { name: 'Ccy' } },
    ticker: { kind: 'column', col: { name: 'Symbol' } },
  },
};

async function buildXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const trades = wb.addWorksheet('Trades');
  trades.addRow(['Date', 'Name', 'ISIN', 'Side', 'Qty', 'Price', 'Ccy']);
  trades.addRow(['2025-03-15', 'CD PROJEKT', 'PLOPTTC00011', 'BUY', 10, 100.0, 'PLN']);
  trades.addRow(['2025-04-10', 'KGHM', 'PLKGHM000017', 'SELL', 5, 150.0, 'PLN']);

  const cash = wb.addWorksheet('Cash');
  cash.addRow(['Date', 'Type', 'Symbol', 'Amount', 'Ccy']);
  cash.addRow(['2025-01-02', 'DEPOSIT', '', 1000.0, 'PLN']);
  cash.addRow(['2025-05-10', 'DIVIDEND', 'CDR', 12.5, 'PLN']);

  const info = wb.addWorksheet('Info');
  info.addRow(['Wygenerowano 2025-06-13']); // jednokolumnowa okładka → pomijana

  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('generic-import-service — XLSX wieloarkuszowy', () => {
  let svc: typeof import('../generic-import-service.js');
  let txRepo: typeof import('../../db/transactions-repo.js');
  let opsRepo: typeof import('../../db/operations-repo.js');
  let connection: typeof import('../../db/connection.js');
  let importsDb: typeof import('../../db/imports-db.js');
  let tickerRepo: typeof import('../../db/ticker-map-repo.js');
  let xlsxBuffer: Buffer;

  beforeAll(async () => {
    svc = await import('../generic-import-service.js');
    txRepo = await import('../../db/transactions-repo.js');
    opsRepo = await import('../../db/operations-repo.js');
    connection = await import('../../db/connection.js');
    importsDb = await import('../../db/imports-db.js');
    tickerRepo = await import('../../db/ticker-map-repo.js');
    // ISIN-y znane statycznie → rezolucja bez sieci.
    tickerRepo.seedTickerMap(PID);
    xlsxBuffer = await buildXlsx();
  });

  afterAll(() => {
    connection.closeDb(PID);
    importsDb.closeImportsDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('analyze: XLSX → format xlsx, 2 arkusze z danymi, Info pominięty', async () => {
    const result = await svc.analyzeGenericFile({
      buffer: xlsxBuffer,
      originalname: 'broker_export.xlsx',
    });
    expect(result.known).toBe(false);
    expect(result.format).toBe('xlsx');
    expect(result.sheets).toHaveLength(2);
    const names = result.sheets!.map((s) => s.sheet);
    expect(names).toEqual(['Trades', 'Cash']);
    expect(result.skippedSheets).toContain('Info');
    // Fingerprint XLSX różny per arkusz.
    expect(result.sheets![0].fingerprint).not.toBe(result.sheets![1].fingerprint);
    expect(result.sheets![0].headers).toContain('ISIN');
  });

  it('preview: oba arkusze scalone, wkład per arkusz w sheetSummaries', async () => {
    const result = await svc.previewGenericMulti(
      { buffer: xlsxBuffer, originalname: 'broker_export.xlsx' },
      [
        { sheet: 'Trades', profileJson: TRADE_PROFILE },
        { sheet: 'Cash', profileJson: CASH_PROFILE },
      ],
    );
    expect(result.ok).toBe(true);
    expect(result.transactions?.total).toBe(2);
    expect(result.operations?.total).toBe(2);
    expect(result.sheetSummaries).toHaveLength(2);
    expect(result.sheetSummaries!.find((s) => s.sheet === 'Trades')!.transactions).toBe(2);
    expect(result.sheetSummaries!.find((s) => s.sheet === 'Cash')!.operations).toBe(2);
    expect(txRepo.getTransactionsCount(PID)).toBe(0); // preview nic nie zapisuje
  });

  it('commit: oba arkusze → jeden import, scalone liczby; batch per arkusz', async () => {
    const result = await svc.commitGeneric({
      buffer: xlsxBuffer,
      originalname: 'broker_export.xlsx',
      portfolioId: PID,
      sheets: [
        { sheet: 'Trades', profileJson: TRADE_PROFILE },
        { sheet: 'Cash', profileJson: CASH_PROFILE },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(2);
    expect(result.operationsImported).toBe(2);
    expect(txRepo.getTransactionsCount(PID)).toBe(2);
    expect(opsRepo.getOperationsCount(PID)).toBe(2);

    // Dwa batche (po jednym na arkusz), oba z etykietą arkusza.
    const batches = svc.listGenericBatches(PID);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.sheet).sort()).toEqual(['Cash', 'Trades']);
  });

  it('reimport przez ponowne wgranie: izoluje arkusz Trades, Cash nietknięty', async () => {
    // Dokładnie jeden batch Trades (przed testem idempotencji) — ten z wierszami.
    const tradesBatch = svc.listGenericBatches(PID).find((b) => b.sheet === 'Trades')!;
    const beforeTx = txRepo.getTransactionsCount(PID);
    const beforeOps = opsRepo.getOperationsCount(PID);

    // Użytkownik wgrywa cały plik XLSX ponownie; fingerprint dobiera arkusz Trades.
    const result = await svc.reimportGenericBatchFromUpload(PID, tradesBatch.importBatch, {
      buffer: xlsxBuffer,
      originalname: 'broker_export.xlsx',
    });

    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(2); // arkusz Trades: delete + insert
    expect(txRepo.getTransactionsCount(PID)).toBe(beforeTx);
    expect(opsRepo.getOperationsCount(PID)).toBe(beforeOps); // Cash (inny batch) — bez zmian
  });

  it('commit ponownie tego samego pliku → wszystko duplikaty (idempotencja)', async () => {
    const result = await svc.commitGeneric({
      buffer: xlsxBuffer,
      originalname: 'broker_export.xlsx',
      portfolioId: PID,
      sheets: [
        { sheet: 'Trades', profileJson: TRADE_PROFILE },
        { sheet: 'Cash', profileJson: CASH_PROFILE },
      ],
    });
    expect(result.transactionsImported).toBe(0);
    expect(result.operationsImported).toBe(0);
    expect(result.duplicatesSkipped).toBe(4);
    expect(txRepo.getTransactionsCount(PID)).toBe(2); // bez zmian
  });
});
