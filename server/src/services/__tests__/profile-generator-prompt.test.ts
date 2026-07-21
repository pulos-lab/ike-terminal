import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../profile-generator-prompt.js';

/**
 * Prompt systemowy generatora profili musi uczyć wzorców, których zabrakło w
 * wadliwym ręcznym profilu Trade Republic: mapowania kolumny ISIN, mapowania
 * prowizji per-transakcja i klasyfikacji wierszy gotówkowych (zamiast wrzucania
 * ich w „trade" jedną regułą-śmietnikiem). Drugi few-shot pokazuje plik wielotypowy.
 */
describe('buildSystemPrompt — wskazówki ISIN/prowizja/klasy gotówkowe', () => {
  const sys = buildSystemPrompt();

  it('nakazuje mapować kolumnę ISIN, gdy istnieje', () => {
    expect(sys).toMatch(/ISIN is the most reliable/i);
    expect(sys).toMatch(/you MUST map it/i);
  });

  it('nakazuje mapować prowizję per-transakcja', () => {
    expect(sys).toMatch(/trade\.commission/);
    expect(sys).toMatch(/silently lost/i);
  });

  it('nakazuje klasyfikować wiersze gotówkowe zamiast wrzucać w trade', () => {
    expect(sys).toMatch(/Classify cash rows, do NOT route them into "trade"/i);
    expect(sys).toMatch(/DROPPED silently/i);
  });

  it('ostrzega przed pojedynczą regułą-śmietnikiem na zawsze-obecnej kolumnie', () => {
    expect(sys).toMatch(/single catch-all rule/i);
  });

  it('zawiera oba few-shoty: jednotypowy (Example 1) i wielotypowy operacji (Example 2)', () => {
    expect(sys).toContain('Example 1');
    expect(sys).toContain('Example 2');
    // Drugi few-shot (DEGIRO account) klasyfikuje na klasy gotówkowe i mapuje ISIN.
    expect(sys).toContain('"deposit"');
    expect(sys).toContain('"withdrawal"');
    expect(sys).toContain('"ISIN"');
  });
});
