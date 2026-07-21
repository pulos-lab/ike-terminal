import { describe, it, expect } from 'vitest';
import { ImportProfileSchema, type ImportProfile } from 'shared';
import { parseWithProfile } from '../engine.js';
import { lintProfile } from '../profile-lints.js';

/**
 * Golden Trade Republic: poprawny profil (kandydat do instalacji na PROD zamiast
 * odrzuconego 9f33f329) uruchomiony na reprezentatywnej próbce w formacie TR.
 * Dane osobowe ZREDAGOWANE (repo publiczne): brak nazwiska/IBAN/realnych id.
 * Zachowane: struktura kolumn, typy operacji, ISIN-y i kwoty (potrzebne asercjom).
 *
 * Weryfikuje, że profil: (1) księguje wpłatę jako 'deposit', (2) STOCKPERK jako
 * 'other' (+), (3) transakcje z ISIN i prowizją, (4) klasy aktywów FUND→etf /
 * CRYPTO→cfd, (5) nic nie ginie (0 skipów), (6) nie odpala strażników lintów.
 */

// eslint-disable-next-line max-len
const TR_HEADER =
  'datetime,date,account_type,category,type,asset_class,name,symbol,shares,price,amount,fee,tax,currency,original_amount,original_currency,fx_rate,description,transaction_id,counterparty_name,counterparty_iban,payment_reference,mcc_code';

const TR_CSV = [
  TR_HEADER,
  '2026-07-02T15:16:10Z,2026-07-02,DEFAULT,CASH,VIBAN_TRANSFER_INBOUND,,Wplata,,,,100000.000000,,,PLN,,,,Incoming transfer,tx-1,,,,',
  '2026-07-06T09:41:25Z,2026-07-06,DEFAULT,TRADING,BUY,FUND,Core MSCI World USD (Acc),IE00B4L5Y983,1.8493580000,540.6800000000,-999.91,-4.00,,PLN,,,,Buy trade,tx-2,,,,',
  '2026-07-06T09:42:13Z,2026-07-06,DEFAULT,TRADING,BUY,STOCK,Micron Technology,US5951121038,0.2654840000,3766.0000000000,-999.81,-4.00,,PLN,,,,Buy trade,tx-3,,,,',
  '2026-07-06T14:42:09Z,2026-07-06,DEFAULT,TRADING,BUY,STOCK,Microsoft,US5949181045,0.0681000000,1443.6000000000,-98.31,,,PLN,,,,Buy trade,tx-4,,,,',
  '2026-07-06T14:42:11Z,2026-07-06,DEFAULT,CASH,STOCKPERK,STOCK,Microsoft,US5949181045,,,98.310000,,,PLN,,,,Stockperk,tx-5,,,,',
  '2026-07-09T07:26:37Z,2026-07-09,DEFAULT,TRADING,BUY,CRYPTO,Bitcoin,BTC,0.0208110000,240253.7287770000,-4999.92,-4.00,,PLN,,,,Buy trade,tx-6,,,,',
].join('\n');

/** Poprawny profil TR — źródło prawdy dla P0 (instalacja na PROD). */
function tradeRepublicProfile(): ImportProfile {
  const date = { source: { kind: 'column', col: { name: 'date' } }, formats: ['YYYY-MM-DD'] };
  const currency = { kind: 'column', col: { name: 'currency' }, fallback: 'PLN' };
  const cash = {
    date,
    amount: { kind: 'column', col: { name: 'amount' } },
    currency,
    description: { kind: 'column', col: { name: 'description' } },
  };
  return ImportProfileSchema.parse({
    specVersion: 1,
    brokerLabel: 'Trade Republic',
    file: {
      delimiter: ',',
      quoteChar: '"',
      headerRow: { strategy: 'first' },
      amountSignPolicy: 'signed',
    },
    classify: [
      {
        id: 'deposit',
        when: [{ col: { name: 'type' }, op: 'oneOf', values: ['VIBAN_TRANSFER_INBOUND'] }],
        emit: 'deposit',
      },
      {
        id: 'withdrawal',
        when: [{ col: { name: 'type' }, op: 'oneOf', values: ['VIBAN_TRANSFER_OUTBOUND'] }],
        emit: 'withdrawal',
      },
      {
        id: 'stockperk',
        when: [{ col: { name: 'type' }, op: 'oneOf', values: ['STOCKPERK'] }],
        emit: 'other',
      },
      {
        id: 'trade',
        when: [{ col: { name: 'type' }, op: 'oneOf', values: ['BUY', 'SELL'] }],
        emit: 'trade',
      },
    ],
    defaultClass: 'skip',
    trade: {
      date,
      paperName: { kind: 'column', col: { name: 'name' } },
      isin: { kind: 'column', col: { name: 'symbol' } },
      quantity: { kind: 'column', col: { name: 'shares' } },
      wholeShares: false,
      price: { kind: 'column', col: { name: 'price' } },
      commission: { kind: 'column', col: { name: 'fee' } },
      currency,
      paymentCurrency: { kind: 'const', value: 'PLN' },
      side: { strategy: 'column', col: { name: 'type' }, buyValues: ['BUY'], sellValues: ['SELL'] },
      category: {
        rules: [
          {
            when: {
              by: 'matcher',
              condition: [{ col: { name: 'asset_class' }, op: 'equals', values: ['FUND'] }],
            },
            category: 'etf',
          },
          {
            when: {
              by: 'matcher',
              condition: [{ col: { name: 'asset_class' }, op: 'equals', values: ['CRYPTO'] }],
            },
            category: 'cfd',
          },
        ],
        default: 'stock',
      },
    },
    deposit: cash,
    withdrawal: cash,
    other: cash,
  });
}

describe('Trade Republic — poprawny profil na próbce w formacie TR', () => {
  const profile = tradeRepublicProfile();
  const out = parseWithProfile(TR_CSV, profile, 'tr-golden');

  it('księguje wpłatę 100 000 PLN jako deposit', () => {
    const dep = out.operations.data.find((o) => o.operationType === 'deposit');
    expect(dep).toBeDefined();
    expect(dep?.amount).toBe(100000);
    expect(dep?.currency).toBe('PLN');
  });

  it('księguje STOCKPERK jako other z dodatnią kwotą (+98,31)', () => {
    const perk = out.operations.data.find((o) => o.operationType === 'other');
    expect(perk).toBeDefined();
    expect(perk?.amount).toBe(98.31);
  });

  it('nic nie ginie — zero pominiętych wierszy', () => {
    expect(out.transactions.skipped).toHaveLength(0);
    expect(out.operations.skipped).toHaveLength(0);
  });

  it('4 transakcje, każda z ISIN i prowizją (z pliku, po abs)', () => {
    expect(out.transactions.data).toHaveLength(4);
    const msci = out.transactions.data.find((t) => t.isin === 'IE00B4L5Y983');
    expect(msci?.commission).toBe(4);
    expect(msci?.category).toBe('etf');
    const micron = out.transactions.data.find((t) => t.isin === 'US5951121038');
    expect(micron?.category).toBe('stock');
    // Microsoft bez prowizji w pliku → 0 (nie „zgubione", po prostu brak fee).
    const msft = out.transactions.data.find((t) => t.isin === 'US5949181045');
    expect(msft?.commission).toBe(0);
  });

  it('Bitcoin (CRYPTO) → transakcja z category cfd i ISIN „BTC" (resolver domknie do BTC-USD)', () => {
    const btc = out.transactions.data.find((t) => t.paperName === 'Bitcoin');
    expect(btc?.category).toBe('cfd');
    expect(btc?.isin).toBe('BTC');
    expect(btc?.quantity).toBeCloseTo(0.020811, 6);
  });

  it('nie odpala żadnego z 4 strażników lintów', () => {
    const codes = lintProfile(profile, out).map((l) => l.code);
    expect(codes).not.toContain('isin-column-unused');
    expect(codes).not.toContain('fee-column-unused');
    expect(codes).not.toContain('cash-rows-routed-to-trade');
    expect(codes).not.toContain('unaccounted-cashflow');
  });
});
