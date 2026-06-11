import { ImportProfileSchema, type ImportProfile } from 'shared';

/**
 * Golden profil: operacje DEGIRO (Account.csv).
 *
 * Nagłówek: Data,Czas,Data,Produkt,ISIN,Opis,Kurs,Zmiana,(kwota),Saldo,(waluta),
 * Identyfikator zlecenia — kolumna "Zmiana" to WALUTA kwoty, kwota jest w kolejnej,
 * nienazwanej kolumnie 8 (stąd referencje po indeksie). Dwie kolumny "Data":
 * occurrence=0 to data transakcji (occurrence=1 to data waluty — nieużywana).
 *
 * Parowanie odwzorowane z parsera wbudowanego:
 * - Dywidenda + Podatek Dywidendowy: po tickerze (Produkt) + dacie + czasie,
 *   netto na dywidendzie z dopiskiem "(podatek X%)",
 * - FX Credit + FX Withdrawal: po Identyfikatorze zlecenia (fallback data+czas),
 *   kurs z kolumny "Kurs"; nogi niesparowane importowane samodzielnie.
 *
 * Podatki transakcyjne (Stamp Duty, francuski) → defaultClass skip: parser
 * wbudowany dolicza je do prowizji TRANSAKCJI (parseTransactionTaxes) — to krok
 * serwisowy poza zakresem profilu; w generycznym imporcie wiersze są raportowane
 * jako nierozpoznane.
 */
const accountDate = {
  source: { kind: 'column', col: { name: 'Data', occurrence: 0 } },
  formats: ['DD-MM-YYYY'],
  timeSource: { kind: 'column', col: { name: 'Czas' } },
} as const;

const OPIS = { name: 'Opis' } as const;
const AMOUNT_COL = 8; // nienazwana kolumna kwoty (za "Zmiana")
const CURRENCY_COL = { name: 'Zmiana' } as const;

const accountCashMapping = {
  date: accountDate,
  amount: { kind: 'column', col: AMOUNT_COL },
  currency: { kind: 'column', col: CURRENCY_COL, fallback: 'PLN' },
  description: { kind: 'column', col: OPIS },
} as const;

export const DEGIRO_ACCOUNT_PROFILE: ImportProfile = ImportProfileSchema.parse({
  specVersion: 1,
  brokerLabel: 'DEGIRO',
  file: {
    delimiter: ',',
    headerRow: { strategy: 'first' },
    currencyAliases: { NO: 'NOK' },
  },
  classify: [
    {
      id: 'dividend',
      when: [{ col: OPIS, op: 'equals', values: ['Dywidenda'] }],
      emit: 'dividend',
    },
    {
      id: 'wht',
      when: [{ col: OPIS, op: 'equals', values: ['Podatek Dywidendowy'] }],
      emit: 'withholding_tax',
    },
    {
      id: 'deposit',
      when: [{ col: OPIS, op: 'startsWith', values: ['Depozyt'] }],
      emit: 'deposit',
    },
    {
      id: 'withdrawal',
      when: [{ col: OPIS, op: 'oneOf', values: ['Wypłata', 'flatex Withdrawal'] }],
      emit: 'withdrawal',
    },
    {
      id: 'fx-leg',
      when: [{ col: OPIS, op: 'oneOf', values: ['FX Credit', 'FX Withdrawal'] }],
      emit: 'fx_leg',
    },
    {
      id: 'fee',
      when: [
        {
          col: OPIS,
          op: 'oneOf',
          values: [
            'Odsetki',
            'Odsetki krótka sprzedaż',
            'Opłata za płatność Trustly-Sofort',
            'DEGIRO Opłata Transakcyjna i/lub opłata stron trzecich',
            'ADR/GDR Pass-Through Fee',
          ],
        },
      ],
      emit: 'fee',
    },
    {
      id: 'fee-exchange-connection',
      when: [{ col: OPIS, op: 'startsWith', values: ['DEGIRO Exchange Connection Fee'] }],
      emit: 'fee',
    },
  ],
  defaultClass: 'skip',
  dividend: {
    ...accountCashMapping,
    // Opis dywidendy = nazwa produktu (parser wbudowany buduje opis z Produktu).
    description: { kind: 'column', col: { name: 'Produkt' } },
    ticker: { kind: 'column', col: { name: 'Produkt' } },
    isin: { kind: 'column', col: { name: 'ISIN' } },
  },
  withholdingTax: {
    ...accountCashMapping,
    ticker: { kind: 'column', col: { name: 'Produkt' } },
    isin: { kind: 'column', col: { name: 'ISIN' } },
  },
  deposit: accountCashMapping,
  withdrawal: accountCashMapping,
  fee: { ...accountCashMapping, currency: { kind: 'column', col: CURRENCY_COL, fallback: 'EUR' } },
  fxLeg: accountCashMapping,
  pairing: {
    // ISIN zamiast tickera: DEGIRO potrafi zapisać inną nazwę produktu w wierszu
    // dywidendy i podatku (np. po zmianie nazwy spółki) — ISIN jest stabilny.
    dividendWht: { matchBy: ['isin', 'date', 'time'], windowDays: 0, handling: 'subtract' },
    fxLegs: {
      pairKey: { by: 'column', col: { name: 'Identyfikator zlecenia' } },
      rateSource: { kind: 'column', col: { name: 'Kurs' } },
    },
  },
} satisfies Record<string, unknown>);
