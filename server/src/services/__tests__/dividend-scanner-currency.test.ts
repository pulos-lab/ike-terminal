import { describe, it, expect } from 'vitest';
import {
  inferDividendPayoutCurrency,
  convertDividendToPayoutCurrency,
} from '../dividend-scanner.js';
import type { FxToPlnLookup } from '../fx-history.js';
import type { Transaction } from 'shared';

/** Minimalna transakcja K — pola nieistotne dla waluty wypłaty wypełnione zerami. */
function buyTx(overrides: Partial<Transaction>): Transaction {
  return {
    date: '2026-01-10T00:00:00',
    paperName: 'AAPL',
    isin: 'US0378331005',
    quantity: 10,
    side: 'K',
    price: 100,
    value: 1000,
    commission: 0,
    total: 1000,
    currency: 'USD',
    source: 'bossa',
    ...overrides,
  };
}

describe('inferDividendPayoutCurrency', () => {
  const ISIN = 'US0378331005';
  const EX_DATE = '2026-06-15T00:00:00';

  it('wszystkie kupna rozliczone w PLN (auto-FX brokera) → wypłata w PLN', () => {
    const txs = [
      buyTx({ paymentCurrency: 'PLN' }),
      buyTx({ date: '2026-03-01T00:00:00', paymentCurrency: 'PLN' }),
    ];
    expect(inferDividendPayoutCurrency(txs, ISIN, EX_DATE, 'USD')).toBe('PLN');
  });

  it('direct settlement z subkonta USD → wypłata w USD (bez konwersji)', () => {
    const txs = [buyTx({ paymentCurrency: 'USD' })];
    expect(inferDividendPayoutCurrency(txs, ISIN, EX_DATE, 'USD')).toBe('USD');
  });

  it('brak paymentCurrency (stare rekordy) → fallback na currency transakcji', () => {
    const txs = [buyTx({})];
    expect(inferDividendPayoutCurrency(txs, ISIN, EX_DATE, 'USD')).toBe('USD');
  });

  it('mieszane loty → waluta z większością akcji', () => {
    const txs = [
      buyTx({ quantity: 70, paymentCurrency: 'PLN' }),
      buyTx({ date: '2026-04-01T00:00:00', quantity: 30, paymentCurrency: 'USD' }),
    ];
    expect(inferDividendPayoutCurrency(txs, ISIN, EX_DATE, 'USD')).toBe('PLN');
  });

  it('remis akcji → rozstrzyga ostatnie kupno przed ex-date', () => {
    const txs = [
      buyTx({ date: '2026-01-10T00:00:00', quantity: 50, paymentCurrency: 'PLN' }),
      buyTx({ date: '2026-04-01T00:00:00', quantity: 50, paymentCurrency: 'USD' }),
    ];
    expect(inferDividendPayoutCurrency(txs, ISIN, EX_DATE, 'USD')).toBe('USD');
  });

  it('kupno w dniu ex-date i później nie daje prawa do dywidendy → ignorowane', () => {
    const txs = [
      buyTx({ quantity: 10, paymentCurrency: 'USD' }),
      buyTx({ date: '2026-06-15T00:00:00', quantity: 90, paymentCurrency: 'PLN' }),
      buyTx({ date: '2026-07-01T00:00:00', quantity: 90, paymentCurrency: 'PLN' }),
    ];
    expect(inferDividendPayoutCurrency(txs, ISIN, EX_DATE, 'USD')).toBe('USD');
  });

  it('brak kupien przed ex-date → waluta notowania', () => {
    expect(inferDividendPayoutCurrency([], ISIN, EX_DATE, 'USD')).toBe('USD');
  });

  it('sprzedaże i CFD nie wpływają na wynik', () => {
    const txs = [
      buyTx({ paymentCurrency: 'PLN' }),
      buyTx({ side: 'S', quantity: 500, paymentCurrency: 'USD' }),
      buyTx({ category: 'cfd', quantity: 500, paymentCurrency: 'USD' }),
    ];
    expect(inferDividendPayoutCurrency(txs, ISIN, EX_DATE, 'USD')).toBe('PLN');
  });

  it('transakcje innego ISIN są pomijane', () => {
    const txs = [buyTx({ isin: 'US5949181045', paymentCurrency: 'PLN' })];
    expect(inferDividendPayoutCurrency(txs, ISIN, EX_DATE, 'USD')).toBe('USD');
  });
});

describe('convertDividendToPayoutCurrency', () => {
  /** Stały kurs: USD→PLN 4.00, EUR→PLN 4.30, GBX→PLN 0.05; reszta bez kursu. */
  const fx: FxToPlnLookup = (currency) => {
    const upper = currency.toUpperCase();
    if (upper === 'PLN') return 1;
    if (upper === 'USD') return 4.0;
    if (upper === 'EUR') return 4.3;
    if (upper === 'GBX') return 0.05;
    return null;
  };

  it('payout == quote → passthrough bez kursu', () => {
    const out = convertDividendToPayoutCurrency(12.34, 'USD', 'USD', '2026-06-15', fx);
    expect(out).toEqual({ amount: 12.34, currency: 'USD', missingRate: false });
  });

  it('USD → PLN: kwota × kurs, round2, fxPair i fxRate payout-per-quote', () => {
    const out = convertDividendToPayoutCurrency(10.11, 'USD', 'PLN', '2026-06-15', fx);
    expect(out.amount).toBe(40.44);
    expect(out.currency).toBe('PLN');
    expect(out.fxRate).toBe(4.0);
    expect(out.fxPair).toBe('USD/PLN');
    expect(out.missingRate).toBe(false);
  });

  it('kurs krzyżowy bez PLN: USD → EUR przez fx(USD)/fx(EUR)', () => {
    const out = convertDividendToPayoutCurrency(10, 'USD', 'EUR', '2026-06-15', fx);
    expect(out.currency).toBe('EUR');
    expect(out.fxRate).toBeCloseTo(4.0 / 4.3, 10);
    expect(out.amount).toBeCloseTo(9.3, 2);
    expect(out.fxPair).toBe('USD/EUR');
  });

  it('GBX (pensy) → PLN po kursie GBP/100 z lookupu', () => {
    const out = convertDividendToPayoutCurrency(100, 'GBX', 'PLN', '2026-06-15', fx);
    expect(out.amount).toBe(5.0);
    expect(out.currency).toBe('PLN');
  });

  it('brak kursu → fallback do waluty notowania + missingRate', () => {
    const out = convertDividendToPayoutCurrency(10, 'NOK', 'PLN', '2026-06-15', fx);
    expect(out).toEqual({ amount: 10, currency: 'NOK', missingRate: true });
  });
});
