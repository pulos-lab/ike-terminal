import { ImportProfileSchema, type ImportProfile } from 'shared';

/**
 * Golden profil: transakcje Bossa (hisPW.csv) wyrażone deklaratywnie.
 *
 * Służy jako: (1) golden test parytetu z ręcznym parserem bossa-transactions.ts,
 * (2) few-shot przykład dla generatora LLM, (3) dokumentacja możliwości spec.
 * NIE zastępuje wbudowanego parsera — Bossa nadal idzie przez PARSER_REGISTRY.
 *
 * Nagłówek: data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta
 * (kolumna strony K/S nazywa się dosłownie "-"). Windows-1250, średniki,
 * daty DD.MM.YYYY HH:MM:SS, total wprost z kolumny "po prowizji".
 */
export const BOSSA_TRANSACTIONS_PROFILE: ImportProfile = ImportProfileSchema.parse({
  specVersion: 1,
  brokerLabel: 'Bossa',
  file: {
    delimiter: ';',
    headerRow: { strategy: 'first' },
  },
  classify: [
    {
      id: 'trade',
      when: [{ col: { name: 'data' }, op: 'notEmpty' }],
      emit: 'trade',
    },
  ],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['DD.MM.YYYY'] },
    paperName: { kind: 'column', col: { name: 'papier' } },
    isin: { kind: 'column', col: { name: 'isin' } },
    quantity: { kind: 'column', col: { name: 'ilość' } },
    wholeShares: true,
    price: { kind: 'column', col: { name: 'cena' } },
    value: { kind: 'column', col: { name: 'wartość' } },
    commission: { kind: 'column', col: { name: 'prowizja' } },
    total: { kind: 'column', col: { name: 'po prowizji' } },
    currency: { kind: 'column', col: { name: 'waluta' }, fallback: 'PLN' },
    paymentCurrency: { kind: 'const', value: 'PLN' },
    side: { strategy: 'column', col: { name: '-' }, buyValues: ['K'], sellValues: ['S'] },
  },
} satisfies Record<string, unknown>);
