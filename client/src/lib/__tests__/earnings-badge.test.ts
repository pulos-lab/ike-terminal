import { describe, it, expect, vi, afterEach } from 'vitest';
import type { UpcomingEarnings } from 'shared';
import {
  shouldShowEarnings,
  earningsIconClass,
  formatDaysUntil,
} from '@/components/portfolio/EarningsBadge';
import { daysUntilDate } from '@/lib/formatters';

function earnings(overrides: Partial<UpcomingEarnings> = {}): UpcomingEarnings {
  return {
    isin: 'US0378331005',
    ticker: 'AAPL',
    reportDate: '2026-08-05',
    daysUntil: 4,
    confidence: 'confirmed',
    session: 'amc',
    fiscalLabel: 'Q2 26',
    reportKind: 'quarterly',
    source: 'nasdaq',
    ...overrides,
  };
}

/** Zamraża „dziś" — licznik dni liczy się po stronie klienta. */
function freezeToday(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${iso}T12:00:00Z`));
}

afterEach(() => vi.useRealTimers());

describe('daysUntilDate', () => {
  it('liczy dni do daty kalendarzowej', () => {
    freezeToday('2026-08-01');
    expect(daysUntilDate('2026-08-05')).toBe(4);
    expect(daysUntilDate('2026-08-01')).toBe(0);
    expect(daysUntilDate('2026-07-30')).toBe(-2);
  });

  it('nie gubi doby przy zmianie czasu', () => {
    freezeToday('2026-10-24');
    expect(daysUntilDate('2026-10-26')).toBe(2);
  });

  it('przechodzi przez granicę roku', () => {
    freezeToday('2026-12-30');
    expect(daysUntilDate('2027-01-02')).toBe(3);
  });
});

describe('shouldShowEarnings', () => {
  it('pokazuje sygnał w oknie 7 dni', () => {
    freezeToday('2026-08-01');
    expect(shouldShowEarnings(earnings({ reportDate: '2026-08-08' }))).toBe(true);
    expect(shouldShowEarnings(earnings({ reportDate: '2026-08-01' }))).toBe(true);
  });

  it('milczy poza oknem i po publikacji', () => {
    freezeToday('2026-08-01');
    expect(shouldShowEarnings(earnings({ reportDate: '2026-08-09' }))).toBe(false);
    expect(shouldShowEarnings(earnings({ reportDate: '2026-07-31' }))).toBe(false);
    expect(shouldShowEarnings(undefined)).toBe(false);
  });

  it('REGRESJA: dzień publikacji liczony jest na kliencie, nie z pola serwera', () => {
    // Serwer policzył daysUntil=7 wczoraj; karta wisiała otwarta przez noc.
    freezeToday('2026-08-08');
    expect(shouldShowEarnings(earnings({ reportDate: '2026-08-08', daysUntil: 7 }))).toBe(true);
    expect(daysUntilDate('2026-08-08')).toBe(0);
  });
});

describe('earningsIconClass', () => {
  it('na dzień przed i w dniu publikacji zmienia kolor na ostrzegawczy', () => {
    expect(earningsIconClass(1, 'confirmed')).toBe('text-warning');
    expect(earningsIconClass(0, 'confirmed')).toBe('text-warning');
  });

  it('wcześniej jest neutralny, a termin szacowany wyszarzony', () => {
    expect(earningsIconClass(5, 'confirmed')).toBe('text-info');
    expect(earningsIconClass(5, 'tentative')).toBe('text-info');
    expect(earningsIconClass(5, 'estimated')).toBe('text-muted-foreground opacity-80');
  });

  it('pilność wygrywa nad niepewnością', () => {
    expect(earningsIconClass(1, 'estimated')).toBe('text-warning');
  });
});

describe('formatDaysUntil', () => {
  it('odmienia po polsku', () => {
    expect(formatDaysUntil(0)).toBe('dziś');
    expect(formatDaysUntil(1)).toBe('jutro');
    expect(formatDaysUntil(5)).toBe('za 5 dni');
  });
});
