import { describe, it, expect } from 'vitest';
import { parseMbankTransactions } from '../mbank-transactions.js';
import { roundTo2 } from '../utils.js';

describe('parseMbankTransactions', () => {
  it('parses comma-delimited CSV (new format)', () => {
    const csv = [
      'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Warto\u015b\u0107,Waluta',
      '03.03.2026 16:26:23,MICRON TECH,USA-NASDAQ,K,4,374,,,,,',
      '17.02.2026 09:02:10,KOMPUTRON,WWA-GPW,S,12,7,,,,,',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);

    // MICRON TECH — USD inferred from USA-NASDAQ
    expect(result.data[0].paperName).toBe('MICRON TECH');
    expect(result.data[0].side).toBe('K');
    expect(result.data[0].quantity).toBe(4);
    expect(result.data[0].price).toBe(374);
    expect(result.data[0].currency).toBe('USD');
    expect(result.data[0].commission).toBe(0);

    // KOMPUTRON — PLN inferred from WWA-GPW
    expect(result.data[1].paperName).toBe('KOMPUTRON');
    expect(result.data[1].side).toBe('S');
    expect(result.data[1].quantity).toBe(12);
    expect(result.data[1].currency).toBe('PLN');
  });

  it('parses semicolon-delimited CSV (legacy format)', () => {
    const csv = [
      'Czas transakcji;Papier;Gie\u0142da;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Warto\u015b\u0107;Waluta',
      '25.02.2026 09:00:00;KGHM;WWA-GPW;K;10;150.50;PLN;5.00;PLN;1505.00;PLN',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].paperName).toBe('KGHM');
    expect(result.data[0].price).toBe(150.5);
    expect(result.data[0].currency).toBe('PLN');
    expect(result.data[0].commission).toBe(5);
  });

  it('infers currency from exchange when Waluta column is empty', () => {
    const csv = [
      'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Warto\u015b\u0107,Waluta',
      '01.01.2026 10:00:00,APPLE,USA-NYSE,K,1,200,,,,,',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].currency).toBe('USD');
  });

  it('defaults currency to PLN when exchange is unknown', () => {
    const csv = [
      'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Warto\u015b\u0107,Waluta',
      '01.01.2026 10:00:00,TEST,UNKNOWN-EX,K,1,100,,,,,',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].currency).toBe('PLN');
  });

  it('returns empty result for empty CSV', () => {
    const result = parseMbankTransactions('', 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('brak kolumny Prowizja/Waluta w nagłówku → pole nieobecne (0/inferencja), nie odczyt złej kolumny', () => {
    // Nagłówek bez Prowizja i Waluta; wiersz danych ma w indeksach 6/7 śmieci,
    // które stary kod (fallback waluta→6, prowizja→7) odczytałby jako walutę 'JUNK'
    // i prowizję 999.
    const csv = [
      'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs',
      '01.01.2026 10:00:00;KGHM;WWA-GPW;K;10;150;JUNK;999',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].commission).toBe(0); // nie 999
    expect(result.data[0].currency).toBe('PLN'); // z giełdy WWA-GPW, nie 'JUNK'
    expect(result.data[0].total).toBe(1500);

    // Jedno zagregowane ostrzeżenie o brakujących kolumnach
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain('Prowizja');
    expect(result.warnings![0]).toContain('Waluta');
  });

  it('pełny nagłówek (wszystkie kolumny nazwane) → bez warningów', () => {
    const csv = [
      'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta',
      '25.02.2026 09:00:00;KGHM;WWA-GPW;K;10;150.50;PLN;5.00;PLN;1505.00;PLN',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.warnings).toBeUndefined();
  });

  it('skips rows with price <= 0', () => {
    const csv = [
      'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Warto\u015b\u0107,Waluta',
      '01.01.2026 10:00:00,KGHM,WWA-GPW,K,10,0,,,,,',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('invalid_price');
  });

  // ── Przewalutowanie: eMakler to rachunek złotowy, papier bywa notowany w USD/EUR ──

  it('papier w USD rozliczony w PLN → kurs z pliku, prowizja przeliczona na walutę kwotowania', () => {
    // Wiersz 1:1 z realnego eksportu (mBank formatuje liczby po polsku).
    const csv = [
      'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta',
      '05.11.2025 09:00:18;ISLN LN ETF;GBR-LSE;S;131;45,5650;USD;64,11;PLN;22 106,25;PLN',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    const tx = result.data[0];
    expect(tx.currency).toBe('USD'); // kwotowanie — mimo giełdy GBR-LSE
    expect(tx.paymentCurrency).toBe('PLN'); // rozliczenie z kolumny przy „Wartość"
    expect(tx.value).toBe(5969.02); // 131 × 45,5650, w walucie kwotowania
    // Kurs mBanku wprost z pliku: 22 106,25 PLN / 5 969,02 USD
    expect(tx.fxRate).toBeCloseTo(3.7035, 4);
    // Prowizja w pliku jest w PLN (0,29% kwoty rozliczenia) → na USD to ~17,31
    expect(tx.commission).toBeCloseTo(17.31, 2);
    // total zostaje w walucie kwotowania, żeby silnik mógł policzyć total × fxRate
    expect(tx.total).toBeCloseTo(5951.71, 2);
    expect(roundTo2(tx.total * tx.fxRate!)).toBeCloseTo(22106.25 - 64.11, 1);
  });

  it('papier w PLN rozliczony w PLN → bez kursu, prowizja bez przeliczania', () => {
    const csv = [
      'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta',
      '11.12.2023 09:41:58;PEO;WWA-GPW;K;47;112,90;PLN;20,69;PLN;5 306,30;PLN',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    const tx = result.data[0];
    expect(tx.currency).toBe('PLN');
    expect(tx.paymentCurrency).toBe('PLN');
    expect(tx.fxRate).toBeUndefined();
    expect(tx.commission).toBe(20.69); // bez konwersji
    expect(tx.total).toBe(5326.99); // 5306,30 + 20,69
  });

  it('waluta obca bez kolumny Wartość → prowizja pominięta zamiast doliczona w złej walucie', () => {
    const csv = [
      'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta',
      '05.11.2025 09:00:18;INTEL CORP;USA-NASDAQ;K;10;25,00;USD;14,00;PLN',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    const tx = result.data[0];
    expect(tx.currency).toBe('USD');
    expect(tx.fxRate).toBeUndefined();
    expect(tx.commission).toBe(0); // 14 PLN NIE trafia do totala w USD
    expect(tx.total).toBe(250);
    expect(result.warnings?.join(' ')).toContain('pominięto prowizję');
  });
});
