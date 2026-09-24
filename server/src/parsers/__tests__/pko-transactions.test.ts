import { describe, it, expect } from 'vitest';
import { isPkoFormat, parsePkoTransactions } from '../pko-transactions.js';

/**
 * Testy parsera „Raportu transakcji" PKO BP BM (Supermakler).
 *
 * Dane w fixture'ach są syntetyczne (realny eksport użytkownika zostaje lokalnie
 * w gitignorowanym `import/pko/` — sprawdza go golden test), ale KSZTAŁT formatu
 * jest 1:1 z realnymi plikami obu pokoleń: bieżącego (2026) i archiwalnego (2021,
 * `public-samples/pl-archiwum-2021/myfund__PKOBP.csv`).
 */

const HEADER_2026 =
  'Czas zawarcia;Walor;Giełda;Waluta notowania;Oferta;Ilość;Kurs;Waluta Kurs;Wartość;' +
  'Waluta Wartość;Prowizja;Waluta Prowizja;Numer transakcji;Status zlecenia;Data rozliczenia;' +
  'Id zlecenia;Kwota nieopłacona;Waluta Kwota nieopłacona;Kurs przewalutowania';

const BUY_2026 =
  '14-01-2026 16:23:06;KGHM;WWA;PLN;Kupno;100;150,00;PLN;15000,00;PLN;28,50;PLN;' +
  'Z2601400000152;Zrealizowane;16-01-2026;25392373;;PLN;';
const SELL_2026 =
  '19-05-2026 16:07:40;KGHM;WWA;PLN;Sprzedaż;40;160,50;PLN;6420,00;PLN;12,20;PLN;' +
  'Z2613900000113;Zrealizowane;21-05-2026;26455703;;PLN;';
const CANCELLED_2026 =
  '04-12-2025 14:07:47;PKNORLEN;WWA;PLN;Sprzedaż;22;60,00;PLN;1320,00;PLN;2,51;PLN;' +
  'Z2533800000985;Unieważnione;08-12-2025;25098724;;PLN;';
/** Stopka: bez daty i waloru, z sumami — obejmuje też wiersze unieważnione. */
const SUMMARY_2026 = ';;;;;162;123,00;;22740,00;PLN;43,21;PLN;;;;;;;';

const HEADER_2021 =
  'Czas zawarcia;Walor(Portfel);Oferta;Ilość;Kurs;Kurs - waluta;Wartość;Wartość - waluta;' +
  'Prowizja;Prowizja - waluta;Nr.transakcji;Data rozliczenia;Kwota nieopłacona;Status zlecenia;' +
  'ID zlecenia;Giełda;Kurs przewalutowania;';
const SELL_2021 =
  '2021-10-06 16:26:34;SIMFABRIC-NC;S;22;20,00;PLN;440,00;PLN;1,72;PLN;Z2127900000044;' +
  '2021-10-08;Nie dotyczy;Wykonane;41505738;POL-GPW;;';

const csv = (...lines: string[]) => lines.join('\n');

describe('isPkoFormat', () => {
  it('wykrywa bieżący nagłówek (2026) — także z BOM na początku pliku', () => {
    expect(isPkoFormat(csv(HEADER_2026, BUY_2026))).toBe(true);
    expect(isPkoFormat('﻿' + csv(HEADER_2026, BUY_2026))).toBe(true);
  });

  it('wykrywa nagłówek archiwalny (2021) mimo innych nazw i kolejności kolumn', () => {
    expect(isPkoFormat(csv(HEADER_2021, SELL_2021))).toBe(true);
  });

  it('NIE łapie plików innych brokerów', () => {
    // mBank ma „Czas transakcji"+„K/S", Bossa kolumnę ISIN, DEGIRO przecinki,
    // ING wiersze bez nagłówka (drugie pole = numer zlecenia).
    expect(
      isPkoFormat('Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta\n'),
    ).toBe(false);
    expect(isPkoFormat('data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta\n')).toBe(
      false,
    );
    expect(isPkoFormat('Data,Czas,Produkt,ISIN,Liczba,Kurs\n')).toBe(false);
    expect(isPkoFormat('29-08-2023 14:25:33;843790613;ETFSP500;Kupno;35;190,20;6657,00\n')).toBe(
      false,
    );
    expect(isPkoFormat('')).toBe(false);
  });
});

describe('parsePkoTransactions — mapowanie kolumn', () => {
  it('kupno: skrót GPW jako pseudo-ISIN, total = wartość + prowizja', () => {
    const result = parsePkoTransactions(csv(HEADER_2026, BUY_2026), 'batch-test');
    expect(result.skipped).toHaveLength(0);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      date: '2026-01-14T16:23:06',
      paperName: 'KGHM',
      isin: 'KGHM',
      side: 'K',
      quantity: 100,
      price: 150,
      value: 15000,
      commission: 28.5,
      total: 15028.5,
      currency: 'PLN',
      paymentCurrency: 'PLN',
      source: 'pko',
      importBatch: 'batch-test',
    });
    expect(result.data[0].fxRate).toBeUndefined();
  });

  it('sprzedaż: total = wartość − prowizja', () => {
    const result = parsePkoTransactions(csv(HEADER_2026, SELL_2026), 'batch-test');
    expect(result.data[0]).toMatchObject({
      side: 'S',
      value: 6420,
      commission: 12.2,
      total: 6407.8,
    });
  });

  it('archiwalne pokolenie: inne nazwy kolumn, data ISO, K/S i sufiks rynku', () => {
    const result = parsePkoTransactions(csv(HEADER_2021, SELL_2021), 'batch-test');
    expect(result.skipped).toHaveLength(0);
    expect(result.data[0]).toMatchObject({
      date: '2021-10-06T16:26:34',
      // Sufiks -NC zostaje (wzorzec Bossy) — włącza guard NewConnectu w resolverze.
      paperName: 'SIMFABRIC-NC',
      isin: 'SIMFABRIC-NC',
      side: 'S',
      quantity: 22,
      price: 20,
      value: 440,
      commission: 1.72,
      total: 438.28,
      currency: 'PLN',
    });
  });
});

describe('parsePkoTransactions — wiersze pomijane', () => {
  it('stopka sum nie staje się transakcją (skip summary_row, bez raw)', () => {
    const result = parsePkoTransactions(csv(HEADER_2026, BUY_2026, SELL_2026, SUMMARY_2026), 'b');
    expect(result.data).toHaveLength(2);
    const summary = result.skipped.filter((s) => s.reason === 'summary_row');
    expect(summary).toHaveLength(1);
    expect(summary[0].raw).toBeUndefined();
  });

  it('status „Unieważnione" → cancelled_trade + ostrzeżenie z licznikiem', () => {
    const result = parsePkoTransactions(csv(HEADER_2026, BUY_2026, CANCELLED_2026), 'b');
    expect(result.data).toHaveLength(1);
    expect(result.skipped).toEqual([{ row: 3, reason: 'cancelled_trade', paperName: 'PKNORLEN' }]);
    expect(result.warnings?.join(' ')).toMatch(/pominięto 1 wierszy.*Unieważnione.*1/s);
  });

  it('przesunięcie kolumn (tekst w kolumnie kwoty) → column_shift, nie cicha liczba', () => {
    const broken = BUY_2026.replace(';15000,00;PLN;', ';brak danych;PLN;');
    const result = parsePkoTransactions(csv(HEADER_2026, broken), 'b');
    expect(result.data).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('column_shift');
    expect(result.warnings?.[0]).toContain('Wiersz 2');
  });

  it('plik bez rozpoznanego nagłówka nie parsuje niczego', () => {
    expect(parsePkoTransactions('foo;bar\n1;2\n', 'b')).toEqual({ data: [], skipped: [] });
  });
});

describe('parsePkoTransactions — waluty i kontrola kwot', () => {
  it('rozjazd walut: kurs liczony z kwot (payment-per-quote), nie z kolumny pliku', () => {
    const foreign =
      '02-02-2026 15:00:00;AAPL;NYSE;USD;Kupno;10;200,00;USD;8000,00;PLN;20,00;PLN;' +
      'Z2603300000001;Zrealizowane;04-02-2026;25500001;;PLN;4,00';
    const result = parsePkoTransactions(csv(HEADER_2026, foreign), 'b');
    expect(result.data[0]).toMatchObject({
      currency: 'USD',
      paymentCurrency: 'PLN',
      fxRate: 4, // 8000 PLN / (10 × 200 USD)
    });
    expect(result.warnings).toBeUndefined();
  });

  it('kolumna „Kurs przewalutowania" rozjechana z kwotami → ostrzeżenie, kurs z kwot', () => {
    const foreign =
      '02-02-2026 15:00:00;AAPL;NYSE;USD;Kupno;10;200,00;USD;8000,00;PLN;20,00;PLN;' +
      'Z2603300000001;Zrealizowane;04-02-2026;25500001;;PLN;0,25';
    const result = parsePkoTransactions(csv(HEADER_2026, foreign), 'b');
    expect(result.data[0].fxRate).toBe(4);
    expect(result.warnings?.join(' ')).toContain('Kurs przewalutowania');
  });

  it('nieznany kod giełdy bez kolumny waluty → PLN + ostrzeżenie (nie ciche założenie)', () => {
    const header2021Foreign = HEADER_2021;
    const row =
      '2021-10-06 16:26:34;AAPL;K;10;200,00;;2000,00;;5,00;;Z2127900000045;2021-10-08;' +
      'Nie dotyczy;Wykonane;41505739;USA-NYSE;;';
    const result = parsePkoTransactions(csv(header2021Foreign, row), 'b');
    expect(result.data[0].currency).toBe('PLN');
    expect(result.warnings?.join(' ')).toContain('USA-NYSE');
  });

  it('wartość ≠ ilość × kurs → ostrzeżenie (typowo obligacje w % nominału)', () => {
    const bond =
      '02-02-2026 15:00:00;PKN0528;WWA;PLN;Kupno;10;99,50;PLN;9950,00;PLN;18,91;PLN;' +
      'Z2603300000002;Zrealizowane;04-02-2026;25500002;;PLN;';
    const result = parsePkoTransactions(csv(HEADER_2026, bond), 'b');
    expect(result.data).toHaveLength(1);
    expect(result.warnings?.join(' ')).toContain('ilość × kurs');
  });
});
