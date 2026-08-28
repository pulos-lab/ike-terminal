import { describe, it, expect } from 'vitest';
import { applyIsinAlias, ISIN_ALIASES_MAP } from 'shared';

/**
 * Testy mapy aliasów ISIN (shared/src/isin-aliases-map.ts) — w szczególności
 * granicy datowej `appliesUntil` dodanej dla konwersji PDA→akcje (REXA→REX),
 * gdzie zwolniony ticker PDA może w przyszłości przypaść innej spółce.
 */
describe('applyIsinAlias', () => {
  it('nieznany identyfikator przechodzi bez zmian', () => {
    const r = applyIsinAlias('PLJSW0000015', 'JSW');
    expect(r).toEqual({ isin: 'PLJSW0000015', paperName: 'JSW', aliasApplied: false });
  });

  it('wpis bez appliesUntil aliasuje niezależnie od daty (HUUUGE)', () => {
    const r = applyIsinAlias('PLHGE0000020', 'HUUUGE_IPO', '2031-01-01');
    expect(r.aliasApplied).toBe(true);
    expect(r.isin).toBe('US44853H1086');
  });

  it('klucz wymaga zgodności PARY (isin, paperName)', () => {
    const r = applyIsinAlias('REXA.WA', 'inna-nazwa');
    expect(r.aliasApplied).toBe(false);
  });

  it('REXA→REX: data w oknie → alias (obie formy przestrzeni kluczy)', () => {
    expect(applyIsinAlias('REXA.WA', 'REXA.WA', '2026-06-03').isin).toBe('REX.WA');
    expect(applyIsinAlias('REXA.PL', 'REXA.PL', '2026-06-03').isin).toBe('REX.PL');
  });

  it('REXA→REX: pełny timestamp ISO też respektuje granicę', () => {
    expect(applyIsinAlias('REXA.WA', 'REXA.WA', '2026-06-24T08:23:31').isin).toBe('REX.WA');
    expect(applyIsinAlias('REXA.WA', 'REXA.WA', '2027-01-01T00:00:00').isin).toBe('REXA.WA');
  });

  it('data po appliesUntil → bez aliasu', () => {
    const r = applyIsinAlias('REXA.WA', 'REXA.WA', '2027-03-15');
    expect(r).toEqual({ isin: 'REXA.WA', paperName: 'REXA.WA', aliasApplied: false });
  });

  it('brak daty lub data w nierozpoznanym formacie → fail-open (alias działa)', () => {
    expect(applyIsinAlias('REXA.WA', 'REXA.WA').aliasApplied).toBe(true);
    expect(applyIsinAlias('REXA.WA', 'REXA.WA', '15.03.2026').aliasApplied).toBe(true);
  });

  it('wpisy mapy mają poprawne appliesUntil (ISO YYYY-MM-DD)', () => {
    for (const e of ISIN_ALIASES_MAP) {
      if (e.appliesUntil) expect(e.appliesUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('applyIsinAlias — PROVIDENT (delisting GPW → squeeze-out LSE)', () => {
  it('kupno z 2020 (GPW) dostaje ISIN wykupu z LSE', () => {
    const r = applyIsinAlias('PROVIDENT', 'PROVIDENT', '2020-07-31T09:52:38');
    expect(r).toEqual({
      isin: 'GB00B1YKG049',
      paperName: 'PROVIDENT',
      aliasApplied: true,
    });
  });

  it('data po delistingu z GPW (appliesUntil 2021-12-31) → bez aliasu', () => {
    expect(applyIsinAlias('PROVIDENT', 'PROVIDENT', '2022-06-01').aliasApplied).toBe(false);
  });
});
