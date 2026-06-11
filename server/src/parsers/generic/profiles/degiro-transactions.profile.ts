import { ImportProfileSchema, type ImportProfile } from 'shared';

/**
 * Golden profil: transakcje DEGIRO (Transactions.csv, format NOWY 2022+).
 *
 * Nagłówek: Data,Czas,Produkt,ISIN,Giełda referencyjna,Miejsce wykonania,Liczba,
 * Kurs,(waluta),Wartość lokalna,(waluta),Wartość EUR,Kurs wymiany,Opłaty AutoFX,
 * Opłata transakcyjna DEGIRO i/lub opłata stron,Razem EUR,Identyfikator zlecenia
 *
 * Specyfika odwzorowana w profilu:
 * - strona K/S ze znaku kolumny Liczba (fractional shares zachowane),
 * - commission celowo BRAK (DEGIRO nalicza opłaty osobno w EUR w Account.csv —
 *   mapowanie prowizji z tego pliku liczyłoby je podwójnie),
 * - value wyliczane z qty×price (parser wbudowany ignoruje "Wartość lokalna"),
 * - waluta kwotowania z nienazwanej kolumny 8 (za "Kurs"), GBX→GBP robi silnik,
 * - corporate actions (kurs 0, wartość ≠ 0 — np. SPAC merger) → skip.
 */
export const DEGIRO_TRANSACTIONS_PROFILE: ImportProfile = ImportProfileSchema.parse({
  specVersion: 1,
  brokerLabel: 'DEGIRO',
  file: {
    delimiter: ',',
    headerRow: { strategy: 'first' },
    currencyAliases: { NO: 'NOK' },
  },
  classify: [
    {
      id: 'corporate-action',
      when: [
        { col: { name: 'Kurs' }, op: 'zeroNumber' },
        { col: { name: 'Wartość lokalna' }, op: 'nonzeroNumber' },
      ],
      emit: 'skip',
      skipReason: 'corporate_action',
    },
    {
      id: 'trade',
      when: [
        { col: { name: 'Data' }, op: 'notEmpty' },
        { col: { name: 'ISIN' }, op: 'notEmpty' },
      ],
      emit: 'trade',
    },
  ],
  defaultClass: 'skip',
  trade: {
    date: {
      source: { kind: 'column', col: { name: 'Data' } },
      formats: ['DD-MM-YYYY'],
      timeSource: { kind: 'column', col: { name: 'Czas' } },
    },
    paperName: { kind: 'column', col: { name: 'Produkt' } },
    isin: { kind: 'column', col: { name: 'ISIN' } },
    quantity: { kind: 'column', col: { name: 'Liczba' } },
    price: { kind: 'column', col: { name: 'Kurs' } },
    currency: { kind: 'column', col: 8, fallback: 'EUR' },
    paymentCurrency: { kind: 'const', value: 'EUR' },
    fxRate: { kind: 'column', col: { name: 'Kurs wymiany' } },
    side: { strategy: 'signedQuantity', col: { name: 'Liczba' } },
  },
} satisfies Record<string, unknown>);
