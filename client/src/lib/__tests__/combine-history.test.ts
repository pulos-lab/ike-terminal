import { describe, it, expect } from 'vitest';
import type { PortfolioHistoryPoint } from 'shared';
import { combineHistories, toPlnSeries, type CombineSource } from '../combine-history';

/** Punkt historii — tylko pola istotne dla testu, reszta wyzerowana. */
function point(
  overrides: Partial<PortfolioHistoryPoint> & { date: string },
): PortfolioHistoryPoint {
  return {
    portfolioValue: 0,
    returnPct: 0,
    twrPct: 0,
    benchmarkValue: 0,
    benchmarkReturnPct: 0,
    benchmarkTwrPct: 0,
    investedCumulative: 0,
    cumulativeDepositsPln: 0,
    cumulativeWithdrawalsPln: 0,
    ...overrides,
  };
}

/** Seria z wygodnym opisem: [data, wartość, skum. wpłaty, skum. wypłaty]. */
function series(
  rows: Array<[string, number, number, number?]>,
  extra: (
    row: [string, number, number, number?],
    i: number,
  ) => Partial<PortfolioHistoryPoint> = () => ({}),
): PortfolioHistoryPoint[] {
  return rows.map((r, i) =>
    point({
      date: r[0],
      portfolioValue: r[1],
      cumulativeDepositsPln: r[2],
      cumulativeWithdrawalsPln: r[3] ?? 0,
      ...extra(r, i),
    }),
  );
}

function src(points: PortfolioHistoryPoint[], baseCurrency = 'PLN'): CombineSource {
  return { points, baseCurrency };
}

/** MWR silnika: ((V + W − D) / D) × 100. */
function mwr(v: number, d: number, w = 0): number {
  return ((v + w - d) / d) * 100;
}

describe('combineHistories — sumy i MWR', () => {
  it('sumuje wartości i przepływy, a stopę zwrotu liczy wzorem silnika', () => {
    const a = series([
      ['2025-01-01', 1000, 1000],
      ['2025-01-02', 1100, 1000],
    ]);
    const b = series([
      ['2025-01-01', 500, 500],
      ['2025-01-02', 480, 500],
    ]);

    const out = combineHistories([src(a), src(b)]);

    expect(out).toHaveLength(2);
    expect(out[1].portfolioValue).toBe(1580);
    expect(out[1].cumulativeDepositsPln).toBe(1500);
    // 1580 na 1500 wpłaconych = +5.33%, między +10% portfela A a −4% portfela B.
    expect(out[1].returnPct).toBeCloseTo(mwr(1580, 1500), 10);
    expect(out[1].returnPct).toBeGreaterThan(-4);
    expect(out[1].returnPct).toBeLessThan(10);
  });

  it('uwzględnia wypłaty w liczniku (wypłacone pieniądze nie znikają z wyniku)', () => {
    const a = series([
      ['2025-01-01', 1000, 1000],
      ['2025-01-02', 400, 1000, 700],
    ]);
    const b = series([
      ['2025-01-01', 1000, 1000],
      ['2025-01-02', 1000, 1000],
    ]);

    const out = combineHistories([src(a), src(b)]);
    expect(out[1].returnPct).toBeCloseTo(mwr(1400, 2000, 700), 10);
  });

  it('pojedyncza seria wraca bez zmian (nie ma czego sumować)', () => {
    const a = series([['2025-01-01', 100, 100]]);
    expect(combineHistories([src(a)])).toEqual(a);
    expect(combineHistories([])).toEqual([]);
  });
});

describe('combineHistories — różne zakresy dat', () => {
  it('portfel dołączający później nie wnosi nic przed swoim startem', () => {
    const a = series([
      ['2025-01-01', 1000, 1000],
      ['2025-01-02', 1000, 1000],
      ['2025-01-03', 1000, 1000],
    ]);
    const b = series([['2025-01-03', 300, 300]]);

    const out = combineHistories([src(a), src(b)]);

    expect(out.map((p) => p.date)).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
    expect(out[0].portfolioValue).toBe(1000);
    expect(out[1].portfolioValue).toBe(1000);
    expect(out[2].portfolioValue).toBe(1300);
    expect(out[2].cumulativeDepositsPln).toBe(1300);
  });

  it('seria zaczyna się od najwcześniejszej daty niezależnie od kolejności wejść', () => {
    const early = series([['2025-01-01', 100, 100]]);
    const late = series([['2025-02-01', 50, 50]]);
    const out = combineHistories([src(late), src(early)]);
    expect(out[0].date).toBe('2025-01-01');
  });

  it('portfel ZAMKNIĘTY (urwana historia) wnosi wkład także po ostatnim punkcie', () => {
    // Silnik przerywa generowanie historii portfela bez pozycji — zamknięty rachunek
    // nie może przez to zniknąć z sumy wpłat i wypłat.
    const closed = series([
      ['2025-01-01', 1000, 1000],
      ['2025-01-02', 0, 1000, 1200], // sprzedane i wypłacone: +200 zysku
    ]);
    const open = series([
      ['2025-01-01', 500, 500],
      ['2025-01-02', 500, 500],
      ['2025-01-03', 600, 500],
    ]);

    const out = combineHistories([src(closed), src(open)]);

    expect(out).toHaveLength(3);
    const last = out[2];
    expect(last.portfolioValue).toBe(600);
    expect(last.cumulativeDepositsPln).toBe(1500);
    expect(last.cumulativeWithdrawalsPln).toBe(1200);
    expect(last.returnPct).toBeCloseTo(mwr(600, 1500, 1200), 10);
  });
});

describe('combineHistories — TWR', () => {
  it('dzień czystej wpłaty nie tworzy zwrotu', () => {
    const a = series([
      ['2025-01-01', 1000, 1000],
      ['2025-01-02', 2000, 2000], // +1000 wpłaty, zero ruchu rynku
    ]);
    const b = series([
      ['2025-01-01', 1000, 1000],
      ['2025-01-02', 1000, 1000],
    ]);

    const out = combineHistories([src(a), src(b)]);
    expect(out[1].twrPct).toBeCloseTo(0, 10);
  });

  it('łańcuchuje dzienne zwroty, izolując je od wpłat', () => {
    const a = series([
      ['2025-01-01', 1000, 1000],
      ['2025-01-02', 1100, 1000], // +10%
      ['2025-01-03', 2100, 2000], // wpłata 1000, rynek bez ruchu (1100 + 1000)
      ['2025-01-04', 2310, 2000], // +10%
    ]);
    const b = series([
      ['2025-01-01', 0, 0],
      ['2025-01-02', 0, 0],
      ['2025-01-03', 0, 0],
      ['2025-01-04', 0, 0],
    ]);

    const out = combineHistories([src(a), src(b)]);
    // 1.10 × 1.00 × 1.10 = 1.21
    expect(out[3].twrPct).toBeCloseTo(21, 6);
  });

  it('zamraża łańcuch, gdy wartość spada poniżej 5% szczytu (bramka silnika)', () => {
    const a = series([
      ['2025-01-01', 1000, 1000],
      ['2025-01-02', 1200, 1000],
      ['2025-01-03', 1, 1000, 1150], // praktycznie zlikwidowany
      ['2025-01-04', 2, 1000, 1150], // ×2 na resztówce — nie może dać +100%
    ]);
    const b = series([['2025-01-01', 0, 0]]);

    const out = combineHistories([src(a), src(b)]);
    const frozen = out[1].twrPct;
    expect(out[2].twrPct).toBeCloseTo(frozen, 10);
    expect(out[3].twrPct).toBeCloseTo(frozen, 10);
  });
});

describe('combineHistories — indeks benchmarku', () => {
  it('bierze indeks z serii startującej najwcześniej (jej start = start sumy)', () => {
    const early = series([
      ['2025-01-01', 100, 100],
      ['2025-01-02', 100, 100],
    ]).map((p, i) => ({ ...p, benchmarkTwrPct: i === 0 ? 0 : 8 }));
    // Portfel dołączający później ma WŁASNĄ bazę indeksu (u niego 0% w dniu wejścia).
    const late = series([['2025-01-02', 50, 50]]).map((p) => ({ ...p, benchmarkTwrPct: 0 }));

    const out = combineHistories([src(early), src(late)]);
    expect(out[0].benchmarkTwrPct).toBeCloseTo(0, 10);
    expect(out[1].benchmarkTwrPct).toBeCloseTo(8, 10);
  });

  it('po urwaniu serii referencyjnej dokleja kolejną przez iloraz z dnia wspólnego', () => {
    // Referencja: dni 1–2, indeks 0% → +10%.
    const ref = series([
      ['2025-01-01', 100, 100],
      ['2025-01-02', 110, 100],
    ]).map((p, i) => ({ ...p, benchmarkTwrPct: i === 0 ? 0 : 10 }));
    // Druga seria wchodzi w dniu 2 z własną bazą: 0% w dniu 2, +5% w dniu 3.
    const other = series([
      ['2025-01-02', 50, 50],
      ['2025-01-03', 55, 50],
    ]).map((p, i) => ({ ...p, benchmarkTwrPct: i === 0 ? 0 : 5 }));

    const out = combineHistories([src(ref), src(other)]);

    expect(out[1].benchmarkTwrPct).toBeCloseTo(10, 10);
    // Indeks sumy: 1.10 × 1.05 = 1.155 → +15.5%
    expect(out[2].benchmarkTwrPct).toBeCloseTo(15.5, 6);
  });

  it('nie skleja indeksu między portfelami o różnych walutach bazowych', () => {
    const ref = series([
      ['2025-01-01', 100, 100],
      ['2025-01-02', 110, 100],
    ]).map((p, i) => ({ ...p, benchmarkTwrPct: i === 0 ? 0 : 10 }));
    const usd = series([
      ['2025-01-02', 50, 50],
      ['2025-01-03', 55, 50],
    ]).map((p, i) => ({ ...p, benchmarkTwrPct: i === 0 ? 0 : 5 }));

    const out = combineHistories([src(ref), src(usd, 'USD')]);
    // Brak mostu o zgodnej bazie → ostatnia znana wartość zamiast zmyślonej sklejki.
    expect(out[2].benchmarkTwrPct).toBeCloseTo(10, 10);
  });
});

describe('toPlnSeries', () => {
  const usd = series([
    ['2025-01-01', 100, 100],
    ['2025-01-02', 110, 100],
  ]);

  it('bez mapy zwraca serię bez zmian (portfel PLN-owy)', () => {
    expect(toPlnSeries(usd, undefined)).toBe(usd);
  });

  it('mnoży kwoty kursem z dnia, zostawiając procenty nietknięte', () => {
    const out = toPlnSeries(usd, { '2025-01-01': 4, '2025-01-02': 5 });
    expect(out[0].portfolioValue).toBe(400);
    expect(out[0].cumulativeDepositsPln).toBe(400);
    expect(out[1].portfolioValue).toBe(550);
    expect(out[1].returnPct).toBe(usd[1].returnPct);
  });

  it('dziedziczy ostatni znany kurs w dniu bez notowania FX', () => {
    const out = toPlnSeries(usd, { '2025-01-01': 4 });
    expect(out[1].portfolioValue).toBe(440);
  });

  it('cofa pierwszy znany kurs na dni sprzed wpisu (nie traktuje ich jak PLN)', () => {
    const out = toPlnSeries(usd, { '2025-01-02': 5 });
    expect(out[0].portfolioValue).toBe(500);
  });

  it('mapa bez pokrycia serii nie zgaduje kursu', () => {
    expect(toPlnSeries(usd, { '2024-06-01': 4 })).toBe(usd);
  });
});

describe('combineHistories — waluty', () => {
  it('sumuje po przewalutowaniu: sub-konto USD dokłada wartość w złotówkach', () => {
    const pln = series([['2025-01-01', 1000, 1000]]);
    const usdRaw = series([['2025-01-01', 100, 100]]);
    const usd = toPlnSeries(usdRaw, { '2025-01-01': 4 });

    const out = combineHistories([src(pln), src(usd, 'USD')]);
    expect(out[0].portfolioValue).toBe(1400);
    expect(out[0].cumulativeDepositsPln).toBe(1400);
  });
});

describe('combineHistories — parytet z silnikiem (fixture z prawdziwego computePortfolioHistory)', () => {
  // Serie wyliczone realnym silnikiem dla dwóch portfeli gotówkowych i dla ich scalonego
  // zbioru operacji (scenariusz i dowód równoważności: server/src/services/__tests__/
  // combine-parity.test.ts). Tutaj pilnujemy, że TEN moduł odtwarza te same liczby —
  // gdyby ktoś uprościł wzór MWR albo bramkę TWR, test pokaże rozjazd z silnikiem.
  // Kolumny: [data, wartość, skum. wpłaty, skum. wypłaty, returnPct, twrPct].
  type Row = [string, number, number, number, number, number];

  const toPoints = (rows: Row[]): PortfolioHistoryPoint[] =>
    rows.map((r) =>
      point({
        date: r[0],
        portfolioValue: r[1],
        cumulativeDepositsPln: r[2],
        cumulativeWithdrawalsPln: r[3],
        returnPct: r[4],
        twrPct: r[5],
      }),
    );

  // Portfel A: wpłata 10000, dywidenda 300, dopłata 5000. Historia urywa się na ostatnim
  // przepływie (silnik nie liczy dywidend jako aktywności) — stąd koniec 05.01.
  const A = toPoints([
    ['2025-01-01', 10000, 10000, 0, 0, 0],
    ['2025-01-02', 10000, 10000, 0, 0, 0],
    ['2025-01-03', 10300, 10000, 0, 3, 3.0000000000000027],
    ['2025-01-04', 10300, 10000, 0, 3, 3.0000000000000027],
    ['2025-01-05', 15300, 15000, 0, 2, 3.0000000000000027],
  ]);

  // Portfel B: startuje 04.01, dywidenda 120, wypłata 1000 na koniec.
  const B = toPoints([
    ['2025-01-04', 4000, 4000, 0, 0, 0],
    ['2025-01-05', 4000, 4000, 0, 0, 0],
    ['2025-01-06', 4120, 4000, 0, 3, 3.0000000000000027],
    ['2025-01-07', 4120, 4000, 0, 3, 3.0000000000000027],
    ['2025-01-08', 3120, 4000, 1000, 3, 3.0000000000000027],
  ]);

  // Silnik puszczony na SUMIE operacji obu portfeli — wzorzec, do którego mamy dojść.
  const MERGED = toPoints([
    ['2025-01-01', 10000, 10000, 0, 0, 0],
    ['2025-01-02', 10000, 10000, 0, 0, 0],
    ['2025-01-03', 10300, 10000, 0, 3, 3.0000000000000027],
    ['2025-01-04', 14300, 14000, 0, 2.142857142857143, 3.0000000000000027],
    ['2025-01-05', 19300, 19000, 0, 1.5789473684210527, 3.0000000000000027],
    ['2025-01-06', 19420, 19000, 0, 2.2105263157894735, 3.6404145077720385],
    ['2025-01-07', 19420, 19000, 0, 2.2105263157894735, 3.6404145077720385],
    ['2025-01-08', 18420, 19000, 1000, 2.2105263157894735, 3.6404145077720385],
  ]);

  it('odtwarza historię, którą silnik policzyłby na scalonym portfelu', () => {
    const out = combineHistories([src(A), src(B)]);

    expect(out.map((p) => p.date)).toEqual(MERGED.map((p) => p.date));
    for (let i = 0; i < MERGED.length; i++) {
      expect(out[i].portfolioValue).toBeCloseTo(MERGED[i].portfolioValue, 8);
      expect(out[i].cumulativeDepositsPln).toBeCloseTo(MERGED[i].cumulativeDepositsPln, 8);
      expect(out[i].cumulativeWithdrawalsPln).toBeCloseTo(MERGED[i].cumulativeWithdrawalsPln, 8);
      expect(out[i].returnPct).toBeCloseTo(MERGED[i].returnPct, 8);
      expect(out[i].twrPct).toBeCloseTo(MERGED[i].twrPct, 8);
    }
  });

  it('MWR sumy leży między MWR składowych (niezależna kontrola wyniku)', () => {
    const out = combineHistories([src(A), src(B)]);
    const last = out[out.length - 1];
    // A na koniec: +2%, B: +3% → suma musi wypaść pomiędzy, bo MWR łączny jest średnią
    // ważoną wpłatami. Wyjście poza ten przedział oznaczałoby błąd sumowania.
    expect(last.returnPct).toBeGreaterThan(2);
    expect(last.returnPct).toBeLessThan(3);
  });
});
