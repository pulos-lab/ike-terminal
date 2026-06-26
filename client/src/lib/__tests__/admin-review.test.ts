import { describe, it, expect } from 'vitest';
import type { ImportProfile, RowTrace } from 'shared';
import {
  appendClassifyRule,
  buildClassBreakdown,
  buildMappingTables,
  buildSkipGroups,
  inferDiscriminatorCol,
  mappedClasses,
  unhandledDiscriminatorValues,
} from '../admin-review';

const HEADERS = [
  'Action',
  'Time',
  'ISIN',
  'Ticker',
  'Name',
  'No. of shares',
  'Price / share',
  'Currency (Price / share)',
  'Total',
];

const SAMPLE = [
  [
    'Market buy',
    '2023-12-18 14:30',
    'US17275R1023',
    'CSCO',
    'Cisco',
    '0.3069000000',
    '49.96',
    'USD',
    '15.33',
  ],
  [
    'Dividend (Dividend)',
    '2023-12-27',
    'US56035L1044',
    'MAIN',
    'Main Street',
    '0.5',
    '',
    'USD',
    '0.23',
  ],
  ['Card debit', '2023-12-30', '', '', '', '', '', '', '12.00'],
];

const PROFILE = {
  specVersion: 1,
  brokerLabel: 'T212',
  file: { delimiter: ',', headerRow: { strategy: 'first' } },
  classify: [
    {
      id: 'buy',
      when: [{ col: { name: 'Action' }, op: 'equals', values: ['Market buy'] }],
      emit: 'trade',
    },
    {
      id: 'div',
      when: [{ col: { name: 'Action' }, op: 'startsWith', values: ['Dividend'] }],
      emit: 'dividend',
    },
  ],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
    paperName: { kind: 'column', col: { name: 'Name' } },
    isin: { kind: 'column', col: { name: 'ISIN' } },
    quantity: { kind: 'column', col: { name: 'No. of shares' } },
    price: { kind: 'column', col: { name: 'Price / share' } },
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
    currency: { kind: 'const', value: 'EUR' },
    ticker: { kind: 'column', col: { name: 'Ticker' } },
  },
} as unknown as ImportProfile;

const TRACES: RowTrace[] = [
  { row: 1, matchedRuleId: 'buy', emitted: 'trade', target: 'transaction' },
  { row: 2, matchedRuleId: 'div', emitted: 'dividend', target: 'operation' },
  { row: 3, matchedRuleId: null, emitted: 'skip', skipReason: 'unknown_operation_type' },
];

describe('admin-review — buildClassBreakdown', () => {
  it('grupuje rowTraces po emitted z licznikiem i targetem', () => {
    const b = buildClassBreakdown(TRACES);
    expect(b.find((x) => x.emitted === 'trade')).toMatchObject({ count: 1, target: 'transaction' });
    expect(b.find((x) => x.emitted === 'dividend')).toMatchObject({
      count: 1,
      target: 'operation',
    });
    expect(b.find((x) => x.emitted === 'skip')).toMatchObject({ count: 1, target: 'skip' });
    expect(b.find((x) => x.emitted === 'trade')!.label).toBe('Transakcja (K/S)');
  });
});

describe('admin-review — buildMappingTables', () => {
  const tables = buildMappingTables(PROFILE, HEADERS, SAMPLE, TRACES);

  it('buduje tabelę per klasa obecna w dry-run (trade + dividend)', () => {
    expect(tables.map((t) => t.emitted).sort()).toEqual(['dividend', 'trade']);
  });

  it('ilość: źródło = właściwa kolumna, przykład = ułamek, status ok', () => {
    const trade = tables.find((t) => t.emitted === 'trade')!;
    const qty = trade.fields.find((f) => f.field === 'Ilość')!;
    expect(qty.source).toContain('No. of shares');
    expect(qty.examples).toContain('0.3069000000');
    expect(qty.status).toBe('ok');
  });

  it('waluta dywidendy ze stałej → status ok, przykład = wartość stałej', () => {
    const div = tables.find((t) => t.emitted === 'dividend')!;
    const cur = div.fields.find((f) => f.field === 'Waluta')!;
    expect(cur.source).toContain('EUR');
    expect(cur.status).toBe('ok');
  });

  it('zredagowana wartość (***) w przykładach → status uncertain', () => {
    const redacted = [
      ['Market buy', '2023-12-18', 'US1', 'CSCO', 'Cisco', '0.***', '49.96', 'USD', '15'],
    ];
    const t = buildMappingTables(PROFILE, HEADERS, redacted, [
      { row: 1, matchedRuleId: 'buy', emitted: 'trade', target: 'transaction' },
    ]);
    const qty = t[0].fields.find((f) => f.field === 'Ilość')!;
    expect(qty.status).toBe('uncertain');
  });

  it('brak wymaganego pola w mapowaniu → status missing', () => {
    const noCurrency = JSON.parse(JSON.stringify(PROFILE));
    delete noCurrency.trade.currency;
    const t = buildMappingTables(noCurrency as ImportProfile, HEADERS, SAMPLE, TRACES);
    const cur = t.find((x) => x.emitted === 'trade')!.fields.find((f) => f.field === 'Waluta')!;
    expect(cur.status).toBe('missing');
  });

  it('przykłady pól pochodzą z wierszy DANEJ klasy, nie z całej próbki', () => {
    // SAMPLE[0]=trade (Cisco), SAMPLE[1]=dividend (Main Street). Kolumna „Name"
    // ma obie wartości — ale tabela trade musi pokazać tylko wiersz trade.
    const trade = tables.find((t) => t.emitted === 'trade')!;
    expect(trade.fields.find((f) => f.field === 'Nazwa')!.examples).toEqual(['Cisco']);

    const div = tables.find((t) => t.emitted === 'dividend')!;
    expect(div.fields.find((f) => f.field === 'Ticker')!.examples).toEqual(['MAIN']);
  });
});

describe('admin-review — akcje na skipach', () => {
  it('buildSkipGroups kategoryzuje powody (unknown/gentle/mapping)', () => {
    const traces: RowTrace[] = [
      { row: 1, matchedRuleId: null, emitted: 'skip', skipReason: 'unknown_operation_type' },
      { row: 2, matchedRuleId: 'x', emitted: 'skip', skipReason: 'summary_row' },
      { row: 3, matchedRuleId: 'b', emitted: 'skip', skipReason: 'invalid_quantity' },
    ];
    const g = buildSkipGroups(traces);
    expect(g.find((x) => x.reason === 'unknown_operation_type')!.category).toBe('unknown');
    expect(g.find((x) => x.reason === 'summary_row')!.category).toBe('gentle');
    expect(g.find((x) => x.reason === 'invalid_quantity')!.category).toBe('mapping');
  });

  it('inferDiscriminatorCol zwraca najczęstszą kolumnę reguł', () => {
    expect(inferDiscriminatorCol(PROFILE)).toEqual({ name: 'Action' });
  });

  it('mappedClasses zwraca klasy z sekcją mapowania', () => {
    expect(mappedClasses(PROFILE).sort()).toEqual(['dividend', 'trade']);
  });

  it('unhandledDiscriminatorValues łapie nierozpoznane wartości (po podciągu)', () => {
    // 'Card debit' nie pasuje do żadnej reguły; 'Market buy'/'Dividend…' są pokryte.
    expect(unhandledDiscriminatorValues(PROFILE, HEADERS, SAMPLE)).toEqual(['Card debit']);
  });

  it('appendClassifyRule dokłada regułę bez mutacji oryginału', () => {
    const next = appendClassifyRule(PROFILE, {
      col: { name: 'Action' },
      values: ['Card debit'],
      emit: 'fee',
    });
    expect(PROFILE.classify).toHaveLength(2); // oryginał nietknięty
    expect(next.classify).toHaveLength(3);
    const rule = next.classify[2] as Record<string, unknown>;
    expect(rule.emit).toBe('fee');
    expect(rule.when).toEqual([{ col: { name: 'Action' }, op: 'oneOf', values: ['Card debit'] }]);
  });

  it('appendClassifyRule z skipReason tworzy regułę pomijającą', () => {
    const next = appendClassifyRule(PROFILE, {
      col: { name: 'Action' },
      values: ['Card debit'],
      emit: 'skip',
      skipReason: 'summary_row',
    });
    const rule = next.classify[next.classify.length - 1] as Record<string, unknown>;
    expect(rule.emit).toBe('skip');
    expect(rule.skipReason).toBe('summary_row');
  });
});
