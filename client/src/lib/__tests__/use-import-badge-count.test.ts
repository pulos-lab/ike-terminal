import { describe, it, expect } from 'vitest';
import { countImportIssues, importIssuesLabel } from '../use-import-badge-count';

describe('countImportIssues', () => {
  it('sumuje kwarantannę, sprzedaże bez kupna i importy do ponownego wgrania', () => {
    expect(
      countImportIssues({
        quarantinePending: 3,
        orphanedSellsPending: 2,
        batches: [{ needsReimport: true }, { needsReimport: false }, {}],
      }),
    ).toBe(6);
  });

  it('brak danych (zapytania jeszcze nie wróciły) daje zero, nie NaN', () => {
    expect(countImportIssues({})).toBe(0);
    expect(countImportIssues({ quarantinePending: undefined, batches: undefined })).toBe(0);
  });
});

describe('importIssuesLabel', () => {
  it('odmienia liczebnik po polsku', () => {
    expect(importIssuesLabel(0)).toBe('');
    expect(importIssuesLabel(1)).toBe('1 sprawa importu do wyjaśnienia');
    expect(importIssuesLabel(3)).toBe('3 sprawy importu do wyjaśnienia');
    expect(importIssuesLabel(5)).toBe('5 spraw importu do wyjaśnienia');
    expect(importIssuesLabel(12)).toBe('12 spraw importu do wyjaśnienia');
    expect(importIssuesLabel(22)).toBe('22 sprawy importu do wyjaśnienia');
  });
});
