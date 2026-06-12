import { describe, it, expect } from 'vitest';
import { validateImportProfile } from 'shared';
import { parseWithProfile } from '../engine.js';

/**
 * Regresja dla formatów zagranicznych brokerów BEZ parserów wbudowanych
 * (Trading 212, Revolut) — syntetyczne fixtures w realnych układach kolumn.
 * To docelowi klienci ścieżki uniwersalnej: testy przybijają, że spec v1
 * wyraża te formaty, a silnik emituje oczekiwane rekordy.
 */

const BATCH = 'test-foreign';

function profileOf(raw: unknown) {
  const validation = validateImportProfile(raw);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return validation.profile;
}

// ── Trading 212 ──────────────────────────────────────────────────────────────

const T212_HEADER =
  'Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,Total,Currency (Total),Withholding tax,Currency (Withholding tax),ID';

// Czasy z ułamkami sekund jak w realnym eksporcie T212 ("...09:30:02.000").
// Withdrawal z DODATNIĄ kwotą (100) — T212 eksportuje magnitudy bez znaku;
// silnik ma to znormalizować na wypłatę (−100), NIE zaimportować jako wpłatę.
const T212_CSV = [
  T212_HEADER,
  'Deposit,2025-01-02 10:00:00.000,,,,,,,,1000.00,PLN,,,t-dep-1',
  'Withdrawal,2025-02-01 11:00:00.000,,,,,,,,100.00,PLN,,,t-wd-1',
  'Market buy,2025-03-14 09:30:02.000,US0378331005,AAPL,Apple Inc,4,227.50,USD,4.02,910.00,USD,,,o-1',
  'Market sell,2025-04-01 12:00:00.000,PLOPTTC00011,CDR,CD Projekt,10,198.20,PLN,1,1982.00,PLN,,,o-2',
  'Dividend (Ordinary),2025-05-10 08:00:00.000,US0378331005,AAPL,Apple Inc,4,0.25,USD,,0.85,USD,0.15,USD,d-1',
  'Interest on cash,2025-06-30 00:00:00.000,,,,,,,,1.23,PLN,,,t-int-1',
].join('\n');

const T212_PROFILE = profileOf({
  specVersion: 1,
  brokerLabel: 'Trading 212',
  file: { delimiter: ',', headerRow: { strategy: 'first' } },
  classify: [
    {
      id: 'trade',
      when: [{ col: { name: 'Action' }, op: 'oneOf', values: ['Market buy', 'Market sell'] }],
      emit: 'trade',
    },
    {
      id: 'dividend',
      when: [{ col: { name: 'Action' }, op: 'startsWith', values: ['Dividend'] }],
      emit: 'dividend',
    },
    {
      id: 'deposit',
      when: [{ col: { name: 'Action' }, op: 'equals', values: ['Deposit'] }],
      emit: 'deposit',
    },
    {
      id: 'withdrawal',
      when: [{ col: { name: 'Action' }, op: 'equals', values: ['Withdrawal'] }],
      emit: 'withdrawal',
    },
    {
      id: 'interest',
      when: [{ col: { name: 'Action' }, op: 'contains', values: ['Interest'] }],
      emit: 'interest',
    },
  ],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
    paperName: { kind: 'column', col: { name: 'Name' } },
    isin: { kind: 'column', col: { name: 'ISIN' } },
    quantity: { kind: 'column', col: { name: 'No. of shares' } },
    price: { kind: 'column', col: { name: 'Price / share' } },
    value: { kind: 'column', col: { name: 'Total' } },
    currency: { kind: 'column', col: { name: 'Currency (Price / share)' } },
    side: {
      strategy: 'column',
      col: { name: 'Action' },
      buyValues: ['Market buy'],
      sellValues: ['Market sell'],
    },
  },
  dividend: {
    date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Total' } },
    currency: { kind: 'column', col: { name: 'Currency (Total)' } },
    ticker: { kind: 'column', col: { name: 'Ticker' } },
    isin: { kind: 'column', col: { name: 'ISIN' } },
  },
  deposit: {
    date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Total' } },
    currency: { kind: 'column', col: { name: 'Currency (Total)' } },
  },
  withdrawal: {
    date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Total' } },
    currency: { kind: 'column', col: { name: 'Currency (Total)' } },
  },
  interest: {
    date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Total' } },
    currency: { kind: 'column', col: { name: 'Currency (Total)' } },
  },
});

describe('format Trading 212 (syntetyczny) przez silnik generyczny', () => {
  const out = parseWithProfile(T212_CSV, T212_PROFILE, BATCH);

  it('emituje 2 transakcje z pełnymi polami i czasem z kolumny Time', () => {
    expect(out.transactions.data).toHaveLength(2);
    const [buy, sell] = out.transactions.data;
    expect(buy).toMatchObject({
      date: '2025-03-14T09:30:02',
      paperName: 'Apple Inc',
      isin: 'US0378331005',
      side: 'K',
      quantity: 4,
      price: 227.5,
      value: 910,
      currency: 'USD',
    });
    expect(sell).toMatchObject({
      isin: 'PLOPTTC00011',
      side: 'S',
      quantity: 10,
      value: 1982,
      currency: 'PLN',
    });
  });

  it('emituje dywidendę (z tickerem), wpłatę, wypłatę i odsetki', () => {
    expect(out.operations.data).toHaveLength(4);
    const types = out.operations.data.map(
      (o) => `${o.operationType}${o.subkind ? `/${o.subkind}` : ''}`,
    );
    expect(types).toContain('deposit');
    expect(types).toContain('withdrawal');
    expect(types).toContain('dividend');
    expect(types).toContain('other/interest');

    const dividend = out.operations.data.find((o) => o.operationType === 'dividend')!;
    expect(dividend.amount).toBe(0.85);
    expect(dividend.currency).toBe('USD');
    expect(dividend.ticker).toBe('AAPL');

    const deposit = out.operations.data.find((o) => o.operationType === 'deposit')!;
    expect(deposit.amount).toBe(1000);
    expect(deposit.currency).toBe('PLN');
  });

  it('wypłata z DODATNIĄ kwotą (plik bez znaku) → znormalizowana na −100, NIE wpłata', () => {
    const withdrawals = out.operations.data.filter((o) => o.operationType === 'withdrawal');
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0].amount).toBe(-100);
    // Nie powstała druga wpłata z reklasyfikacji wypłaty.
    expect(out.operations.data.filter((o) => o.operationType === 'deposit')).toHaveLength(1);
  });

  it('nic nie ginie po cichu (zero pominięć)', () => {
    expect(out.transactions.skipped).toHaveLength(0);
    expect(out.operations.skipped).toHaveLength(0);
  });
});

// ── Revolut ──────────────────────────────────────────────────────────────────

const REVOLUT_CSV = [
  'Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,FX Rate',
  '2025-01-02 09:00:00,,CASH TOP-UP,,,500.00,USD,',
  '2025-01-15 14:32:01,AAPL,BUY - MARKET,2,150.00,300.00,USD,4.05',
  '2025-02-20 10:11:12,TSLA,SELL - MARKET,1,200.00,200.00,USD,4.00',
  '2025-03-01 00:00:00,AAPL,DIVIDEND,,,0.55,USD,',
  '2025-04-01 00:00:00,,CUSTODY FEE,,,-1.50,USD,',
].join('\n');

const REVOLUT_PROFILE = profileOf({
  specVersion: 1,
  brokerLabel: 'Revolut',
  file: { delimiter: ',', headerRow: { strategy: 'first' } },
  classify: [
    {
      id: 'trade',
      when: [{ col: { name: 'Type' }, op: 'oneOf', values: ['BUY - MARKET', 'SELL - MARKET'] }],
      emit: 'trade',
    },
    {
      id: 'dividend',
      when: [{ col: { name: 'Type' }, op: 'equals', values: ['DIVIDEND'] }],
      emit: 'dividend',
    },
    {
      id: 'deposit',
      when: [{ col: { name: 'Type' }, op: 'equals', values: ['CASH TOP-UP'] }],
      emit: 'deposit',
    },
    {
      id: 'fee',
      when: [{ col: { name: 'Type' }, op: 'equals', values: ['CUSTODY FEE'] }],
      emit: 'fee',
    },
  ],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    paperName: { kind: 'column', col: { name: 'Ticker' } },
    quantity: { kind: 'column', col: { name: 'Quantity' } },
    price: { kind: 'column', col: { name: 'Price per share' } },
    value: { kind: 'column', col: { name: 'Total Amount' } },
    currency: { kind: 'column', col: { name: 'Currency' } },
    side: {
      strategy: 'column',
      col: { name: 'Type' },
      buyValues: ['BUY - MARKET'],
      sellValues: ['SELL - MARKET'],
    },
  },
  dividend: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Total Amount' } },
    currency: { kind: 'column', col: { name: 'Currency' } },
    ticker: { kind: 'column', col: { name: 'Ticker' } },
  },
  deposit: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Total Amount' } },
    currency: { kind: 'column', col: { name: 'Currency' } },
  },
  fee: {
    date: { source: { kind: 'column', col: { name: 'Date' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Total Amount' } },
    currency: { kind: 'column', col: { name: 'Currency' } },
  },
  needsNameResolution: true,
});

describe('format Revolut (syntetyczny, bez ISIN) przez silnik generyczny', () => {
  const out = parseWithProfile(REVOLUT_CSV, REVOLUT_PROFILE, BATCH);

  it('transakcje dostają pseudo-ISIN z tickera (ścieżka needsNameResolution)', () => {
    expect(out.transactions.data).toHaveLength(2);
    const [buy, sell] = out.transactions.data;
    expect(buy.side).toBe('K');
    expect(buy.paperName).toBe('AAPL');
    expect(buy.isin).toBe('AAPL');
    expect(buy.value).toBe(300);
    expect(sell.side).toBe('S');
    expect(sell.isin).toBe('TSLA');
  });

  it('operacje: wpłata, dywidenda z tickerem i opłata (ujemna)', () => {
    expect(out.operations.data).toHaveLength(3);
    const fee = out.operations.data.find((o) => o.operationType === 'fee')!;
    expect(fee.amount).toBeLessThan(0);
    const dividend = out.operations.data.find((o) => o.operationType === 'dividend')!;
    expect(dividend.ticker).toBe('AAPL');
    expect(out.transactions.skipped).toHaveLength(0);
    expect(out.operations.skipped).toHaveLength(0);
  });
});
