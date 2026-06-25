import { describe, it, expect } from 'vitest';
import { ImportProfileSchema, type ImportProfile } from 'shared';
import { parseWithProfile } from '../engine.js';
import { lintProfile } from '../profile-lints.js';

/**
 * Testy lintów podglądu — każdy przypadek buduje realny profil + CSV, przepuszcza
 * przez silnik (parseWithProfile) i sprawdza, że lintProfile uwidacznia (lub nie)
 * dany „cichy" błąd. Asercje po `code`, bo treść PL może ewoluować.
 */

const BATCH = 'lint-test';
const TRADE_HEADER = 'data;papier;isin;strona;ilosc;cena;waluta';

/** Minimalny profil transakcyjny; overrides nadpisują pola najwyższego poziomu. */
function tradeProfile(overrides: Record<string, unknown> = {}): ImportProfile {
  return ImportProfileSchema.parse({
    specVersion: 1,
    brokerLabel: 'Test',
    file: { delimiter: ';', headerRow: { strategy: 'first' } },
    classify: [{ id: 'trade', when: [{ col: { name: 'data' }, op: 'notEmpty' }], emit: 'trade' }],
    trade: {
      date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['DD.MM.YYYY'] },
      paperName: { kind: 'column', col: { name: 'papier' } },
      isin: { kind: 'column', col: { name: 'isin' } },
      quantity: { kind: 'column', col: { name: 'ilosc' } },
      price: { kind: 'column', col: { name: 'cena' } },
      currency: { kind: 'column', col: { name: 'waluta' }, fallback: 'PLN' },
      side: {
        strategy: 'column',
        col: { name: 'strona' },
        buyValues: ['K'],
        sellValues: ['S'],
      },
    },
    ...overrides,
  });
}

const DIV_HEADER = 'typ;data;kwota;waluta;opis;tic';

/** Profil dywidendowy; `tickerSource` pozwala przełączać regexExtract↔column↔brak. */
function dividendProfile(tickerSource: unknown = undefined): ImportProfile {
  return ImportProfileSchema.parse({
    specVersion: 1,
    brokerLabel: 'Test',
    file: { delimiter: ';', headerRow: { strategy: 'first' } },
    classify: [
      {
        id: 'div',
        when: [{ col: { name: 'typ' }, op: 'equals', values: ['DYW'] }],
        emit: 'dividend',
      },
    ],
    dividend: {
      date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['DD.MM.YYYY'] },
      amount: { kind: 'column', col: { name: 'kwota' } },
      currency: { kind: 'column', col: { name: 'waluta' }, fallback: 'PLN' },
      ...(tickerSource ? { ticker: tickerSource } : {}),
    },
  });
}

/** Uruchom profil na CSV i zwróć kody lintów. */
function lintCodes(profile: ImportProfile, csv: string): string[] {
  const out = parseWithProfile(csv, profile, BATCH);
  return lintProfile(profile, out).map((l) => l.code);
}

describe('lintProfile — waluta rozliczenia', () => {
  it('payment-currency-assumed gdy trade nie mapuje paymentCurrency', () => {
    const csv = `${TRADE_HEADER}\n01.03.2026 10:00:00;AAPL;US0378331005;K;5;195,30;USD`;
    expect(lintCodes(tradeProfile(), csv)).toContain('payment-currency-assumed');
  });

  it('brak lintu, gdy paymentCurrency mapowane z kolumny', () => {
    const profile = tradeProfile({
      trade: {
        ...tradeProfile().trade,
        paymentCurrency: { kind: 'column', col: { name: 'waluta' } },
      },
    });
    const csv = `${TRADE_HEADER}\n01.03.2026 10:00:00;AAPL;US0378331005;K;5;195,30;USD`;
    const codes = lintCodes(profile, csv);
    expect(codes).not.toContain('payment-currency-assumed');
    expect(codes).not.toContain('payment-currency-const');
  });

  it('payment-currency-const (info), gdy zahardkodowane', () => {
    const profile = tradeProfile({
      trade: { ...tradeProfile().trade, paymentCurrency: { kind: 'const', value: 'PLN' } },
    });
    const csv = `${TRADE_HEADER}\n01.03.2026 10:00:00;AAPL;US0378331005;K;5;195,30;USD`;
    const codes = lintCodes(profile, csv);
    expect(codes).toContain('payment-currency-const');
    expect(codes).not.toContain('payment-currency-assumed');
  });
});

describe('lintProfile — ticker', () => {
  it('ticker-via-regex, gdy ticker dywidendy z regexExtract', () => {
    const profile = dividendProfile({
      kind: 'regexExtract',
      col: { name: 'opis' },
      pattern: 'dywidenda (\\w+)',
      group: 1,
    });
    const csv = `${DIV_HEADER}\nDYW;01.03.2026 10:00:00;10,50;PLN;dywidenda KGHM;`;
    expect(lintCodes(profile, csv)).toContain('ticker-via-regex');
  });

  it('ticker-empty z licznikiem, gdy część dywidend bez tickera', () => {
    const profile = dividendProfile({
      kind: 'regexExtract',
      col: { name: 'opis' },
      pattern: 'dywidenda (\\w+)',
      group: 1,
    });
    const csv =
      `${DIV_HEADER}\n` +
      `DYW;01.03.2026 10:00:00;10,50;PLN;dywidenda KGHM;\n` +
      `DYW;02.03.2026 10:00:00;5,00;PLN;wyplata bez spolki;`;
    const out = parseWithProfile(csv, profile, BATCH);
    const lints = lintProfile(profile, out);
    const empty = lints.find((l) => l.code === 'ticker-empty');
    expect(empty?.count).toBe(1);
  });

  it('brak ticker-empty, gdy ticker z kolumny i zawsze obecny', () => {
    const profile = dividendProfile({ kind: 'column', col: { name: 'tic' } });
    const csv = `${DIV_HEADER}\nDYW;01.03.2026 10:00:00;10,50;PLN;dywidenda;KGHM`;
    const codes = lintCodes(profile, csv);
    expect(codes).not.toContain('ticker-empty');
    expect(codes).not.toContain('ticker-via-regex');
  });
});

describe('lintProfile — agregaty', () => {
  it('no-trade-time, gdy >50% operacji bez godziny', () => {
    const csv =
      `${TRADE_HEADER}\n` +
      `01.03.2026;KGHM;PLKGHM000017;K;10;150,50;PLN\n` +
      `02.03.2026;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    expect(lintCodes(tradeProfile(), csv)).toContain('no-trade-time');
  });

  it('brak no-trade-time, gdy daty niosą godzinę', () => {
    const csv =
      `${TRADE_HEADER}\n` +
      `01.03.2026 09:30:00;KGHM;PLKGHM000017;K;10;150,50;PLN\n` +
      `02.03.2026 14:15:00;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    expect(lintCodes(tradeProfile(), csv)).not.toContain('no-trade-time');
  });

  it('high-skip-rate, gdy wiersze odpadają (nierozpoznana strona)', () => {
    const csv =
      `${TRADE_HEADER}\n` +
      `01.03.2026 10:00:00;KGHM;PLKGHM000017;XYZ;10;150,50;PLN\n` +
      `02.03.2026 10:00:00;KGHM;PLKGHM000017;XYZ;10;150,50;PLN`;
    expect(lintCodes(tradeProfile(), csv)).toContain('high-skip-rate');
  });

  it('brak high-skip-rate przy czystym pliku', () => {
    const csv = `${TRADE_HEADER}\n01.03.2026 10:00:00;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    expect(lintCodes(tradeProfile(), csv)).not.toContain('high-skip-rate');
  });
});

describe('lintProfile — statyczne info', () => {
  it('needs-name-resolution, gdy trade bez ISIN', () => {
    const profile = tradeProfile({
      trade: {
        date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['DD.MM.YYYY'] },
        paperName: { kind: 'column', col: { name: 'papier' } },
        quantity: { kind: 'column', col: { name: 'ilosc' } },
        price: { kind: 'column', col: { name: 'cena' } },
        currency: { kind: 'column', col: { name: 'waluta' }, fallback: 'PLN' },
        side: { strategy: 'column', col: { name: 'strona' }, buyValues: ['K'], sellValues: ['S'] },
      },
      needsNameResolution: true,
    });
    const csv = `${TRADE_HEADER}\n01.03.2026 10:00:00;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    expect(lintCodes(profile, csv)).toContain('needs-name-resolution');
  });

  it('non-skip-default, gdy defaultClass ≠ skip', () => {
    const profile = tradeProfile({
      defaultClass: 'other',
      other: {
        date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['DD.MM.YYYY'] },
        amount: { kind: 'column', col: { name: 'cena' } },
        currency: { kind: 'column', col: { name: 'waluta' }, fallback: 'PLN' },
      },
    });
    const csv = `${TRADE_HEADER}\n01.03.2026 10:00:00;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    expect(lintCodes(profile, csv)).toContain('non-skip-default');
  });

  it('czysty, w pełni zmapowany profil nie produkuje ostrzeżeń', () => {
    const profile = dividendProfile({ kind: 'column', col: { name: 'tic' } });
    const csv = `${DIV_HEADER}\nDYW;01.03.2026 10:00:00;10,50;PLN;dywidenda;KGHM`;
    const out = parseWithProfile(csv, profile, BATCH);
    const warnings = lintProfile(profile, out).filter((l) => l.severity === 'warning');
    expect(warnings).toHaveLength(0);
  });
});
