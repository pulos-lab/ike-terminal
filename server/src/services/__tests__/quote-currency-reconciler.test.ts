import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Transaction, TickerMapEntry } from 'shared';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-quote-recon-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-quote-recon';

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    date: '2024-03-05T10:00:00',
    paperName: 'EIMI',
    isin: 'EIMI',
    quantity: 83,
    side: 'K',
    price: 45.73,
    value: 3795.59,
    commission: 0,
    total: 3795.59,
    currency: 'GBP', // etykieta z suffixu .UK
    paymentCurrency: 'PLN',
    fxRate: 3.6995,
    source: 'xtb',
    ...overrides,
  };
}

function entry(overrides: Partial<TickerMapEntry> = {}): TickerMapEntry {
  return {
    isin: 'EIMI',
    ticker: 'EIMI.L',
    name: 'iShares Core MSCI EM IMI',
    exchange: 'OTHER',
    currency: 'USD', // waluta notowania wg Yahoo
    priceSource: 'yahoo',
    ...overrides,
  };
}

describe('reconcileQuoteCurrencies', () => {
  let reconcileQuoteCurrencies: typeof import('../quote-currency-reconciler.js').reconcileQuoteCurrencies;
  let txRepo: typeof import('../../db/transactions-repo.js');
  let tickerRepo: typeof import('../../db/ticker-map-repo.js');
  let connection: typeof import('../../db/connection.js');

  beforeAll(async () => {
    ({ reconcileQuoteCurrencies } = await import('../quote-currency-reconciler.js'));
    txRepo = await import('../../db/transactions-repo.js');
    tickerRepo = await import('../../db/ticker-map-repo.js');
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    txRepo.clearTransactions(PID);
  });

  it('poprawia etykietę GBP→USD wg ticker_map, nie tyka ceny ani fxRate', () => {
    txRepo.insertTransactions([tx()], PID);
    tickerRepo.upsertTickerMapEntry(entry(), PID);

    const { updatedCount, warnings } = reconcileQuoteCurrencies(PID);

    expect(updatedCount).toBe(1);
    expect(warnings).toEqual([]);
    const after = txRepo.getAllTransactions(PID)[0];
    expect(after.currency).toBe('USD');
    expect(after.price).toBe(45.73);
    expect(after.fxRate).toBeCloseTo(3.6995, 6);
    expect(after.paymentCurrency).toBe('PLN');
  });

  it('relabeluje też transakcje bez fxRate (sprzedaż z etykietą z pamięci symbolu)', () => {
    // Sprzedaż bez sparowanego P/L nie ma fxRate, ale etykietę FX ma — bez
    // relabelu zostałaby w innej walucie niż kupna tego samego ISIN-u.
    txRepo.insertTransactions([tx({ isin: 'A1', paperName: 'A1', fxRate: undefined })], PID);
    tickerRepo.upsertTickerMapEntry(entry({ isin: 'A1', ticker: 'A1' }), PID);

    expect(reconcileQuoteCurrencies(PID).updatedCount).toBe(1);
    expect(txRepo.getAllTransactions(PID)[0].currency).toBe('USD');
  });

  it('pomija currency == paymentCurrency oraz źródła spoza xtb/generic', () => {
    txRepo.insertTransactions(
      [
        tx({ isin: 'A2', paperName: 'A2', currency: 'PLN', paymentCurrency: 'PLN' }),
        // mBank: currency z pliku brokera — nie relabelujemy mimo mismatchu z mapą
        tx({ isin: 'A3', paperName: 'A3', source: 'mbank' }),
      ],
      PID,
    );
    tickerRepo.upsertTickerMapEntry(entry({ isin: 'A2', ticker: 'A2' }), PID);
    tickerRepo.upsertTickerMapEntry(entry({ isin: 'A3', ticker: 'A3' }), PID);

    expect(reconcileQuoteCurrencies(PID).updatedCount).toBe(0);
    const after = txRepo.getAllTransactions(PID);
    expect(after.every((t) => t.currency !== 'USD')).toBe(true);
  });

  it('GBp z Yahoo ≡ GBP z parsera — bez relabelu (rodzina GBP)', () => {
    // Osobny ISIN — upsertTickerMapEntry nie nadpisuje istniejących wpisów (kotwica)
    txRepo.insertTransactions([tx({ isin: 'VUKE', paperName: 'VUKE' })], PID);
    tickerRepo.upsertTickerMapEntry(
      entry({ isin: 'VUKE', ticker: 'VUKE.L', currency: 'GBp' }),
      PID,
    );

    expect(reconcileQuoteCurrencies(PID).updatedCount).toBe(0);
    expect(txRepo.getAllTransactions(PID)[0].currency).toBe('GBP');
  });

  it('sprzeczność (Yahoo: notowanie = waluta rozliczenia) → warning bez nadpisania', () => {
    txRepo.insertTransactions([tx({ isin: 'CONF', paperName: 'CONF' })], PID);
    tickerRepo.upsertTickerMapEntry(
      entry({ isin: 'CONF', ticker: 'CONF.WA', currency: 'PLN' }),
      PID,
    );

    const { updatedCount, warnings } = reconcileQuoteCurrencies(PID);

    expect(updatedCount).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CONF');
    expect(txRepo.getAllTransactions(PID).find((t) => t.isin === 'CONF')!.currency).toBe('GBP');
  });

  it('jest idempotentny — drugi przebieg nie znajduje rozjazdów', () => {
    txRepo.insertTransactions([tx({ isin: 'IDEM', paperName: 'IDEM' })], PID);
    tickerRepo.upsertTickerMapEntry(entry({ isin: 'IDEM', ticker: 'IDEM.L' }), PID);

    expect(reconcileQuoteCurrencies(PID).updatedCount).toBe(1);
    expect(reconcileQuoteCurrencies(PID).updatedCount).toBe(0);
  });
});
