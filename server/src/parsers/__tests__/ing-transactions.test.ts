import { describe, it, expect } from 'vitest';
import { isIngFormat, parseIngTransactions } from '../ing-transactions.js';
import { decodeCSVBuffer } from '../encoding.js';

/**
 * Testy parsera transakcji ING BM (historiaTransakcji_*.csv).
 *
 * Format bez nagłówka, 9 kolumn pozycyjnych; wariant archiwalny (~2020) ma
 * nagłówek ORAZ czas z myślnikami. Kluczowe pułapki liczb: NBSP ( ) jako
 * separator tysięcy w Wartości, przecinek dziesiętny w Kursie i KROPKA
 * dziesiętna w Prowizji — wszystko w jednym wierszu.
 */

const NBSP = ' ';

/** Wiersze 1:1 z realnego eksportu (zredagowane numerycznie). */
const ROW_BUY = `29-08-2023 14:25:33;843790613;ETFSP500;Kupno;35;190,20;6${NBSP}657,00;24.63;6${NBSP}681,63`;
const ROW_SELL = `25-09-2023 09:05:00;847466225;ETFSP500;Sprzedaż;75;194,50;14${NBSP}587,50;53.97;14${NBSP}533,53`;
const ROW_FILL_A = `07-07-2025 09:01:15;940383149;PZU;Sprzedaż;1;61,36;61,36;6.00;55,36`;
const ROW_FILL_B = `07-07-2025 09:01:28;940383149;PZU;Sprzedaż;8;61,36;490,88;0.00;490,88`;

const ARCHIVE_HEADER =
  'Data transakcji;Numer zlecenia;Papier;Kierunek;Ilość;Kurs;Wartość;Prowizja;Wartość z prowizją';
const ARCHIVE_ROW = '28-12-2020 09-00-00;627022729;CDPROJEKT;Kupno;37;265,00;9805,00;0,00;9805,00';

describe('isIngFormat', () => {
  it('wykrywa bezgłówkowy eksport po kształcie wierszy', () => {
    expect(isIngFormat([ROW_BUY, ROW_SELL].join('\n'))).toBe(true);
  });

  it('wykrywa wariant archiwalny z nagłówkiem (czas z myślnikami)', () => {
    expect(isIngFormat([ARCHIVE_HEADER, ARCHIVE_ROW].join('\n'))).toBe(true);
  });

  it('NIE łapie plików innych brokerów ani historii finansowej ING', () => {
    // DEGIRO: data bez czasu + przecinki; Bossa: nagłówek z ISIN.
    expect(isIngFormat('Data,Czas,Produkt,ISIN,Liczba,Kurs\n')).toBe(false);
    expect(isIngFormat('data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta\n')).toBe(
      false,
    );
    // Historia finansowa ING (7 kolumn, lp na początku, bez tokenu Kierunku).
    expect(
      isIngFormat('2;30-07-2025;Wpłaty/wypłaty;WPL/1/Zasilenie rachunku;100.00;100.00;PLN'),
    ).toBe(false);
    expect(isIngFormat('')).toBe(false);
  });
});

describe('parseIngTransactions — mapowanie kolumn i liczby', () => {
  it('parsuje kupno: NBSP w Wartości, przecinek w Kursie, kropka w Prowizji', () => {
    const result = parseIngTransactions(ROW_BUY, 'batch-test');
    expect(result.skipped).toHaveLength(0);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      date: '2023-08-29T14:25:33',
      paperName: 'ETFSP500',
      isin: 'ETFSP500', // pseudo-ISIN = ticker; realny doszywa import-service
      side: 'K',
      quantity: 35,
      price: 190.2,
      value: 6657,
      commission: 24.63,
      total: 6681.63,
      currency: 'PLN',
      paymentCurrency: 'PLN',
      source: 'ing',
      orderId: '843790613',
    });
  });

  it('sprzedaż: total = wartość − prowizja (zgodny z kolumną pliku)', () => {
    const result = parseIngTransactions(ROW_SELL, 'batch-test');
    expect(result.data[0]).toMatchObject({ side: 'S', total: 14533.53 });
    expect(result.warnings).toBeUndefined();
  });

  it('fille częściowe tego samego zlecenia to osobne transakcje', () => {
    const result = parseIngTransactions([ROW_FILL_A, ROW_FILL_B].join('\n'), 'batch-test');
    expect(result.data).toHaveLength(2);
    expect(result.data.every((t) => t.orderId === '940383149')).toBe(true);
  });

  it('wariant archiwalny: nagłówek pomijany, czas 09-00-00 i prowizja z przecinkiem', () => {
    const result = parseIngTransactions([ARCHIVE_HEADER, ARCHIVE_ROW].join('\n'), 'batch-test');
    expect(result.skipped).toHaveLength(0);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      date: '2020-12-28T09:00:00',
      paperName: 'CDPROJEKT',
      quantity: 37,
      commission: 0,
      total: 9805,
    });
  });

  it('rozjazd „Wartość z prowizją" vs wyliczenie → jeden zbiorczy warning', () => {
    const broken = ROW_BUY.replace(`6${NBSP}681,63`, `9${NBSP}999,99`);
    const result = parseIngTransactions(broken, 'batch-test');
    expect(result.data).toHaveLength(1); // wiersz zostaje, total przeliczony
    expect(result.data[0].total).toBe(6681.63);
    expect(result.warnings?.some((w) => w.includes('Wartość z prowizją'))).toBe(true);
  });
});

describe('parseIngTransactions — alias PDA i walidacja', () => {
  it('ZKA1 (PDA z IPO Żabki) aliasowany na ZABKA', () => {
    const zka = '14-10-2024 16:43:07;901072676;ZKA1;Kupno;314;21,50;6 751,00;0.00;6 751,00';
    const result = parseIngTransactions(zka, 'batch-test');
    expect(result.data[0]).toMatchObject({ paperName: 'ZABKA', isin: 'ZABKA', quantity: 314 });
  });

  it('dodatkowy średnik w polu → column_shift + warning z treścią wiersza', () => {
    const broken = `29-08-2023 14:25:33;843790613;ETF;SP500;Kupno;35;190,20;6 657,00;24.63;6 681,63`;
    const result = parseIngTransactions(broken, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('column_shift');
    expect(result.warnings?.[0]).toContain('Wiersz 1');
  });

  it('nieznany kierunek → invalid_side', () => {
    const broken = ROW_BUY.replace(';Kupno;', ';Konwersja;');
    const result = parseIngTransactions(broken, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('invalid_side');
  });

  it('za krótki wiersz → short_row', () => {
    const result = parseIngTransactions('29-08-2023 14:25:33;843790613;ETFSP500', 'batch-test');
    expect(result.skipped[0]?.reason).toBe('short_row');
  });
});

describe('kodowanie — surowy bufor przechodzi przez decodeCSVBuffer', () => {
  it('plik czysty ASCII + bajt 0xA0 (NBSP win1250) parsuje się poprawnie', () => {
    // Realne pliki ING są w Windows-1250; jedyne bajty spoza ASCII to często
    // wyłącznie 0xA0 (separator tysięcy) i „ż" w Sprzedaż — decodeCSVBuffer
    // musi zejść do gałęzi win1250, a parseNumber połknąć NBSP po dekodzie.
    const raw = Buffer.from(
      '29-08-2023 14:25:33;843790613;ETFSP500;Kupno;35;190,20;6\xa0657,00;24.63;6\xa0681,63\r\n' +
        '29-11-2023 10:10:08;856998561;ENEA;Sprzeda\xbf;112;8,41;941,92;6.00;935,92\r\n',
      'binary',
    );
    const content = decodeCSVBuffer(raw);
    expect(isIngFormat(content)).toBe(true);
    const result = parseIngTransactions(content, 'batch-test');
    expect(result.data).toHaveLength(2);
    expect(result.data[0].value).toBe(6657);
    expect(result.data[1]).toMatchObject({ side: 'S', paperName: 'ENEA', value: 941.92 });
  });
});
