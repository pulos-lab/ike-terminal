import { describe, it, expect } from 'vitest';
import {
  applyDaySessions,
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

  it('pozycja ze starszej sesji ma dane, ale nie wchodzi do sumy dnia', () => {
    // 10:00: GPW +100 dziś, USA +400 z wczorajszej sesji (rynek jeszcze zamknięty).
    const r = summarizeDayChange(
      [pos('A.WA', 100), { ...pos('AAPL', 400, 'USD', 100), dailyChangeStale: true }],
      10_500,
      'PLN',
      '2026-11-24',
    );
    expect(r?.change).toBe(100);
    // Mianownik: wartość portfela sprzed DZISIEJSZEJ zmiany = 10 500 − 100.
    expect(r?.changePct).toBeCloseTo((100 / 10_400) * 100, 10);
    expect(r).toMatchObject({
      coveredCount: 2,
      totalCount: 2,
      missingTickers: [],
      staleCount: 1,
      staleTickers: ['AAPL'],
      sessionDate: '2026-11-24',
    });
  });

  it('bez podanego dnia sesji i bez flag: zachowanie jak dotąd', () => {
    const r = summarizeDayChange([pos('A.WA', 100)], 1100, 'PLN');
    expect(r).toMatchObject({ change: 100, sessionDate: null, staleCount: 0, staleTickers: [] });
  });
});

describe('applyDaySessions', () => {
  const pos = (
    ticker: string,
    exchange: string,
    session: string | undefined,
    change: number | null = 10,
  ) => ({
    ticker,
    exchange,
    dailyChangeValue: change,
    dailyChangeValuePln: change,
    dailyChangeSession: session,
    dailyChangeStale: undefined as boolean | undefined,
  });
  const stale = (list: ReturnType<typeof pos>[]) =>
    list.filter((p) => p.dailyChangeStale).map((p) => p.ticker);

  it('przed otwarciem USA: dzień sesji = GPW, pozycje z USA są z wczoraj', () => {
    const list = [
      pos('PKN.WA', 'GPW', '2026-11-24'),
      pos('AAPL', 'NASDAQ', '2026-11-23'),
      pos('NVDA', 'NASDAQ', '2026-11-23'),
    ];
    expect(applyDaySessions(list)).toBe('2026-11-24');
    expect(stale(list)).toEqual(['AAPL', 'NVDA']);
  });

  it('po otwarciu USA wszystko jest z tego samego dnia', () => {
    const list = [pos('PKN.WA', 'GPW', '2026-11-24'), pos('AAPL', 'NASDAQ', '2026-11-24')];
    expect(applyDaySessions(list)).toBe('2026-11-24');
    expect(stale(list)).toEqual([]);
  });

  it('przed 9:00 i w weekend: wspólna ostatnia sesja, nic nie odpada', () => {
    const list = [pos('PKN.WA', 'GPW', '2026-11-20'), pos('AAPL', 'NASDAQ', '2026-11-20')];
    expect(applyDaySessions(list)).toBe('2026-11-20');
    expect(stale(list)).toEqual([]);
  });

  it('święto GPW przy otwartych USA: to pozycje z GPW nie mają sesji tego dnia', () => {
    const list = [pos('PKN.WA', 'GPW', '2026-11-10'), pos('AAPL', 'NASDAQ', '2026-11-11')];
    expect(applyDaySessions(list)).toBe('2026-11-11');
    expect(stale(list)).toEqual(['PKN.WA']);
  });

  it('NC i Catalyst bez czasu notowania dziedziczą dzień po GPW', () => {
    const list = [
      pos('PKN.WA', 'GPW', '2026-11-20'),
      pos('NCX', 'NC', undefined),
      pos('BND1126', 'CATALYST', undefined),
      pos('BTC-USD', 'CCC', '2026-11-21'), // sobota: handluje tylko krypto
    ];
    expect(applyDaySessions(list)).toBe('2026-11-21');
    expect(list.map((p) => p.dailyChangeSession)).toEqual([
      '2026-11-20',
      '2026-11-20',
      '2026-11-20',
      '2026-11-21',
    ]);
    expect(stale(list)).toEqual(['PKN.WA', 'NCX', 'BND1126']);
  });

  it('pozycja bez daty i bez GPW w portfelu zawsze wchodzi do wyniku', () => {
    const list = [pos('NCX', 'NC', undefined), pos('AAPL', 'NASDAQ', '2026-11-23')];
    expect(applyDaySessions(list)).toBe('2026-11-23');
    expect(list[0].dailyChangeSession).toBeUndefined();
    expect(stale(list)).toEqual([]);
  });

  it('pozycja bez danych o zmianie nie wyznacza dnia sesji ani nie jest oznaczana', () => {
    const list = [
      pos('PKN.WA', 'GPW', '2026-11-23'),
      pos('XYZ', 'NASDAQ', '2026-11-24', null), // świeża data, ale brak zmiany
    ];
    expect(applyDaySessions(list)).toBe('2026-11-23');
    expect(stale(list)).toEqual([]);
  });

  it('żadnej daty notowania → null i brak oznaczeń', () => {
    const list = [pos('NCX', 'NC', undefined), pos('NCY', 'NC', undefined)];
    expect(applyDaySessions(list)).toBeNull();
    expect(stale(list)).toEqual([]);
  });

  it('ponowne wywołanie zdejmuje nieaktualną flagę', () => {
    const list = [pos('PKN.WA', 'GPW', '2026-11-24'), pos('AAPL', 'NASDAQ', '2026-11-23')];
    applyDaySessions(list);
    list[1].dailyChangeSession = '2026-11-24';
    applyDaySessions(list);
    expect(stale(list)).toEqual([]);
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
