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

describe('lintProfile — akcje korporacyjne (Faza 4)', () => {
  it('corporate-action-skipped z licznikiem, gdy reguła pomija akcję korporacyjną', () => {
    const profile = tradeProfile({
      classify: [
        {
          id: 'corp',
          when: [{ col: { name: 'strona' }, op: 'equals', values: ['SPLIT'] }],
          emit: 'skip',
          skipReason: 'corporate_action',
        },
        { id: 'trade', when: [{ col: { name: 'data' }, op: 'notEmpty' }], emit: 'trade' },
      ],
    });
    const csv =
      `${TRADE_HEADER}\n` +
      `01.03.2026 10:00:00;KGHM;PLKGHM000017;SPLIT;10;150,50;PLN\n` +
      `02.03.2026 10:00:00;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);
    const lints = lintProfile(profile, out);
    const corp = lints.find((l) => l.code === 'corporate-action-skipped');
    expect(corp?.count).toBe(1);
    // corporate_action jest łagodne → NIE podbija high-skip-rate.
    expect(lints.map((l) => l.code)).not.toContain('high-skip-rate');
  });

  it('brak lintu, gdy nic nie pominięto jako akcja korporacyjna', () => {
    const csv = `${TRADE_HEADER}\n01.03.2026 10:00:00;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    expect(lintCodes(tradeProfile(), csv)).not.toContain('corporate-action-skipped');
  });
});

// ── Strażniki kolumn nieużytych (profil „śmietnik", np. ręczny profil Trade Republic) ──
// Reprodukcja profilu 9f33f329: jedna reguła 'trade' na zawsze-obecnej kolumnie 'date',
// bez mapowania ISIN/prowizji i bez klas gotówkowych → wpłata i perk wpadają w 'trade'
// i są odrzucane (invalid_side), ISIN i prowizja są ignorowane.

const TR_HEADER = 'date,type,name,isin,shares,price,amount,fee,currency';
const TR_CSV = [
  TR_HEADER,
  '2026-07-02,DEPOSIT,Wplata,,,,100000,,PLN',
  '2026-07-06,BUY,MSCI World,IE00B4L5Y983,1.5,540.68,-811.02,-4.00,PLN',
  '2026-07-06,BUY,Micron,US5951121038,0.26,3766.00,-979.16,-4.00,PLN',
  '2026-07-06,BUY,ServiceNow,US81762P1021,2.49,400.70,-997.74,-4.00,PLN',
  '2026-07-06,BUY,Palantir,US69608A1088,10.2,488.10,-4978.62,-4.00,PLN',
  '2026-07-06,STOCKPERK,Microsoft,US5949181045,,,98.31,,PLN',
].join('\n');

/** Profil-śmietnik: wszystko klasyfikowane jako 'trade' po zawsze-obecnej kolumnie 'date'. */
function brokenTrProfile(overrides: Record<string, unknown> = {}): ImportProfile {
  return ImportProfileSchema.parse({
    specVersion: 1,
    brokerLabel: 'TR',
    file: { delimiter: ',', headerRow: { strategy: 'first' }, amountSignPolicy: 'signed' },
    classify: [{ id: 'trade', when: [{ col: { name: 'date' }, op: 'notEmpty' }], emit: 'trade' }],
    trade: {
      date: { source: { kind: 'column', col: { name: 'date' } }, formats: ['YYYY-MM-DD'] },
      paperName: { kind: 'column', col: { name: 'name' } },
      quantity: { kind: 'column', col: { name: 'shares' } },
      price: { kind: 'column', col: { name: 'price' } },
      currency: { kind: 'column', col: { name: 'currency' }, fallback: 'PLN' },
      side: { strategy: 'column', col: { name: 'type' }, buyValues: ['BUY'], sellValues: ['SELL'] },
    },
    needsNameResolution: true,
    ...overrides,
  });
}

/** Poprawny profil TR: klasy deposit/other + trade z ISIN i prowizją (mini-golden dla P0). */
function correctTrProfile(): ImportProfile {
  const dateSpec = {
    source: { kind: 'column', col: { name: 'date' } },
    formats: ['YYYY-MM-DD'],
  };
  const currency = { kind: 'column', col: { name: 'currency' }, fallback: 'PLN' };
  return ImportProfileSchema.parse({
    specVersion: 1,
    brokerLabel: 'Trade Republic',
    file: { delimiter: ',', headerRow: { strategy: 'first' }, amountSignPolicy: 'signed' },
    classify: [
      {
        id: 'deposit',
        when: [{ col: { name: 'type' }, op: 'oneOf', values: ['DEPOSIT'] }],
        emit: 'deposit',
      },
      {
        id: 'perk',
        when: [{ col: { name: 'type' }, op: 'oneOf', values: ['STOCKPERK'] }],
        emit: 'other',
      },
      {
        id: 'trade',
        when: [{ col: { name: 'type' }, op: 'oneOf', values: ['BUY', 'SELL'] }],
        emit: 'trade',
      },
    ],
    trade: {
      date: dateSpec,
      paperName: { kind: 'column', col: { name: 'name' } },
      isin: { kind: 'column', col: { name: 'isin' } },
      quantity: { kind: 'column', col: { name: 'shares' } },
      price: { kind: 'column', col: { name: 'price' } },
      commission: { kind: 'column', col: { name: 'fee' } },
      currency,
      paymentCurrency: { kind: 'const', value: 'PLN' },
      side: { strategy: 'column', col: { name: 'type' }, buyValues: ['BUY'], sellValues: ['SELL'] },
    },
    deposit: { date: dateSpec, amount: { kind: 'column', col: { name: 'amount' } }, currency },
    other: { date: dateSpec, amount: { kind: 'column', col: { name: 'amount' } }, currency },
  });
}

describe('lintProfile — kolumny nieużyte (profil „śmietnik")', () => {
  it('profil-śmietnik uruchamia wszystkie 4 strażniki', () => {
    const codes = lintCodes(brokenTrProfile(), TR_CSV);
    expect(codes).toContain('isin-column-unused');
    expect(codes).toContain('fee-column-unused');
    expect(codes).toContain('cash-rows-routed-to-trade');
    expect(codes).toContain('unaccounted-cashflow');
  });

  it('isin-column-unused znika, gdy ISIN jest zmapowany', () => {
    const p = brokenTrProfile({
      trade: { ...brokenTrProfile().trade, isin: { kind: 'column', col: { name: 'isin' } } },
      needsNameResolution: false,
    });
    expect(lintCodes(p, TR_CSV)).not.toContain('isin-column-unused');
  });

  it('fee-column-unused znika, gdy prowizja jest zmapowana', () => {
    const p = brokenTrProfile({
      trade: { ...brokenTrProfile().trade, commission: { kind: 'column', col: { name: 'fee' } } },
    });
    expect(lintCodes(p, TR_CSV)).not.toContain('fee-column-unused');
  });

  it('fee-column-unused znika, gdy total jest zmapowany (koszt już zawarty)', () => {
    const p = brokenTrProfile({
      trade: { ...brokenTrProfile().trade, total: { kind: 'column', col: { name: 'amount' } } },
    });
    expect(lintCodes(p, TR_CSV)).not.toContain('fee-column-unused');
  });

  it('cash-rows-routed-to-trade liczy odrzucone wiersze (wpłata + perk)', () => {
    const out = parseWithProfile(TR_CSV, brokenTrProfile(), BATCH);
    const lint = lintProfile(brokenTrProfile(), out).find(
      (l) => l.code === 'cash-rows-routed-to-trade',
    );
    expect(lint?.count).toBe(2);
  });

  it('unaccounted-cashflow sygnalizuje zgubioną wpłatę 100k (odsetek wysoki)', () => {
    const out = parseWithProfile(TR_CSV, brokenTrProfile(), BATCH);
    const lint = lintProfile(brokenTrProfile(), out).find((l) => l.code === 'unaccounted-cashflow');
    expect(lint).toBeDefined();
    expect(lint?.count).toBe(2);
  });

  it('poprawny profil TR nie uruchamia żadnego z 4 strażników', () => {
    const codes = lintCodes(correctTrProfile(), TR_CSV);
    expect(codes).not.toContain('isin-column-unused');
    expect(codes).not.toContain('fee-column-unused');
    expect(codes).not.toContain('cash-rows-routed-to-trade');
    expect(codes).not.toContain('unaccounted-cashflow');
  });
});
