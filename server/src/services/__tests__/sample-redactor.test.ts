import { describe, it, expect } from 'vitest';
import { redactCell, redactSampleRows, redactFileName } from '../sample-redactor.js';

describe('sample-redactor — redactCell', () => {
  it('NIE maskuje ułamkowych ilości/cen (część liczby dziesiętnej)', () => {
    // Sedno fixu: Trading 212 zapisuje ilości z długą częścią ułamkową.
    expect(redactCell('0.3069000000')).toBe('0.3069000000');
    expect(redactCell('0,3069000000')).toBe('0,3069000000'); // separator europejski
    expect(redactCell('1234567.890123456')).toBe('1234567.890123456'); // długa cena
    expect(redactCell('49.96')).toBe('49.96');
    expect(redactCell('630.11')).toBe('630.11');
  });

  it('maskuje SAMODZIELNE długie ciągi cyfr (numery rachunków/ID)', () => {
    expect(redactCell('123456789')).toBe('***'); // dokładnie 9
    expect(redactCell('123456789012')).toBe('***'); // 12
    expect(redactCell('Transaction ID: 123456789012')).toBe('Transaction ID: ***');
    // 8 cyfr — za krótkie, zostaje.
    expect(redactCell('12345678')).toBe('12345678');
  });

  it('maskuje IBAN i e-mail, nie zostawiając surowych cyfr konta', () => {
    expect(redactCell('PL61109010140000071219812874')).not.toMatch(/\d{9}/);
    expect(redactCell('jan.kowalski@example.com')).toBe('***');
  });

  it('nie maskuje alfanumerycznych ID bez długiego ciągu cyfr (np. ID transakcji)', () => {
    expect(redactCell('30c841b3-068d-44f0-980a')).toBe('30c841b3-068d-44f0-980a');
    expect(redactCell('PB6XHFHSNDT97F32')).toBe('PB6XHFHSNDT97F32');
  });

  it('NIE maskuje ISIN-ów z czysto numerycznym NSIN (10 cyfr po kodzie kraju)', () => {
    // Sedno fixu: numeryczny NSIN wyglądał dla LONG_DIGITS_RE jak numer rachunku.
    expect(redactCell('US0378331005')).toBe('US0378331005'); // Apple — klasyczny CUSIP
    expect(redactCell('DE0007164600')).toBe('DE0007164600'); // SAP
    expect(redactCell('CY1000031710')).toBe('CY1000031710'); // ASBIS (raport PKO BM)
    expect(redactCell('PL0000108817')).toBe('PL0000108817'); // obligacja skarbowa
    expect(redactCell('NL0010273215')).toBe('NL0010273215');
    // ISIN-y z literą w NSIN nigdy nie były maskowane — bez regresji.
    expect(redactCell('PLLUBAW00013')).toBe('PLLUBAW00013');
    expect(redactCell('IE00B4L5Y983')).toBe('IE00B4L5Y983');
  });

  it('zostawia ISIN wewnątrz opisu operacji, maskując resztę wzorców', () => {
    expect(redactCell('Dywidenda ASBIS ISIN CY1000031710 brutto')).toBe(
      'Dywidenda ASBIS ISIN CY1000031710 brutto',
    );
    expect(redactCell('Przelew 123456789012 dot. US0378331005')).toBe(
      'Przelew *** dot. US0378331005',
    );
  });

  it('ochrona ISIN nie osłabia maskowania rachunków (IBAN jest dłuższy niż 12 znaków)', () => {
    expect(redactCell('PL61109010140000071219812874')).not.toMatch(/\d{9}/);
    expect(redactCell('DE89370400440532013000')).not.toMatch(/\d{9}/);
  });
});

describe('sample-redactor — redactSampleRows', () => {
  const headers = ['Action', 'No. of shares', 'Właściciel'];

  it('zostawia ułamkową ilość, maskuje kolumnę wrażliwą po nazwie nagłówka', () => {
    const out = redactSampleRows(headers, [['Market buy', '0.3069000000', 'Jan Kowalski']]);
    expect(out[0][0]).toBe('Market buy');
    expect(out[0][1]).toBe('0.3069000000'); // KLUCZOWE: ilość nie jest już maskowana
    expect(out[0][2]).toBe('***'); // 'Właściciel' → kolumna wrażliwa
  });

  it('puste komórki zostają puste; wejście nietknięte', () => {
    const rows = [['Deposit', '', '']];
    const out = redactSampleRows(headers, rows);
    expect(out[0][1]).toBe('');
    expect(rows[0][1]).toBe(''); // brak mutacji wejścia
  });
});

describe('sample-redactor — redactFileName', () => {
  it('maskuje ciągi ≥6 cyfr (numery rachunków w nazwie), krótkie zostają', () => {
    expect(redactFileName('eksport_1234567.csv')).toBe('eksport_###.csv');
    expect(redactFileName('raport_2024.csv')).toBe('raport_2024.csv');
  });
});
