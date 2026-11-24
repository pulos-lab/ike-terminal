import { describe, it, expect } from 'vitest';
import type { UpcomingDividend, UpcomingEarnings } from 'shared';
import { buildPortfolioEvents, formatEventWhen } from '../portfolio-events';

const TODAY = '2026-11-23'; // poniedziałek

const earnings = (ticker: string, reportDate: string, over: Partial<UpcomingEarnings> = {}) =>
  ({
    isin: `ISIN_${ticker}`,
    ticker,
    reportDate,
    daysUntil: 0,
    confidence: 'confirmed',
    session: null,
    fiscalLabel: null,
    reportKind: null,
    source: 'nasdaq',
    ...over,
  }) as UpcomingEarnings;

const dividend = (
  ticker: string,
  exDividendDate: string,
  paymentDate: string | null,
  over: Partial<UpcomingDividend> = {},
): UpcomingDividend => ({
  ticker,
  name: ticker,
  exDividendDate,
  paymentDate,
  estimatedAmount: 100,
  currency: 'PLN',
  shares: 10,
  dividendPerShare: 10,
  dividendYield: 4,
  ...over,
});

describe('buildPortfolioEvents', () => {
  it('scala wyniki i dywidendy w jedną listę od najbliższego terminu', () => {
    const events = buildPortfolioEvents({
      earnings: [earnings('MU', '2026-11-24', { session: 'amc', fiscalLabel: 'Q1 2027' })],
      dividends: [dividend('XTB.WA', '2026-11-26', '2026-12-10')],
      today: TODAY,
    });
    expect(events.map((e) => [e.ticker, e.kind, e.daysUntil])).toEqual([
      ['MU', 'earnings', 1],
      ['XTB.WA', 'ex-dividend', 3],
    ]);
    expect(events[0]).toMatchObject({ title: 'wyniki Q1 2027', detail: 'po sesji' });
    expect(events[1].title).toBe('odcięcie dywidendy');
  });

  it('po odcięciu dywidenda pokazuje termin wypłaty — jeden wiersz na dywidendę', () => {
    const events = buildPortfolioEvents({
      earnings: [],
      dividends: [dividend('MSFT', '2026-11-19', '2026-12-10', { currency: 'USD' })],
      today: TODAY,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'dividend-payment',
      date: '2026-12-10',
      daysUntil: 17,
      title: 'wypłata dywidendy',
    });
  });

  it('odrzuca terminy przeszłe i spoza okna', () => {
    const events = buildPortfolioEvents({
      earnings: [earnings('OLD', '2026-11-20'), earnings('FAR', '2027-01-15')],
      dividends: [
        dividend('PAID', '2026-10-01', '2026-10-20'),
        dividend('NOPAY', '2026-11-01', null),
      ],
      today: TODAY,
    });
    expect(events).toEqual([]);
  });

  it('opcja i akcje na tę samą spółkę dają jeden wiersz wyników', () => {
    const events = buildPortfolioEvents({
      earnings: [
        earnings('NVDA', '2026-11-25'),
        earnings('NVDA', '2026-11-25', { isin: 'OPT:NVDA261218C00150000', viaUnderlying: true }),
      ],
      dividends: [],
      today: TODAY,
    });
    expect(events).toHaveLength(1);
  });

  it('termin szacowany i dywidenda proponowana są nazwane', () => {
    const events = buildPortfolioEvents({
      earnings: [earnings('SAP.DE', '2026-11-30', { confidence: 'estimated' })],
      dividends: [dividend('PZU.WA', '2026-12-01', null, { status: 'proponowana' })],
      today: TODAY,
    });
    expect(events[0].detail).toBe('termin szacowany');
    expect(events[1].detail).toMatch(/^ok\. .*zł · propozycja$/);
  });

  it('dzisiejszy termin wchodzi na listę', () => {
    const events = buildPortfolioEvents({
      earnings: [earnings('AAPL', TODAY, { session: 'bmo' })],
      dividends: [],
      today: TODAY,
    });
    expect(events[0]).toMatchObject({ daysUntil: 0, detail: 'przed sesją' });
  });
});

describe('formatEventWhen', () => {
  it('dziś, jutro, a dalej dzień tygodnia z datą', () => {
    expect(formatEventWhen('2026-11-23', 0)).toBe('dziś');
    expect(formatEventWhen('2026-11-24', 1)).toBe('jutro');
    expect(formatEventWhen('2026-11-26', 3)).toBe('czw. 26.11');
    expect(formatEventWhen('2026-12-10', 17)).toBe('czw. 10.12');
  });
});
