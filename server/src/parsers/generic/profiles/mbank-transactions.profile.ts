import { ImportProfileSchema, type ImportProfile } from 'shared';

/**
 * Golden profil: transakcje mBank eMakler (eksport z ~34 liniami metadanych
 * przed nagłówkiem → headerRow.scan).
 *
 * Nagłówek: Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta
 * — trzy kolumny "Waluta"; waluta kwotowania to PIERWSZE wystąpienie (za "Kurs").
 *
 * mBank nie podaje ISIN → needsNameResolution=true (pseudo-ISIN = nazwa papieru,
 * resolucja nazwa→ISIN po imporcie — ścieżka istniejąca dla parsera wbudowanego).
 *
 * Ograniczenia vs parser wbudowany:
 * 1. brak inferencji waluty z kolumny Giełda (mapa USA-NASDAQ→USD itd.) — przy
 *    pustej Walucie profil daje fallback PLN;
 * 2. brak wyliczania kursu przewalutowania. eMakler nie ma kolumny z kursem —
 *    wbudowany parser wyprowadza go jako Wartość / (Liczba × Kurs) i tym samym
 *    kursem przelicza prowizję (podaną w walucie rozliczenia) na walutę
 *    kwotowania. Schemat profilu przyjmuje `fxRate` tylko jako KOLUMNĘ, więc
 *    dla wiersza z papierem w USD rozliczonym w PLN profil zwróci transakcję
 *    bez `fxRate` i z prowizją w walucie rozliczenia. Golden fixture nie ma
 *    takiego wiersza (wszystkie są jednowalutowe), więc parytet jest zachowany.
 */
export const MBANK_TRANSACTIONS_PROFILE: ImportProfile = ImportProfileSchema.parse({
  specVersion: 1,
  brokerLabel: 'mBank eMakler',
  file: {
    delimiter: ';',
    headerRow: {
      strategy: 'scan',
      signature: ['Czas transakcji', 'Papier', 'K/S'],
      maxScanRows: 60,
    },
  },
  classify: [
    {
      id: 'trade',
      when: [{ col: { name: 'Czas transakcji' }, op: 'notEmpty' }],
      emit: 'trade',
    },
  ],
  defaultClass: 'skip',
  trade: {
    date: {
      source: { kind: 'column', col: { name: 'Czas transakcji' } },
      formats: ['DD.MM.YYYY'],
    },
    paperName: { kind: 'column', col: { name: 'Papier' } },
    quantity: { kind: 'column', col: { name: 'Liczba' } },
    wholeShares: true,
    price: { kind: 'column', col: { name: 'Kurs' } },
    commission: { kind: 'column', col: { name: 'Prowizja' } },
    currency: { kind: 'column', col: { name: 'Waluta', occurrence: 0 }, fallback: 'PLN' },
    // Waluta rozliczenia = TRZECIE wystąpienie "Waluta" (za "Wartość"). Wcześniej
    // było zaszyte 'PLN'; rachunek eMakler faktycznie jest złotowy, ale przy
    // papierze notowanym w obcej walucie plik podaje tę informację wprost i to
    // ona jest źródłem prawdy — tak samo jak w parserze wbudowanym.
    paymentCurrency: { kind: 'column', col: { name: 'Waluta', occurrence: 2 }, fallback: 'PLN' },
    side: { strategy: 'column', col: { name: 'K/S' }, buyValues: ['K'], sellValues: ['S'] },
  },
  needsNameResolution: true,
} satisfies Record<string, unknown>);
