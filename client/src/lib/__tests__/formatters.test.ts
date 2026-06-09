import { describe, expect, it } from 'vitest';
import { formatDate, formatTimestampLocal } from '../formatters';

describe('formatDate', () => {
  it('formatuje datę kalendarzową YYYY-MM-DD jako DD.MM.YYYY', () => {
    expect(formatDate('2024-05-03')).toBe('03.05.2024');
    expect(formatDate('2024-12-31')).toBe('31.12.2024');
    expect(formatDate('2024-01-01')).toBe('01.01.2024');
  });

  it('formatuje ISO datetime po dacie kalendarzowej (bez przesunięcia strefy)', () => {
    expect(formatDate('2024-05-03T00:00:00')).toBe('03.05.2024');
    expect(formatDate('2024-05-03T23:59:59Z')).toBe('03.05.2024');
    expect(formatDate('2024-05-03 10:15:00')).toBe('03.05.2024');
  });

  it('jest niezależny od strefy czasowej (czysty string slicing, bez Date)', () => {
    // Regresja: new Date('2024-05-03') = UTC midnight → na zachód od UTC
    // toLocaleDateString pokazywało 02.05.2024. String slicing nie ma tego problemu —
    // wynik jest identyczny niezależnie od TZ procesu.
    expect(formatDate('2024-05-03')).toBe('03.05.2024');
    expect(formatDate('2024-05-03T00:00:00Z')).toBe('03.05.2024');
  });

  it('przepuszcza nierozpoznany input bez zmian', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate('nie-data')).toBe('nie-data');
    expect(formatDate('03.05.2024')).toBe('03.05.2024');
    expect(formatDate('2024-5-3')).toBe('2024-5-3');
  });
});

describe('formatTimestampLocal', () => {
  it('interpretuje SQLite UTC timestamp i pokazuje lokalną datę', () => {
    // Oczekiwanie budowane tym samym mechanizmem (Date + lokalna strefa),
    // więc test przechodzi w każdej strefie czasowej.
    const expected = new Date('2026-01-05T14:30:00Z').toLocaleDateString('pl-PL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    expect(formatTimestampLocal('2026-01-05 14:30:00')).toBe(expected);
  });

  it('nie dokleja drugiego Z gdy timestamp ma już strefę', () => {
    const expected = new Date('2026-01-05T14:30:00Z').toLocaleDateString('pl-PL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    expect(formatTimestampLocal('2026-01-05T14:30:00Z')).toBe(expected);
    expect(formatTimestampLocal('2026-01-05T15:30:00+01:00')).toBe(expected);
  });

  it('przepuszcza nieparsowalny input bez zmian', () => {
    expect(formatTimestampLocal('nie-timestamp')).toBe('nie-timestamp');
    expect(formatTimestampLocal('')).toBe('');
  });
});
