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
