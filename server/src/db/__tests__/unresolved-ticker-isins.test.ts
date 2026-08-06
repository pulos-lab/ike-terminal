import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Transaction, TickerMapEntry } from 'shared';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-unresolved-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-unresolved';

function tx(isin: string, paperName = isin): Transaction {
  return {
    date: '2025-02-10T15:38:29',
    paperName,
    isin,
    quantity: 1,
    side: 'K',
    price: 100,
    value: 100,
    commission: 0,
    total: 100,
    currency: 'USD',
    category: 'stock',
  } as Transaction;
}

function entry(o: Partial<TickerMapEntry>): TickerMapEntry {
  return {
    isin: 'X',
    ticker: 'X',
    name: 'X',
    exchange: 'OTHER',
    currency: 'USD',
    priceSource: 'yahoo',
    ...o,
  };
}

/**
 * GENEZA (zgłoszenie GOOGC.US, 2026-08-06): lazy pass leczący nierozpoznane tickery
 * patrzył wyłącznie na prowizoryczne stuby, a stuba zapisuje TYLKO ścieżka CSV.
 * Import XTB XLSX i IBKR HTML idzie przez `importCombinedFiles`, który po
 * nierozpoznanym papierze nie zostawia żadnego wpisu — więc pass go nie widział
 * i pozycja zostawała bez ceny na zawsze (7,5 szt. GOOGC od lutego 2025).
 */
describe('getUnresolvedTickerIsins — obie klasy: brak wpisu i stub', () => {
  let repo: typeof import('../ticker-map-repo.js');
  let txRepo: typeof import('../transactions-repo.js');
  let connection: typeof import('../connection.js');

  beforeAll(async () => {
    repo = await import('../ticker-map-repo.js');
    txRepo = await import('../transactions-repo.js');
    connection = await import('../connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const e of repo.getAllTickers(PID)) repo.deleteTickerMapEntry(e.isin, PID);
    const ids = txRepo
      .getAllTransactions(PID)
      .map((t) => t.id)
      .filter((id): id is number => typeof id === 'number');
    if (ids.length > 0) txRepo.deleteTransactions(ids, PID);
  });

  it('łapie ISIN bez ŻADNEGO wpisu — klasa GOOGC z importu XTB', () => {
    txRepo.insertTransaction(tx('GOOGC'), PID);
    expect(repo.getUnresolvedTickerIsins(PID)).toEqual(new Set(['GOOGC']));
  });

  it('łapie prowizoryczny stub (dotychczasowe zachowanie bez regresji)', () => {
    txRepo.insertTransaction(tx('PLNEWCO00011', 'NOWASPOLKA'), PID);
    repo.upsertTickerMapEntry(
      entry({ isin: 'PLNEWCO00011', ticker: 'NOWASPOLKA', name: 'NOWASPOLKA' }),
      PID,
    );
    expect(repo.getUnresolvedTickerIsins(PID)).toEqual(new Set(['PLNEWCO00011']));
  });

  it('NIE zwraca papieru z prawdziwym wpisem', () => {
    txRepo.insertTransaction(tx('US0378331005', 'AAPL'), PID);
    repo.upsertTickerMapEntry(
      entry({ isin: 'US0378331005', ticker: 'AAPL', name: 'Apple Inc.' }),
      PID,
    );
    expect(repo.getUnresolvedTickerIsins(PID)).toEqual(new Set());
  });

  it('symbol z sufiksem giełdy NIE jest stubem, nawet gdy ticker === name', () => {
    // Lustro `isProvisionalStub`: „CDR.WA"/„CDR.WA" to realny symbol, nie placeholder.
    txRepo.insertTransaction(tx('CDR.WA', 'CDR.WA'), PID);
    repo.upsertTickerMapEntry(entry({ isin: 'CDR.WA', ticker: 'CDR.WA', name: 'CDR.WA' }), PID);
    expect(repo.getUnresolvedTickerIsins(PID)).toEqual(new Set());
  });

  it('zwraca każdy ISIN raz, niezależnie od liczby transakcji', () => {
    txRepo.insertTransaction(tx('GOOGC'), PID);
    txRepo.insertTransaction({ ...tx('GOOGC'), date: '2025-03-13T00:00:00' }, PID);
    expect(repo.getUnresolvedTickerIsins(PID)).toEqual(new Set(['GOOGC']));
  });

  it('pusty portfel → pusty zbiór (pass się nie odpali)', () => {
    expect(repo.getUnresolvedTickerIsins(PID).size).toBe(0);
  });
});
