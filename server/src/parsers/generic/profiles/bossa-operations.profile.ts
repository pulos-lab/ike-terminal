import { ImportProfileSchema, type ImportProfile } from 'shared';

/**
 * Golden profil: operacje gotówkowe Bossa (operacje_bez_transakcji.csv).
 *
 * Nagłówek: data;tytuł operacji;szczegóły;kwota;waluta (daty YYYY-MM-DD).
 *
 * ZAKRES ŚWIADOMIE WĘŻSZY niż parser wbudowany: zdarzenia korporacyjne wymagające
 * rekoncyliacji (Wykup certyfikatów, Rozliczenie oferty, Obniżenie nominału,
 * pary IPO Zapisy+Zwrot) zostają w parserze wbudowanym — generyczny profil
 * klasyfikuje je jako 'other' (cashflow zachowany, bez syntetycznych K/S).
 * Harness parytetu raportuje te wiersze jako różnice oczekiwane.
 *
 * Wymiana walut: Bossa zapisuje każdą nogę jako OSOBNY wiersz z parą i kursem
 * w tytule ("Wymiana waluty PLN/USD 3.5713") → fx_leg BEZ pairing (jednowierszowe
 * fx_exchange z fxRate/fxPair przez regexExtract) — dokładnie jak parser wbudowany.
 */
const opsCashMapping = {
  date: { source: { kind: 'column', col: { name: 'data' } }, formats: ['YYYY-MM-DD'] },
  amount: { kind: 'column', col: { name: 'kwota' } },
  currency: { kind: 'column', col: { name: 'waluta' }, fallback: 'PLN' },
  description: { kind: 'column', col: { name: 'tytuł operacji' } },
  details: { kind: 'column', col: { name: 'szczegóły' } },
} as const;

const TITLE = { name: 'tytuł operacji' } as const;

export const BOSSA_OPERATIONS_PROFILE: ImportProfile = ImportProfileSchema.parse({
  specVersion: 1,
  brokerLabel: 'Bossa',
  file: {
    delimiter: ';',
    headerRow: { strategy: 'first' },
  },
  classify: [
    {
      id: 'settlement',
      when: [{ col: TITLE, op: 'contains', values: ['Rozliczenie transakcji'] }],
      emit: 'skip',
      skipReason: 'settlement_record',
    },
    {
      id: 'fx',
      when: [{ col: TITLE, op: 'startsWith', values: ['Wymiana waluty'] }],
      emit: 'fx_leg',
    },
    {
      id: 'dividend',
      when: [{ col: TITLE, op: 'contains', values: ['dywidendy'] }],
      emit: 'dividend',
    },
    {
      id: 'coupon',
      when: [{ col: TITLE, op: 'startsWith', values: ['Wypłata kuponu'] }],
      emit: 'coupon',
    },
    {
      id: 'offer-fee',
      when: [{ col: TITLE, op: 'startsWith', values: ['Rozliczenie oferty - prowizja'] }],
      emit: 'fee',
    },
    {
      id: 'fee',
      when: [{ col: TITLE, op: 'startsWith', values: ['Opłata za'] }],
      emit: 'fee',
    },
    {
      id: 'commission-refund',
      when: [{ col: TITLE, op: 'contains', values: ['Zwrot prowizji'] }],
      emit: 'commission_refund',
    },
    {
      id: 'ipo-subscription',
      when: [{ col: TITLE, op: 'contains', values: ['Zapisy na akcje'] }],
      emit: 'withdrawal',
    },
    {
      id: 'overpayment-refund',
      when: [{ col: TITLE, op: 'contains', values: ['Zwrot nadpłaty'] }],
      emit: 'deposit',
    },
    {
      id: 'transfer',
      when: [{ col: TITLE, op: 'contains', values: ['Przelew'] }],
      emit: 'deposit',
    },
  ],
  // Nierozpoznane tytuły → 'other': cashflow zachowany (wzorzec parsera wbudowanego).
  defaultClass: 'other',
  dividend: {
    ...opsCashMapping,
    ticker: {
      kind: 'regexExtract',
      col: TITLE,
      pattern: 'dywidendy(?:\\s+(?:netto|brutto))?\\s+(\\w+)',
      group: 1,
    },
  },
  coupon: {
    ...opsCashMapping,
    ticker: { kind: 'regexExtract', col: TITLE, pattern: 'Wypłata kuponu\\s+(\\S+)', group: 1 },
  },
  deposit: opsCashMapping,
  withdrawal: opsCashMapping,
  fee: opsCashMapping,
  commissionRefund: opsCashMapping,
  other: opsCashMapping,
  fxLeg: {
    ...opsCashMapping,
    fxRate: {
      kind: 'regexExtract',
      col: TITLE,
      pattern: 'Wymiana waluty \\w+/\\w+ ([\\d.]+)',
      group: 1,
    },
    fxPair: {
      kind: 'regexExtract',
      col: TITLE,
      pattern: 'Wymiana waluty (\\w+/\\w+)',
      group: 1,
    },
  },
} satisfies Record<string, unknown>);
