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

describe('fxExchangeRate / orientFxRate — konwencja CashOperation.fxRate', () => {
  it('para z PLN: PLN za 1 X w obu kierunkach', async () => {
    const { fxExchangeRate } = await import('../utils.js');
    expect(
      fxExchangeRate({ amount: -400, currency: 'PLN' }, { amount: 100, currency: 'USD' }),
    ).toBe(4);
    expect(
      fxExchangeRate({ amount: -100, currency: 'USD' }, { amount: 400, currency: 'PLN' }),
    ).toBe(4);
    // JPY: PLN za 1 JPY < 1 — konwencja nie zakłada „kurs > 1".
    expect(
      fxExchangeRate({ amount: -27, currency: 'PLN' }, { amount: 1000, currency: 'JPY' }),
    ).toBe(0.027);
  });
  it('para krzyżowa: to za 1 from; zero → undefined', async () => {
    const { fxExchangeRate } = await import('../utils.js');
    expect(
      fxExchangeRate({ amount: -100, currency: 'EUR' }, { amount: 110, currency: 'USD' }),
    ).toBe(1.1);
    expect(
      fxExchangeRate({ amount: 0, currency: 'EUR' }, { amount: 110, currency: 'USD' }),
    ).toBeUndefined();
  });
  it('orientFxRate: odwraca kurs podany w przeciwnej orientacji, śmieć → kurs z kwot', async () => {
    const { orientFxRate } = await import('../utils.js');
    const from = { amount: -400, currency: 'PLN' };
    const to = { amount: 100, currency: 'USD' };
    expect(orientFxRate(4.01, from, to)).toBe(4.01);
    expect(orientFxRate(0.25, from, to)).toBe(4);
    expect(orientFxRate(17, from, to)).toBe(4);
    expect(orientFxRate(undefined, from, to)).toBe(4);
  });
});

describe('netDividendAmount — dywidenda netto ze znakiem', () => {
  it('typowo: +brutto / −podatek', async () => {
    const { netDividendAmount } = await import('../utils.js');
    expect(netDividendAmount(100, -15)).toMatchObject({ net: 85, taxPct: 15, sameSign: false });
  });
  it('korekta: −brutto / +zwrot podatku → ujemne netto', async () => {
    const { netDividendAmount } = await import('../utils.js');
    expect(netDividendAmount(-100, 15).net).toBe(-85);
  });
  it('zwrot podatku bez korekty dywidendy: +brutto / +zwrot → znak zgodny, dawna semantyka', async () => {
    const { netDividendAmount } = await import('../utils.js');
    expect(netDividendAmount(100, 15)).toMatchObject({ net: 85, sameSign: true });
  });
  it('bez podatku', async () => {
    const { netDividendAmount } = await import('../utils.js');
    expect(netDividendAmount(-12.346, undefined).net).toBe(-12.35);
  });
});

describe('normalizeQuantity', () => {
  it('usuwa szum, zostawia ułamki', async () => {
    const { normalizeQuantity } = await import('../utils.js');
    expect(normalizeQuantity(9.9999999)).toBe(10);
    expect(normalizeQuantity(0.4)).toBe(0.4);
    expect(normalizeQuantity(0.30690001)).toBe(0.3069);
  });
});
