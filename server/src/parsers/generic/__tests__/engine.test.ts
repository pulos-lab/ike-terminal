import { describe, it, expect } from 'vitest';
import { CategoryRulesSchema, ImportProfileSchema, type ImportProfile } from 'shared';
import { parseWithProfile } from '../engine.js';
import { GenericParseError, parseDateWithFormats } from '../value-parsers.js';

/**
 * Testy silnika generycznego — syntetyczne fixtures per element taksonomii.
 * Każdy test buduje minimalny profil + CSV i sprawdza wynik mapowania.
 */

const BATCH = 'batch-test';

/** Minimalny profil transakcyjny nad CSV: data;papier;isin;strona;ilosc;cena;waluta */
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
        buyValues: ['K', 'BUY'],
        sellValues: ['S', 'SELL'],
      },
    },
    ...overrides,
  });
}

const TRADE_HEADER = 'data;papier;isin;strona;ilosc;cena;waluta';

describe('parseWithProfile — transakcje', () => {
  it('mapuje wiersz K z wyliczonym value i total', () => {
    const csv = `${TRADE_HEADER}\n25.02.2026 09:47:27;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    const out = parseWithProfile(csv, tradeProfile(), BATCH);

    expect(out.transactions.data).toHaveLength(1);
    const tx = out.transactions.data[0];
    expect(tx).toMatchObject({
      date: '2026-02-25T09:47:27',
      paperName: 'KGHM',
      isin: 'PLKGHM000017',
      quantity: 10,
      side: 'K',
      price: 150.5,
      value: 1505,
      commission: 0,
      total: 1505,
      currency: 'PLN',
      source: 'generic',
      importBatch: BATCH,
    });
  });

  it('paymentCurrency domyślnie = waluta instrumentu, gdy profil go nie mapuje', () => {
    // Konto jednowalutowe: rozliczenie w walucie instrumentu. Jawna wartość
    // (zamiast undefined) pasuje do parserów wbudowanych i konsumentów `|| currency`.
    const csv = `${TRADE_HEADER}\n01.03.2026;AAPL;US0378331005;K;5;195,30;USD`;
    const out = parseWithProfile(csv, tradeProfile(), BATCH);
    expect(out.transactions.data[0].paymentCurrency).toBe('USD');
  });

  it('jawne paymentCurrency w profilu wygrywa z domyślnym (multi-waluta)', () => {
    const profile = tradeProfile();
    profile.trade!.paymentCurrency = { kind: 'const', value: 'PLN' };
    const csv = `${TRADE_HEADER}\n01.03.2026;AAPL;US0378331005;K;5;195,30;USD`;
    const out = parseWithProfile(csv, profile, BATCH);
    const tx = out.transactions.data[0];
    expect(tx.currency).toBe('USD');
    expect(tx.paymentCurrency).toBe('PLN');
  });

  it('strona ze znaku ilości (signedQuantity) + fractional shares', () => {
    const profile = tradeProfile();
    profile.trade!.side = { strategy: 'signedQuantity', col: { name: 'ilosc' } };
    const csv = `${TRADE_HEADER}\n01.03.2026;AAPL;US0378331005;;-0,3069;494,15;USD`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.transactions.data).toHaveLength(1);
    expect(out.transactions.data[0].side).toBe('S');
    expect(out.transactions.data[0].quantity).toBeCloseTo(0.3069);
  });

  it('GBX: cena w pensach ÷100, waluta GBP', () => {
    const csv = `${TRADE_HEADER}\n01.03.2026;RIO;GB0007188757;K;10;5512,00;GBX`;
    const out = parseWithProfile(csv, tradeProfile(), BATCH);

    const tx = out.transactions.data[0];
    expect(tx.currency).toBe('GBP');
    expect(tx.price).toBeCloseTo(55.12);
    expect(tx.value).toBeCloseTo(551.2);
  });

  it('wholeShares zaokrągla ilość do pełnych sztuk', () => {
    const profile = tradeProfile();
    profile.trade!.wholeShares = true;
    const csv = `${TRADE_HEADER}\n01.03.2026;KGHM;PLKGHM000017;K;9,9999999;150,00;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);
    expect(out.transactions.data[0].quantity).toBe(10);
  });

  it('value_mismatch: wartość z CSV odbiega od qty×cena → skip + warning', () => {
    const profile = tradeProfile();
    profile.trade!.value = { kind: 'column', col: { name: 'wartosc' } };
    const csv = `data;papier;isin;strona;ilosc;cena;waluta;wartosc\n01.03.2026;KGHM;PLKGHM000017;K;10;150,00;PLN;9999,00`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.transactions.data).toHaveLength(0);
    expect(out.transactions.skipped[0].reason).toBe('value_mismatch');
    expect(out.warnings.some((w) => w.includes('mapowanie kolumn'))).toBe(true);
  });

  it('obligacja: kurs w % nominału — bez cross-checku, kategoria bond', () => {
    const profile = tradeProfile();
    profile.trade!.value = { kind: 'column', col: { name: 'wartosc' } };
    // DS1030 (obligacja skarbowa): 23 szt × 101,78% × 1000 nominału ≈ 23 409,40
    const csv = `data;papier;isin;strona;ilosc;cena;waluta;wartosc\n01.03.2026;DS1030;PL0000111456;K;23;101,78;PLN;23409,40`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.transactions.data).toHaveLength(1);
    expect(out.transactions.data[0].category).toBe('bond');
    expect(out.transactions.data[0].value).toBeCloseTo(23409.4);
  });

  it('reguły kategorii: matcher → etf, default dla pozostałych', () => {
    const profile = tradeProfile();
    profile.trade!.category = CategoryRulesSchema.parse({
      rules: [{ when: { by: 'nameRegex', pattern: 'ETF|UCITS' }, category: 'etf' }],
      default: 'stock',
    });
    const csv = `${TRADE_HEADER}\n01.03.2026;BETA ETF WIG20;PLBETA000017;K;10;50,00;PLN\n02.03.2026;KGHM;PLKGHM000017;K;5;150,00;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.transactions.data[0].category).toBe('etf');
    expect(out.transactions.data[1].category).toBe('stock');
  });

  it('fallback waluty przy pustej komórce', () => {
    const csv = `${TRADE_HEADER}\n01.03.2026;KGHM;PLKGHM000017;K;10;150,00;`;
    const out = parseWithProfile(csv, tradeProfile(), BATCH);
    expect(out.transactions.data[0].currency).toBe('PLN');
  });

  it('nieprawidłowa strona → invalid_side; zła data → invalid_date', () => {
    const csv = `${TRADE_HEADER}\n01.03.2026;KGHM;PLKGHM000017;X;10;150,00;PLN\nnie-data;KGHM;PLKGHM000017;K;10;150,00;PLN`;
    const out = parseWithProfile(csv, tradeProfile(), BATCH);

    expect(out.transactions.data).toHaveLength(0);
    expect(out.transactions.skipped.map((s) => s.reason)).toEqual(['invalid_side', 'invalid_date']);
  });

  it('brak kolumny wymaganej przez profil → GenericParseError (PL)', () => {
    const csv = `data;papier;strona;ilosc;cena;waluta\n01.03.2026;KGHM;K;10;150,00;PLN`;
    expect(() => parseWithProfile(csv, tradeProfile(), BATCH)).toThrow(GenericParseError);
    expect(() => parseWithProfile(csv, tradeProfile(), BATCH)).toThrow(/brakuje kolumny "isin"/);
  });

  it('headerRow scan: nagłówek po preludium metadanych', () => {
    const profile = tradeProfile({
      file: {
        delimiter: ';',
        headerRow: { strategy: 'scan', signature: ['data', 'papier'], maxScanRows: 10 },
      },
    });
    const csv = `mBank eksport\nklient: 0000111122223333\n${TRADE_HEADER}\n01.03.2026;KGHM;PLKGHM000017;K;10;150,00;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);
    expect(out.transactions.data).toHaveLength(1);
  });

  it('zduplikowane nazwy nagłówków — occurrence wybiera właściwą', () => {
    const profile = tradeProfile();
    profile.trade!.currency = {
      kind: 'column',
      col: { name: 'waluta', occurrence: 1 },
      fallback: 'PLN',
    };
    const csv = `data;papier;isin;strona;ilosc;cena;waluta;waluta\n01.03.2026;AAPL;US0378331005;K;10;150,00;XXX;USD`;
    const out = parseWithProfile(csv, profile, BATCH);
    expect(out.transactions.data[0].currency).toBe('USD');
  });

  it('footerStop przerywa przetwarzanie; skipRows → summary_row', () => {
    const profile = tradeProfile({
      file: {
        delimiter: ';',
        headerRow: { strategy: 'first' },
        footerStop: [{ col: { name: 'data' }, op: 'startsWith', values: ['RAZEM'] }],
        skipRows: [[{ col: { name: 'papier' }, op: 'equals', values: ['SUMA'] }]],
      },
    });
    const csv = [
      TRADE_HEADER,
      '01.03.2026;KGHM;PLKGHM000017;K;10;150,00;PLN',
      '01.03.2026;SUMA;;;;;',
      'RAZEM;;;;;;',
      '02.03.2026;CDR;PLOPTTC00011;K;5;300,00;PLN', // za stopką — ignorowane
    ].join('\n');
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.transactions.data).toHaveLength(1);
    expect(out.operations.skipped.some((s) => s.reason === 'summary_row')).toBe(true);
  });

  it('rowTraces zawierają id reguły i podgląd pól', () => {
    const csv = `${TRADE_HEADER}\n25.02.2026;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    const out = parseWithProfile(csv, tradeProfile(), BATCH);
    const trace = out.rowTraces.find((t) => t.target === 'transaction');
    expect(trace?.matchedRuleId).toBe('trade');
    expect(trace?.preview).toMatchObject({ papier: 'KGHM', strona: 'K' });
  });
});

// ── Operacje gotówkowe ───────────────────────────────────────────────────────

const OPS_HEADER = 'data;tytul;kwota;waluta';

function opsProfile(
  classify: Array<Record<string, unknown>>,
  mappings: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ImportProfile {
  const cash = {
    date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'kwota' } },
    currency: { kind: 'column', col: { name: 'waluta' }, fallback: 'PLN' },
    description: { kind: 'column', col: { name: 'tytul' } },
  };
  return ImportProfileSchema.parse({
    specVersion: 1,
    brokerLabel: 'Test',
    file: { delimiter: ';', headerRow: { strategy: 'first' } },
    classify,
    ...Object.fromEntries(Object.entries(mappings).map(([k, v]) => [k, v === true ? cash : v])),
    ...extra,
  });
}

describe('parseWithProfile — operacje gotówkowe', () => {
  it('deposit z ujemną kwotą → withdrawal + warning (znak nigdy nie jest odwracany)', () => {
    const profile = opsProfile(
      [
        {
          id: 'dep',
          when: [{ col: { name: 'tytul' }, op: 'contains', values: ['Przelew'] }],
          emit: 'deposit',
        },
      ],
      { deposit: true },
    );
    const csv = `${OPS_HEADER}\n2026-01-10;Przelew zwrotny;-200,00;PLN\n2026-01-11;Przelew do DM;500,00;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.operations.data).toHaveLength(2);
    expect(out.operations.data[0]).toMatchObject({ operationType: 'withdrawal', amount: -200 });
    expect(out.operations.data[1]).toMatchObject({ operationType: 'deposit', amount: 500 });
    expect(out.warnings.some((w) => w.includes('ujemną kwotą'))).toBe(true);
  });

  it('coupon → dividend + subkind coupon; interest → other + subkind interest', () => {
    const profile = opsProfile(
      [
        {
          id: 'kupon',
          when: [{ col: { name: 'tytul' }, op: 'startsWith', values: ['Wypłata kuponu'] }],
          emit: 'coupon',
        },
        {
          id: 'odsetki',
          when: [{ col: { name: 'tytul' }, op: 'startsWith', values: ['Odsetki'] }],
          emit: 'interest',
        },
      ],
      { coupon: true, interest: true },
    );
    const csv = `${OPS_HEADER}\n2026-01-10;Wypłata kuponu DS1030;21,70;PLN\n2026-01-11;Odsetki od środków;3,50;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.operations.data[0]).toMatchObject({
      operationType: 'dividend',
      subkind: 'coupon',
      amount: 21.7,
    });
    expect(out.operations.data[1]).toMatchObject({ operationType: 'other', subkind: 'interest' });
  });

  it('kwota zerowa → skip zero_amount', () => {
    const profile = opsProfile(
      [{ id: 'dep', when: [{ col: { name: 'tytul' }, op: 'notEmpty' }], emit: 'deposit' }],
      { deposit: true },
    );
    const csv = `${OPS_HEADER}\n2026-01-10;Przelew;0,00;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);
    expect(out.operations.data).toHaveLength(0);
    expect(out.operations.skipped[0].reason).toBe('zero_amount');
  });

  it('defaultClass=skip → unknown_operation_type (wiersz widoczny w podglądzie)', () => {
    const profile = opsProfile(
      [
        {
          id: 'dep',
          when: [{ col: { name: 'tytul' }, op: 'equals', values: ['Przelew'] }],
          emit: 'deposit',
        },
      ],
      { deposit: true },
    );
    const csv = `${OPS_HEADER}\n2026-01-10;Egzotyczna operacja;10,00;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);
    expect(out.operations.skipped[0].reason).toBe('unknown_operation_type');
  });

  it('unknown_operation_type niesie raw (kolumna typu z reguł classify) do skrzynki "Do wyjaśnienia"', () => {
    const profile = opsProfile(
      [
        {
          id: 'dep',
          when: [{ col: { name: 'tytul' }, op: 'equals', values: ['Przelew'] }],
          emit: 'deposit',
        },
      ],
      { deposit: true },
    );
    const csv = `${OPS_HEADER}\n2026-01-10;Egzotyczna operacja;10,00;PLN\n2026-01-11;Przelew;5,00;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);

    const unknown = out.operations.skipped.find((s) => s.reason === 'unknown_operation_type');
    // rawType = wartość najczęściej matchowanej kolumny classify (tu: 'tytul')
    expect(unknown?.raw?.rawType).toBe('egzotyczna operacja');
    expect(unknown?.raw?.headers).toEqual(['data', 'tytul', 'kwota', 'waluta']);
    expect(unknown?.raw?.cells).toEqual(['2026-01-10', 'Egzotyczna operacja', '10,00', 'PLN']);

    // Wiersz rozpoznany regułą NIE dostaje raw
    expect(out.operations.data).toHaveLength(1);
  });
});

describe('parseWithProfile — parowanie dywidenda ↔ WHT', () => {
  const classify = [
    {
      id: 'div',
      when: [{ col: { name: 'tytul' }, op: 'equals', values: ['Dywidenda'] }],
      emit: 'dividend',
    },
    {
      id: 'wht',
      when: [{ col: { name: 'tytul' }, op: 'equals', values: ['Podatek'] }],
      emit: 'withholding_tax',
    },
  ];
  const HEADER = 'data;tytul;ticker;kwota;waluta';
  const cashWithTicker = {
    date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'kwota' } },
    currency: { kind: 'column', col: { name: 'waluta' }, fallback: 'PLN' },
    description: { kind: 'column', col: { name: 'ticker' } },
    ticker: { kind: 'column', col: { name: 'ticker' } },
  };

  it('subtract: netto + dopisek "(podatek X%)"', () => {
    const profile = opsProfile(
      classify,
      { dividend: cashWithTicker, withholdingTax: cashWithTicker },
      {
        pairing: {
          dividendWht: { matchBy: ['ticker', 'date'], windowDays: 0, handling: 'subtract' },
        },
      },
    );
    const csv = `${HEADER}\n2026-01-10;Dywidenda;AAPL;10,00;USD\n2026-01-10;Podatek;AAPL;-1,50;USD`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.operations.data).toHaveLength(1);
    expect(out.operations.data[0]).toMatchObject({
      operationType: 'dividend',
      amount: 8.5,
      description: 'AAPL (podatek 15%)',
      ticker: 'AAPL',
    });
  });

  it('fee_row: dywidenda brutto + podatek jako osobny fee', () => {
    const profile = opsProfile(
      classify,
      { dividend: cashWithTicker, withholdingTax: cashWithTicker },
      {
        pairing: {
          dividendWht: { matchBy: ['ticker', 'date'], windowDays: 0, handling: 'fee_row' },
        },
      },
    );
    const csv = `${HEADER}\n2026-01-10;Dywidenda;AAPL;10,00;USD\n2026-01-10;Podatek;AAPL;-1,50;USD`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.operations.data).toHaveLength(2);
    expect(out.operations.data[0]).toMatchObject({ operationType: 'dividend', amount: 10 });
    expect(out.operations.data[1]).toMatchObject({ operationType: 'fee', amount: -1.5 });
  });

  it('niesparowany WHT → fee + warning (nic nie ginie)', () => {
    const profile = opsProfile(
      classify,
      { dividend: cashWithTicker, withholdingTax: cashWithTicker },
      {
        pairing: {
          dividendWht: { matchBy: ['ticker', 'date'], windowDays: 0, handling: 'subtract' },
        },
      },
    );
    const csv = `${HEADER}\n2026-01-10;Podatek;MSFT;-2,00;USD`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.operations.data[0]).toMatchObject({ operationType: 'fee', amount: -2 });
    expect(out.warnings.some((w) => w.includes('bez pasującej dywidendy'))).toBe(true);
  });

  it('okno dni: podatek dzień później paruje przy windowDays=2', () => {
    const profile = opsProfile(
      classify,
      { dividend: cashWithTicker, withholdingTax: cashWithTicker },
      {
        pairing: {
          dividendWht: { matchBy: ['ticker', 'date'], windowDays: 2, handling: 'subtract' },
        },
      },
    );
    const csv = `${HEADER}\n2026-01-10;Dywidenda;AAPL;10,00;USD\n2026-01-11;Podatek;AAPL;-1,50;USD`;
    const out = parseWithProfile(csv, profile, BATCH);
    expect(out.operations.data).toHaveLength(1);
    expect(out.operations.data[0].amount).toBeCloseTo(8.5);
  });
});

describe('parseWithProfile — wymiany walutowe', () => {
  const HEADER = 'data;czas;opis;kurs;waluta;kwota;orderid';
  const fxCash = {
    date: {
      source: { kind: 'column', col: { name: 'data' } },
      formats: ['YYYY-MM-DD'],
      timeSource: { kind: 'column', col: { name: 'czas' } },
    },
    amount: { kind: 'column', col: { name: 'kwota' } },
    currency: { kind: 'column', col: { name: 'waluta' } },
    description: { kind: 'column', col: { name: 'opis' } },
  };
  const classify = [
    {
      id: 'fx',
      when: [{ col: { name: 'opis' }, op: 'startsWith', values: ['FX'] }],
      emit: 'fx_leg',
    },
  ];

  it('parowanie po kolumnie klucza: 2 operacje fx_exchange z kursem i parą', () => {
    const profile = opsProfile(
      classify,
      { fxLeg: fxCash },
      {
        pairing: {
          fxLegs: {
            pairKey: { by: 'column', col: { name: 'orderid' } },
            rateSource: { kind: 'column', col: { name: 'kurs' } },
          },
        },
      },
    );
    const csv = `${HEADER}\n2026-01-10;10:00;FX Withdrawal;4,3127;PLN;-431,27;ord-1\n2026-01-10;10:00;FX Credit;4,3127;EUR;100,00;ord-1`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.operations.data).toHaveLength(2);
    expect(out.operations.data[0]).toMatchObject({
      operationType: 'fx_exchange',
      amount: -431.27,
      currency: 'PLN',
      fxRate: 4.3127,
      fxPair: 'PLN/EUR',
      description: 'Wymiana PLN/EUR',
    });
    expect(out.operations.data[1]).toMatchObject({ amount: 100, currency: 'EUR' });
  });

  it('niesparowana noga → import samodzielny + warning', () => {
    const profile = opsProfile(
      classify,
      { fxLeg: fxCash },
      {
        pairing: { fxLegs: { pairKey: { by: 'datetime' } } },
      },
    );
    const csv = `${HEADER}\n2026-01-10;10:00;FX Credit;;USD;355,00;`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.operations.data).toHaveLength(1);
    expect(out.operations.data[0]).toMatchObject({
      operationType: 'fx_exchange',
      amount: 355,
      description: 'FX Credit USD',
    });
    expect(out.warnings.some((w) => w.includes('niesparowana noga'))).toBe(true);
  });

  it('jednowierszowe FX (bez pairing): kurs i para z regexExtract — wzorzec Bossa', () => {
    const HEADER_BOSSA = 'data;tytul;kwota;waluta';
    const profile = opsProfile(
      [
        {
          id: 'fx',
          when: [{ col: { name: 'tytul' }, op: 'startsWith', values: ['Wymiana waluty'] }],
          emit: 'fx_leg',
        },
      ],
      {
        fxLeg: {
          date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['YYYY-MM-DD'] },
          amount: { kind: 'column', col: { name: 'kwota' } },
          currency: { kind: 'column', col: { name: 'waluta' }, fallback: 'PLN' },
          description: { kind: 'column', col: { name: 'tytul' } },
          fxRate: {
            kind: 'regexExtract',
            col: { name: 'tytul' },
            pattern: 'Wymiana waluty \\w+/\\w+ ([\\d.]+)',
            group: 1,
          },
          fxPair: {
            kind: 'regexExtract',
            col: { name: 'tytul' },
            pattern: 'Wymiana waluty (\\w+/\\w+)',
            group: 1,
          },
        },
      },
    );
    const csv = `${HEADER_BOSSA}\n2026-02-17;Wymiana waluty PLN/USD 3.5713;-5871,00;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);

    expect(out.operations.data).toHaveLength(1);
    expect(out.operations.data[0]).toMatchObject({
      operationType: 'fx_exchange',
      amount: -5871,
      currency: 'PLN',
      fxRate: 3.5713,
      fxPair: 'PLN/USD',
    });
  });
});

describe('parseWithProfile — P2a: amountSignPolicy', () => {
  const classify = [
    {
      id: 'wyp',
      when: [{ col: { name: 'tytul' }, op: 'contains', values: ['Wypłata'] }],
      emit: 'withdrawal',
    },
    {
      id: 'wpl',
      when: [{ col: { name: 'tytul' }, op: 'contains', values: ['Wpłata'] }],
      emit: 'deposit',
    },
    {
      id: 'opl',
      when: [{ col: { name: 'tytul' }, op: 'contains', values: ['Opłata'] }],
      emit: 'fee',
    },
  ];
  // Plik z magnitudami (wypłata dodatnia) ALE z JEDNĄ ujemną opłatą — pod 'auto'
  // ta ujemna przełącza heurystykę w tryb signed i reklasyfikuje wypłatę na wpłatę.
  const csv = `${OPS_HEADER}\n2026-01-10;Wypłata środków;500,00;PLN\n2026-01-11;Wpłata środków;200,00;PLN\n2026-01-12;Opłata za prowadzenie;-10,00;PLN`;
  const fileWith = (amountSignPolicy: string) => ({
    file: { delimiter: ';', headerRow: { strategy: 'first' }, amountSignPolicy },
  });

  it("'magnitude' — dodatnia wypłata zostaje wypłatą (znak z etykiety, bez reklasyfikacji)", () => {
    const profile = opsProfile(
      classify,
      { withdrawal: true, deposit: true, fee: true },
      fileWith('magnitude'),
    );
    const out = parseWithProfile(csv, profile, BATCH);
    const byType = Object.fromEntries(out.operations.data.map((o) => [o.operationType, o]));
    expect(byType.withdrawal).toMatchObject({ amount: -500 });
    expect(byType.deposit).toMatchObject({ amount: 200 });
    expect(out.warnings.some((w) => w.includes('dodatnią kwotą'))).toBe(false);
  });

  it("'auto' (domyślnie) — jedna ujemna kwota reklasyfikuje dodatnią wypłatę (stara pułapka)", () => {
    const profile = opsProfile(classify, { withdrawal: true, deposit: true, fee: true });
    const out = parseWithProfile(csv, profile, BATCH);
    expect(out.operations.data.filter((o) => o.operationType === 'deposit')).toHaveLength(2);
    expect(out.warnings.some((w) => w.includes('dodatnią kwotą'))).toBe(true);
  });

  it("'signed' — wymusza tryb ze znakiem nawet przy samych dodatnich kwotach", () => {
    const allPositive = `${OPS_HEADER}\n2026-01-10;Wypłata środków;500,00;PLN`;
    const profile = opsProfile(
      classify,
      { withdrawal: true, deposit: true, fee: true },
      fileWith('signed'),
    );
    const out = parseWithProfile(allPositive, profile, BATCH);
    expect(out.operations.data[0].operationType).toBe('deposit'); // +500 pod signed = wpływ
    expect(out.warnings.some((w) => w.includes('dodatnią kwotą'))).toBe(true);
  });
});

describe('parseWithProfile — P2b: decimalSeparator', () => {
  it("pinowany ',' — '1.234' = 1234 (kropka = tysiące), '1.234,5' = 1234.5", () => {
    const profile = tradeProfile({
      file: { delimiter: ';', headerRow: { strategy: 'first' }, decimalSeparator: ',' },
    });
    const csv = `${TRADE_HEADER}\n01.03.2026;KGHM;PLKGHM000017;K;1.234;1.234,5;PLN`;
    const tx = parseWithProfile(csv, profile, BATCH).transactions.data[0];
    expect(tx.quantity).toBe(1234);
    expect(tx.price).toBeCloseTo(1234.5);
  });

  it("pinowany '.' — '1,234' = 1234 (przecinek = tysiące), '12.5' = 12.5", () => {
    const profile = tradeProfile({
      file: { delimiter: ';', headerRow: { strategy: 'first' }, decimalSeparator: '.' },
    });
    const csv = `${TRADE_HEADER}\n01.03.2026;KGHM;PLKGHM000017;K;1,234;12.5;PLN`;
    const tx = parseWithProfile(csv, profile, BATCH).transactions.data[0];
    expect(tx.quantity).toBe(1234);
    expect(tx.price).toBeCloseTo(12.5);
  });

  it('brak deklaracji — auto-detekcja jak dotąd (parseNumber)', () => {
    const csv = `${TRADE_HEADER}\n01.03.2026;KGHM;PLKGHM000017;K;10;150,50;PLN`;
    const tx = parseWithProfile(csv, tradeProfile(), BATCH).transactions.data[0];
    expect(tx.price).toBeCloseTo(150.5);
  });
});

describe('parseDateWithFormats', () => {
  it('obsługuje wszystkie formaty enum + sufiks czasu', () => {
    expect(parseDateWithFormats('2026-02-25', ['YYYY-MM-DD'])).toBe('2026-02-25T00:00:00');
    expect(parseDateWithFormats('25.02.2026 09:47:27', ['DD.MM.YYYY'])).toBe('2026-02-25T09:47:27');
    expect(parseDateWithFormats('25-02-2026', ['DD-MM-YYYY'], '09:47')).toBe('2026-02-25T09:47:00');
    expect(parseDateWithFormats('02/25/2026', ['MM/DD/YYYY'])).toBe('2026-02-25T00:00:00');
    expect(parseDateWithFormats('25/02/2026', ['DD/MM/YYYY'])).toBe('2026-02-25T00:00:00');
  });

  it('odrzuca nieprawidłowe daty (miesiąc 13)', () => {
    expect(parseDateWithFormats('25.13.2026', ['DD.MM.YYYY'])).toBeNull();
  });

  it('pierwszy pasujący format wygrywa', () => {
    expect(parseDateWithFormats('05/02/2026', ['DD/MM/YYYY', 'MM/DD/YYYY'])).toBe(
      '2026-02-05T00:00:00',
    );
  });

  it('P2c: rok 2-cyfrowy z pivotem (00–69 → 20xx, 70–99 → 19xx)', () => {
    expect(parseDateWithFormats('05.03.24', ['DD.MM.YY'])).toBe('2024-03-05T00:00:00');
    expect(parseDateWithFormats('05/03/85', ['DD/MM/YY'])).toBe('1985-03-05T00:00:00');
    // 4-cyfrowy rok nie wpada w format 2-cyfrowy (brak fałszywego dopasowania).
    expect(parseDateWithFormats('05.03.2024', ['DD.MM.YY'])).toBeNull();
  });

  it('P2c: nazwy miesięcy EN i PL (skrót, pełna, MDY z przecinkiem)', () => {
    expect(parseDateWithFormats('01-Jan-2024', ['DD-MMM-YYYY'])).toBe('2024-01-01T00:00:00');
    expect(parseDateWithFormats('5 January 2024', ['DD MMM YYYY'])).toBe('2024-01-05T00:00:00');
    expect(parseDateWithFormats('Mar 3, 2024', ['MMM DD, YYYY'])).toBe('2024-03-03T00:00:00');
    expect(parseDateWithFormats('15 stycznia 2024', ['DD MMM YYYY'])).toBe('2024-01-15T00:00:00');
  });

  it('P2c: nieznana nazwa miesiąca → null', () => {
    expect(parseDateWithFormats('5 Foo 2024', ['DD MMM YYYY'])).toBeNull();
  });
});

// ── quoteCurrencyFromSettlement + pairing.tradeClosePl (wzorzec XTB) ─────────

const QCS_HEADER = 'typ;data;papier;ilosc;cena;kwota';

function qcsProfile(overrides: Record<string, unknown> = {}): ImportProfile {
  return ImportProfileSchema.parse({
    specVersion: 1,
    brokerLabel: 'Test-XTB-like',
    file: { delimiter: ';', headerRow: { strategy: 'first' } },
    classify: [
      {
        id: 'closepl',
        when: [{ col: { name: 'typ' }, op: 'equals', values: ['closepl'] }],
        emit: 'trade_close_pl',
      },
      {
        id: 'trade',
        when: [{ col: { name: 'typ' }, op: 'oneOf', values: ['K', 'S'] }],
        emit: 'trade',
      },
    ],
    defaultClass: 'skip',
    trade: {
      date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['DD.MM.YYYY'] },
      paperName: { kind: 'column', col: { name: 'papier' } },
      quantity: { kind: 'column', col: { name: 'ilosc' } },
      price: { kind: 'column', col: { name: 'cena' } },
      currency: { kind: 'const', value: 'PLN' },
      paymentCurrency: { kind: 'const', value: 'PLN' },
      quoteCurrencyFromSettlement: {
        settlementAmount: { kind: 'column', col: { name: 'kwota' } },
        tolerance: 0.02,
        suffixCurrency: { US: 'USD', PL: 'PLN' },
        suffixFallback: 'USD',
        unlabeledFallback: 'convertToSettlement',
      },
      side: {
        strategy: 'column',
        col: { name: 'typ' },
        buyValues: ['K'],
        sellValues: ['S'],
      },
    },
    pairing: {
      tradeClosePl: {
        amount: { kind: 'column', col: { name: 'kwota' } },
        matchBy: ['ticker', 'date', 'time'],
      },
    },
    needsNameResolution: true,
    ...overrides,
  });
}

describe('parseWithProfile — quoteCurrencyFromSettlement', () => {
  it('kupno FX: |kwota|/(qty×cena) ≉ 1 → waluta z sufiksu + fxRate, cena bez zmian', () => {
    const csv = `${QCS_HEADER}\nK;05.03.2024 10:00:00;PLTR.US;10;20,00;-740,00`;
    const out = parseWithProfile(csv, qcsProfile(), BATCH);
    const tx = out.transactions.data[0];
    expect(tx.currency).toBe('USD');
    expect(tx.paymentCurrency).toBe('PLN');
    expect(tx.price).toBe(20);
    expect(tx.value).toBe(200);
    expect(tx.fxRate).toBeCloseTo(3.7, 6);
  });

  it('kupno ratio ≈ 1 → mapowanie currency profilu bez zmian, bez fxRate', () => {
    const csv = `${QCS_HEADER}\nK;05.03.2024 10:00:00;CDR.PL;10;100,00;-1000,00`;
    const out = parseWithProfile(csv, qcsProfile(), BATCH);
    const tx = out.transactions.data[0];
    expect(tx.currency).toBe('PLN');
    expect(tx.fxRate).toBeUndefined();
  });

  it('sprzedaż + trade_close_pl: kurs z (|kwota| + P/L)/(qty×cena); wiersz P/L może być PO sprzedaży', () => {
    // Pre-pass zbiera wiersze P/L niezależnie od kolejności w pliku.
    const csv = [
      QCS_HEADER,
      'S;05.03.2024 10:00:00;PLTR.US;10;30,00;740,00',
      'closepl;05.03.2024 10:00:00;PLTR.US;;;460,00',
    ].join('\n');
    const out = parseWithProfile(csv, qcsProfile(), BATCH);
    expect(out.transactions.data).toHaveLength(1);
    const tx = out.transactions.data[0];
    expect(tx.side).toBe('S');
    expect(tx.currency).toBe('USD');
    // (740 + 460) / (10×30) = 4.0
    expect(tx.fxRate).toBeCloseTo(4.0, 5);
    // Wiersze closepl skonsumowane — nie emitują operacji ani skipów.
    expect(out.operations.data).toHaveLength(0);
  });

  it('partial fille w tej samej sekundzie: każda sprzedaż konsumuje WŁASNY wiersz P/L (FIFO)', () => {
    // Dwa partial fille pod wspólnym kluczem (symbol|data|czas), każdy z własnym
    // P/L. Sumowanie pod kluczem wliczałoby obu sprzedażom łączny P/L
    // ((740+2120)/300 ≈ 9.53 dla obu); FIFO daje 4.0 i 8.0.
    const csv = [
      QCS_HEADER,
      'closepl;05.03.2024 10:00:00;PLTR.US;;;460,00',
      'closepl;05.03.2024 10:00:00;PLTR.US;;;1660,00',
      'S;05.03.2024 10:00:00;PLTR.US;10;30,00;740,00',
      'S;05.03.2024 10:00:00;PLTR.US;10;30,00;740,00',
    ].join('\n');
    const out = parseWithProfile(csv, qcsProfile(), BATCH);
    const sells = out.transactions.data.filter((t) => t.side === 'S');
    expect(sells).toHaveLength(2);
    expect(sells[0].fxRate).toBeCloseTo((740 + 460) / 300, 5); // 4.0
    expect(sells[1].fxRate).toBeCloseTo((740 + 1660) / 300, 5); // 8.0
  });

  it('sprzedaż bez sparowanego P/L dziedziczy etykietę z kupna, bez fxRate (plik ze starą semantyką)', () => {
    const csv = [
      QCS_HEADER,
      'K;01.03.2024 10:00:00;PLTR.US;10;16,00;-608,00', // ratio 3.8 → FX
      // Obcy wiersz P/L → plik MA wiersze closepl (Amount sprzedaży = nominał)
      'closepl;02.03.2024 10:00:00;INNY.US;;;10,00',
      'S;05.03.2024 10:00:00;PLTR.US;10;26,00;608,00', // nominał, brak closepl dla tej sprzedaży
    ].join('\n');
    const out = parseWithProfile(csv, qcsProfile(), BATCH);
    const sell = out.transactions.data.find((t) => t.side === 'S')!;
    expect(sell.currency).toBe('USD');
    expect(sell.fxRate).toBeUndefined();
  });

  it('plik bez ŻADNYCH wierszy closepl: Amount sprzedaży = pełna wartość → kurs wprost', () => {
    const csv = [
      QCS_HEADER,
      'S;05.03.2024 10:00:00;PLTR.US;15;4,00;252,04', // USDPLN ≈ 4.2007
    ].join('\n');
    const out = parseWithProfile(csv, qcsProfile(), BATCH);
    const sell = out.transactions.data[0];
    expect(sell.currency).toBe('USD');
    expect(sell.fxRate).toBeCloseTo(252.04 / 60, 4);
  });

  it('saleAmountIsFullValue: kurs sprzedaży wprost MIMO obecnych wierszy closepl (szablon z Tickerem)', () => {
    // Nowy szablon XTB emituje closepl wyłącznie dla CFD — flaga profilu wyłącza
    // starą semantykę "Amount = nominał otwarcia" (lustro parsera wbudowanego).
    const csv = [
      QCS_HEADER,
      'closepl;02.03.2024 10:00:00;INNY.US;;;10,00', // CFD-owy wiersz P/L
      'S;05.03.2024 10:00:00;PLTR.US;10;30,00;1200,00', // pełna wartość → kurs 4.0
    ].join('\n');
    const profile = qcsProfile();
    profile.trade!.quoteCurrencyFromSettlement!.saleAmountIsFullValue = true;
    const out = parseWithProfile(csv, profile, BATCH);
    const sell = out.transactions.data.find((t) => t.side === 'S')!;
    expect(sell.currency).toBe('USD');
    expect(sell.fxRate).toBeCloseTo(4.0, 5);
  });

  it('symbol bez etykiety (nazwa spółki) + FX → cena przeliczona na walutę konta', () => {
    const csv = `${QCS_HEADER}\nK;05.03.2024 10:00:00;Firma Zagraniczna;10;45,73;-1830,00`;
    const out = parseWithProfile(csv, qcsProfile(), BATCH);
    const tx = out.transactions.data[0];
    expect(tx.currency).toBe('PLN');
    expect(tx.fxRate).toBeUndefined();
    expect(tx.price).toBeCloseTo(183, 5);
    expect(tx.value).toBeCloseTo(1830, 2);
  });

  it('symbolCurrency (mapa dokładnego symbolu) wygrywa nad fallbackiem', () => {
    const profile = qcsProfile();
    profile.trade!.quoteCurrencyFromSettlement!.symbolCurrency = {
      'Firma Zagraniczna': 'USD',
    };
    const csv = `${QCS_HEADER}\nK;05.03.2024 10:00:00;Firma Zagraniczna;10;45,73;-1830,00`;
    const out = parseWithProfile(csv, qcsProfile({ trade: profile.trade }), BATCH);
    const tx = out.transactions.data[0];
    expect(tx.currency).toBe('USD');
    expect(tx.price).toBeCloseTo(45.73, 2);
    expect(tx.fxRate).toBeCloseTo(4.001749, 5);
  });

  it('nazwa z kropką ("ABC S.A.") nie wpada w fallback sufiksu — przeliczenie na walutę konta', () => {
    const csv = `${QCS_HEADER}\nK;05.03.2024 10:00:00;ABC S.A.;10;45,73;-1830,00`;
    const out = parseWithProfile(csv, qcsProfile(), BATCH);
    const tx = out.transactions.data[0];
    expect(tx.currency).toBe('PLN');
    expect(tx.price).toBeCloseTo(183, 5);
  });

  it('zod: trade_close_pl w klasyfikacji bez pairing.tradeClosePl → błąd walidacji', () => {
    expect(() => qcsProfile({ pairing: {} })).toThrow();
  });

  it('zod: tolerance > 0.2 odrzucona', () => {
    const p = qcsProfile();
    expect(() =>
      ImportProfileSchema.parse({
        ...p,
        trade: {
          ...p.trade,
          quoteCurrencyFromSettlement: {
            ...p.trade!.quoteCurrencyFromSettlement,
            tolerance: 0.5,
          },
        },
      }),
    ).toThrow();
  });

  it('fxRateDirection quotePerPayment: kurs kolumnowy odwrócony do payment-per-quote', () => {
    const profile = tradeProfile();
    profile.trade!.paymentCurrency = { kind: 'const', value: 'EUR' };
    profile.trade!.fxRate = { kind: 'const', value: '4,3127' };
    profile.trade!.fxRateDirection = 'quotePerPayment';
    const csv = `${TRADE_HEADER}\n01.03.2026;MLSYSTEM;PLMLSTM00015;K;70;43,70;PLN`;
    const out = parseWithProfile(csv, profile, BATCH);
    const tx = out.transactions.data[0];
    expect(tx.fxRate).toBeCloseTo(1 / 4.3127, 8);
    expect(tx.total * tx.fxRate!).toBeCloseTo(709.3, 1);
  });
});
