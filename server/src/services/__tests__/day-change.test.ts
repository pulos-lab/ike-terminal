import { describe, it, expect } from 'vitest';
import {
  computePositionDayChange,
  lastWeekdayIso,
  pickPreviousClose,
  summarizeDayChange,
} from '../day-change.js';

const FX = { PLN: 1, USD: 4, GBP: 5 };

/** Domyślnie: 10 szt. w PLN, kupione dawno, 100 → 103. */
function input(over: Partial<Parameters<typeof computePositionDayChange>[0]> = {}) {
  return {
    lots: [{ date: '2025-01-10', quantity: 10, price: 80, currency: 'PLN' }],
    isShort: false,
    priceNative: 103,
    previousCloseNative: 100,
    sessionDate: '2026-11-09',
    instMult: 1,
    fxNativeToPln: 1,
    fxRates: FX,
    ...over,
  };
}

describe('computePositionDayChange', () => {
  it('stary lot: ilość × (cena − poprzednie zamknięcie)', () => {
    expect(computePositionDayChange(input())).toEqual({ native: 30, pln: 30 });
  });

  it('lot otwarty w dniu sesji liczy się od ceny otwarcia, nie od wczorajszego zamknięcia', () => {
    // Kupione dziś po 103, cena 103 → zero, a nie +30 „zarobione” przed zakupem.
    const r = computePositionDayChange(
      input({ lots: [{ date: '2026-11-09', quantity: 10, price: 103, currency: 'PLN' }] }),
    );
    expect(r).toEqual({ native: 0, pln: 0 });
  });

  it('miesza loty: stary od zamknięcia, dzisiejszy od ceny otwarcia', () => {
    const r = computePositionDayChange(
      input({
        lots: [
          { date: '2025-01-10', quantity: 10, price: 80, currency: 'PLN' },
          { date: '2026-11-09 10:15:00', quantity: 5, price: 101, currency: 'PLN' },
        ],
      }),
    );
    expect(r?.pln).toBeCloseTo(10 * 3 + 5 * 2, 10);
  });

  it('sam lot z dziś nie wymaga poprzedniego zamknięcia', () => {
    const r = computePositionDayChange(
      input({
        lots: [{ date: '2026-11-09', quantity: 4, price: 100, currency: 'PLN' }],
        previousCloseNative: null,
      }),
    );
    expect(r?.pln).toBeCloseTo(12, 10);
  });

  it('brak poprzedniego zamknięcia przy starym locie → null, nie liczba częściowa', () => {
    expect(computePositionDayChange(input({ previousCloseNative: null }))).toBeNull();
    expect(computePositionDayChange(input({ previousCloseNative: 0 }))).toBeNull();
    expect(
      computePositionDayChange(
        input({
          previousCloseNative: null,
          lots: [
            { date: '2025-01-10', quantity: 10, price: 80, currency: 'PLN' },
            { date: '2026-11-09', quantity: 5, price: 101, currency: 'PLN' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('pozycja krótka zarabia na spadku', () => {
    const r = computePositionDayChange(
      input({ isShort: true, priceNative: 97, previousCloseNative: 100 }),
    );
    expect(r).toEqual({ native: 30, pln: 30 });
  });

  it('waluta obca: kwota natywna i PLN po bieżącym kursie', () => {
    const r = computePositionDayChange(
      input({
        lots: [{ date: '2025-01-10', quantity: 10, price: 80, currency: 'USD' }],
        fxNativeToPln: 4,
      }),
    );
    expect(r).toEqual({ native: 30, pln: 120 });
  });

  it('lot z dziś w innej walucie niż notowanie przelicza koszt kursem lotu', () => {
    // Papier w USD kupiony dziś za PLN: 1 szt. po 400 PLN, cena 103 USD × 4 = 412 PLN.
    const r = computePositionDayChange(
      input({
        lots: [{ date: '2026-11-09', quantity: 1, price: 400, currency: 'PLN' }],
        fxNativeToPln: 4,
      }),
    );
    expect(r?.pln).toBeCloseTo(12, 10);
    expect(r?.native).toBeCloseTo(3, 10);
  });

  it('obligacja i opcja: mnożnik instrumentu skaluje zmianę', () => {
    // Obligacja: kurs 100,00 → 100,50 (% nominału), nominał 1000 → mnożnik 10, 3 szt.
    const bond = computePositionDayChange(
      input({
        lots: [{ date: '2025-01-10', quantity: 3, price: 99, currency: 'PLN' }],
        priceNative: 100.5,
        previousCloseNative: 100,
        instMult: 10,
      }),
    );
    expect(bond?.pln).toBeCloseTo(15, 10);
  });

  it('cena zerowa lub brak lotów → null', () => {
    expect(computePositionDayChange(input({ priceNative: 0 }))).toBeNull();
    expect(computePositionDayChange(input({ lots: [] }))).toBeNull();
  });
});

describe('summarizeDayChange', () => {
  const pos = (ticker: string, pln: number | null, currency = 'PLN', native = pln) => ({
    ticker,
    currency,
    dailyChangeValue: native,
    dailyChangeValuePln: pln,
  });

  it('pełne pokrycie: suma i procent wartości sprzed zmiany (z gotówką)', () => {
    const r = summarizeDayChange([pos('A.WA', 100), pos('B.WA', -40)], 10_060, 'PLN');
    expect(r).toMatchObject({
      change: 60,
      currency: 'PLN',
      coveredCount: 2,
      totalCount: 2,
      missingTickers: [],
      fxIncluded: false,
      hasForeignPositions: false,
    });
    // 60 / (10 060 − 60) = 0,6%
    expect(r?.changePct).toBeCloseTo(0.6, 10);
  });

  it('pokrycie częściowe jest jawne — brakujące tickery wymienione', () => {
    const r = summarizeDayChange(
      [pos('A.WA', 50), pos('NCX', null), pos('OPT', null)],
      5050,
      'PLN',
    );
    expect(r?.change).toBe(50);
    expect(r?.coveredCount).toBe(1);
    expect(r?.totalCount).toBe(3);
    expect(r?.missingTickers).toEqual(['NCX', 'OPT']);
  });

  it('zero pokrycia: kwota i procent null, nigdy 0', () => {
    const r = summarizeDayChange([pos('NCX', null)], 1000, 'PLN');
    expect(r?.change).toBeNull();
    expect(r?.changePct).toBeNull();
    expect(r?.coveredCount).toBe(0);
    expect(r?.totalCount).toBe(1);
  });

  it('portfel bez pozycji (sama gotówka) → null', () => {
    expect(summarizeDayChange([], 1000, 'PLN')).toBeNull();
  });

  it('kapitał ≤ 0 sprzed zmiany: kwota jest, procent nie', () => {
    const r = summarizeDayChange([pos('A.WA', 100)], 50, 'PLN');
    expect(r?.change).toBe(100);
    expect(r?.changePct).toBeNull();
  });

  it('flaguje pozycje w walucie innej niż bazowa', () => {
    const r = summarizeDayChange([pos('AAPL', 120, 'USD', 30)], 4120, 'PLN');
    expect(r?.hasForeignPositions).toBe(true);
    expect(r?.change).toBe(120);
  });

  it('baza inna niż PLN: kwota natywna, procent z PLN', () => {
    const r = summarizeDayChange([pos('AAPL', 120, 'USD', 30)], 4120, 'USD');
    expect(r?.currency).toBe('USD');
    expect(r?.change).toBe(30);
    expect(r?.changePct).toBeCloseTo(3, 10);
    expect(r?.hasForeignPositions).toBe(false);
  });

  it('lista brakujących tickerów jest przycięta, licznik nie', () => {
    const many = Array.from({ length: 30 }, (_, i) => pos(`T${i}`, null));
    const r = summarizeDayChange(many, 1000, 'PLN');
    expect(r?.missingTickers).toHaveLength(20);
    expect(r?.totalCount).toBe(30);
  });
});

describe('pickPreviousClose', () => {
  const rows = [
    { date: '2026-11-04', close: 10 },
    { date: '2026-11-05', close: 11 },
    { date: '2026-11-06', close: 12 },
  ];

  it('bierze ostatni kurs SPRZED dnia sesji', () => {
    expect(pickPreviousClose(rows, '2026-11-09')).toBe(12);
    // Cache zawiera już dzisiejszą sesję → wczorajszy, nie dzisiejszy.
    expect(pickPreviousClose(rows, '2026-11-06')).toBe(11);
  });

  it('nie zależy od kolejności wierszy', () => {
    expect(pickPreviousClose([...rows].reverse(), '2026-11-09')).toBe(12);
  });

  it('kurs starszy niż tydzień to brak danych, nie przybliżenie', () => {
    expect(pickPreviousClose(rows, '2026-11-20')).toBeNull();
    expect(pickPreviousClose(rows, '2026-11-13')).toBe(12);
  });

  it('pusta historia, same przyszłe wiersze, zła data → null', () => {
    expect(pickPreviousClose([], '2026-11-09')).toBeNull();
    expect(pickPreviousClose(rows, '2026-11-04')).toBeNull();
    expect(pickPreviousClose(rows, 'bzdura')).toBeNull();
  });
});

describe('lastWeekdayIso', () => {
  it('dzień roboczy zostaje, weekend cofa się do piątku', () => {
    expect(lastWeekdayIso(new Date('2026-11-09T10:00:00Z'))).toBe('2026-11-09'); // pon.
    expect(lastWeekdayIso(new Date('2026-11-06T22:00:00Z'))).toBe('2026-11-06'); // pt.
    expect(lastWeekdayIso(new Date('2026-11-07T08:00:00Z'))).toBe('2026-11-06'); // sob.
    expect(lastWeekdayIso(new Date('2026-11-08T23:59:00Z'))).toBe('2026-11-06'); // niedz.
  });
});
