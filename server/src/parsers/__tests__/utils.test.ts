import { describe, it, expect } from 'vitest';
import { parseNumber, computeTotal, validateTradeFields, parseDashedDateTime } from '../utils.js';

describe('parseNumber', () => {
  it('parsuje format europejski ze spacją tysięcy: "1 234,56"', () => {
    expect(parseNumber('1 234,56')).toBe(1234.56);
  });

  it('parsuje kropkę-tysiące + przecinek-dziesiętny: "1.234,56"', () => {
    expect(parseNumber('1.234,56')).toBe(1234.56);
  });

  it('parsuje przecinek-tysiące + kropkę-dziesiętną: "1,234.56"', () => {
    expect(parseNumber('1,234.56')).toBe(1234.56);
  });

  it('parsuje zwykłą kropkę dziesiętną: "1234.56"', () => {
    expect(parseNumber('1234.56')).toBe(1234.56);
  });

  it('parsuje zwykły przecinek dziesiętny: "1234,56"', () => {
    expect(parseNumber('1234,56')).toBe(1234.56);
  });

  it('parsuje liczby ujemne: "-1.234,56"', () => {
    expect(parseNumber('-1.234,56')).toBe(-1234.56);
  });

  it('zwraca 0 dla śmieci / pustych wartości', () => {
    expect(parseNumber('garbage')).toBe(0);
    expect(parseNumber('')).toBe(0);
    expect(parseNumber(undefined)).toBe(0);
  });

  it('połyka NBSP jako separator tysięcy (ING, win1250 0xA0): "6 657,00"', () => {
    expect(parseNumber('6 657,00')).toBe(6657);
  });
});

describe('parseDashedDateTime (ING)', () => {
  it('parsuje datę z czasem dwukropkowym: "29-08-2023 14:25:33"', () => {
    expect(parseDashedDateTime('29-08-2023 14:25:33')).toBe('2023-08-29T14:25:33');
  });

  it('parsuje archiwalny czas z myślnikami: "28-12-2020 09-00-00"', () => {
    expect(parseDashedDateTime('28-12-2020 09-00-00')).toBe('2020-12-28T09:00:00');
  });

  it('sama data → T00:00:00', () => {
    expect(parseDashedDateTime('30-07-2025')).toBe('2025-07-30T00:00:00');
  });

  it('nierozpoznany format zwraca wejście (konwencja parseDottedDate)', () => {
    expect(parseDashedDateTime('2025/07/30')).toBe('2025/07/30');
  });
});

describe('computeTotal', () => {
  it('kupno (K): wartość + prowizja', () => {
    expect(computeTotal('K', 1000, 3.9)).toBe(1003.9);
  });

  it('sprzedaż (S): wartość - prowizja', () => {
    expect(computeTotal('S', 750, 3.9)).toBe(746.1);
  });

  it('zaokrągla do 2 miejsc (precyzja walutowa)', () => {
    expect(computeTotal('K', 0.105, 0.001)).toBe(0.11);
  });
});

describe('validateTradeFields', () => {
  it('przepuszcza poprawny wiersz', () => {
    expect(
      validateTradeFields({
        date: '01.01.2024',
        paperName: 'CDR',
        side: 'K',
        quantity: 1,
        price: 100,
      }),
    ).toEqual({ ok: true });
  });

  it('wykrywa brak daty przed innymi błędami', () => {
    expect(validateTradeFields({ date: '', side: 'X', quantity: 0, price: 0 })).toEqual({
      ok: false,
      reason: 'missing_date',
    });
  });

  it('sprawdza tylko przekazane pola (Bossa: isin, mBank: paperName)', () => {
    // Bez klucza paperName — brak nazwy nie jest błędem
    expect(validateTradeFields({ date: 'x', isin: '', side: 'K', quantity: 1, price: 1 })).toEqual({
      ok: false,
      reason: 'missing_isin',
    });
    expect(
      validateTradeFields({ date: 'x', paperName: '', side: 'K', quantity: 1, price: 1 }),
    ).toEqual({ ok: false, reason: 'missing_name' });
  });

  it('odrzuca stronę inną niż K/S', () => {
    expect(validateTradeFields({ date: 'x', side: 'B', quantity: 1, price: 1 })).toEqual({
      ok: false,
      reason: 'invalid_side',
    });
  });

  it('odrzuca quantity <= 0 i price <= 0', () => {
    expect(validateTradeFields({ date: 'x', side: 'K', quantity: 0, price: 1 })).toEqual({
      ok: false,
      reason: 'invalid_quantity',
    });
    expect(validateTradeFields({ date: 'x', side: 'K', quantity: 1, price: -5 })).toEqual({
      ok: false,
      reason: 'invalid_price',
    });
  });
});
