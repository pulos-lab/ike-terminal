import { describe, it, expect } from 'vitest';
import type { Transaction, TickerMapEntry } from 'shared';
import {
  findSeriesSplitJumps,
  detectSplitsFromPriceSeries,
  normalizeUnadjustedProviderSeries,
  adjustTransactionsForSplits,
} from '../split-detector.js';

/**
 * Przypadek referencyjny: Invesco S&P 500 UCITS ETF (P500.DE), split 100:1
 * z 2025-12-15. Yahoo nie zna zdarzenia i NIE skorygował historii — w serii siedzi
 * surowy skok 1157,40 → 11,57 (`adjclose == close`, `events` puste). Liczby cen
 * i transakcji pochodzą z produkcji (portfel zgłaszającego, 2026-08-06).
 */

/** Buduje serię dzienną (pon-pt) od `start`, o zadanych cenach kolejnych sesji. */
function series(start: string, prices: number[]): Map<string, number> {
  const map = new Map<string, number>();
  const d = new Date(`${start}T00:00:00Z`);
  for (const price of prices) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    map.set(d.toISOString().slice(0, 10), price);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return map;
}

const P500_ENTRY: TickerMapEntry = {
  isin: 'P500.DE',
  ticker: 'P500.DE',
  name: 'Invesco S&P 500 UCITS ETF',
  exchange: 'XETRA',
  currency: 'EUR',
  priceSource: 'yahoo',
};

function tx(partial: Partial<Transaction>): Transaction {
  return {
    date: '2025-02-14T00:00:00',
    paperName: 'P500.DE',
    isin: 'P500.DE',
    quantity: 1,
    side: 'K',
    price: 1000,
    value: 1000,
    commission: 0,
    total: 1000,
    currency: 'EUR',
    category: 'stock',
    ...partial,
  } as Transaction;
}

describe('findSeriesSplitJumps — skok w nieskorygowanej serii providera', () => {
  it('łapie split 100:1 P500.DE z dokładną ex-datą', () => {
    const prices = series('2025-12-08', [1160, 1155, 1158, 1157.4, 11.5705, 11.6, 11.55, 11.7]);
    const jumps = findSeriesSplitJumps(prices);

    expect(jumps).toHaveLength(1);
    expect(jumps[0].ratio).toBe(100);
    // Ex-date = pierwszy dzień notowań w NOWEJ skali, nie ostatni w starej.
    expect(jumps[0].date).toBe('2025-12-12');
    expect(jumps[0].priceBefore).toBeCloseTo(1157.4);
  });

  it('NIE uznaje krachu −50% za split 2:1 (próg 10×)', () => {
    // To jest dokładnie klasa fałszywek, którą przepuszczałby próg 1,75 z propozycji
    // zgłaszającego: ROUND(2.0 * 2)/2 = 2.0 → „split 2:1" z każdego zawału o połowę.
    const prices = series('2026-01-05', [100, 98, 99, 49, 48, 50, 47]);
    expect(findSeriesSplitJumps(prices)).toEqual([]);
  });

  it('NIE uznaje krachu −85% za split (ratio spoza znanych, snap poza tolerancją)', () => {
    const prices = series('2026-01-05', [100, 98, 99, 14.8, 15.1, 14.2, 15.5]);
    expect(findSeriesSplitJumps(prices)).toEqual([]);
  });

  it('odrzuca błędny print — cena wraca do starej skali', () => {
    const prices = series('2026-01-05', [1000, 1010, 10.1, 1005, 1002, 1008]);
    expect(findSeriesSplitJumps(prices)).toEqual([]);
  });

  it('odrzuca skok przez dziurę w danych (nie jest zdarzeniem jednodniowym)', () => {
    const prices = new Map([
      ['2025-09-01', 1000],
      ['2025-12-15', 9.9], // 3,5 miesiąca przerwy
      ['2025-12-16', 10.1],
      ['2025-12-17', 10.0],
    ]);
    expect(findSeriesSplitJumps(prices)).toEqual([]);
  });

  it('łapie reverse split 1:20 (kierunek odwrotny)', () => {
    const prices = series('2026-02-02', [0.5, 0.52, 0.49, 9.8, 10.1, 9.9, 10.2]);
    const jumps = findSeriesSplitJumps(prices);
    expect(jumps).toHaveLength(1);
    expect(jumps[0].ratio).toBeCloseTo(1 / 20);
  });

  it('odwracający się skok to rozjazd JEDNOSTKI (pensy/funty), nie split', () => {
    // Realne dane LTSV.L z produkcji: seria skacze 2564 → 25,70, potem wraca
    // 26,11 → 2628 i tak kilka razy. Split jest trwały; to jest zmiana jednostki.
    const prices = series(
      '2025-07-07',
      [2550, 2564, 25.7, 25.9, 26.11, 2628, 2650, 2640, 2655, 2660],
    );
    expect(findSeriesSplitJumps(prices)).toEqual([]);
  });

  it('pojedynczy, nieodwrócony skok nadal jest splitem (P500.DE się broni)', () => {
    const prices = series('2025-12-08', [1160, 1155, 1158, 1157.4, 11.5705, 11.6, 11.55, 11.7]);
    expect(findSeriesSplitJumps(prices)).toHaveLength(1);
  });

  it('seria SKORYGOWANA przez providera nie daje żadnych skoków', () => {
    const prices = series('2025-12-08', [11.6, 11.55, 11.58, 11.574, 11.5705, 11.6, 11.55]);
    expect(findSeriesSplitJumps(prices)).toEqual([]);
  });
});

describe('detectSplitsFromPriceSeries — wpięcie w model transakcji', () => {
  const prices = series('2025-12-08', [1160, 1155, 1158, 1157.4, 11.5705, 11.6, 11.55, 11.7]);

  it('zwraca split dla papieru z transakcjami', () => {
    const found = detectSplitsFromPriceSeries(
      [tx({})],
      new Map([['P500.DE', prices]]),
      new Map([['P500.DE', P500_ENTRY]]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ isin: 'P500.DE', ticker: 'P500.DE', ratio: 100 });
  });

  it('pomija obligacje i opcje (kursy w % nominału / wartość wewnętrzna skaczą bez splitu)', () => {
    for (const category of ['bond', 'option'] as const) {
      const found = detectSplitsFromPriceSeries(
        [tx({ category })],
        new Map([['P500.DE', prices]]),
        new Map([['P500.DE', P500_ENTRY]]),
      );
      expect(found).toEqual([]);
    }
  });
});

describe('normalizeUnadjustedProviderSeries — dokończenie korekty za providera', () => {
  it('dzieli odcinek sprzed ex-date, zostawia resztę', () => {
    const prices = series('2025-12-08', [1160, 1155, 1158, 1157.4, 11.5705, 11.6, 11.55, 11.7]);
    const split = {
      ticker: 'P500.DE',
      isin: 'P500.DE',
      date: '2025-12-12',
      ratio: 100,
      txPrice: 1157.4,
      providerPrice: 11.5705,
      source: 'auto' as const,
    };

    const applied = normalizeUnadjustedProviderSeries(new Map([['P500.DE', prices]]), [split]);

    expect(applied).toHaveLength(1);
    expect(prices.get('2025-12-11')).toBeCloseTo(11.574); // 1157,4 / 100
    expect(prices.get('2025-12-12')).toBeCloseTo(11.5705); // ex-date bez zmian
    expect(prices.get('2025-12-15')).toBeCloseTo(11.6);
  });

  it('NIE rusza serii, którą provider już skorygował (brak skoku = brak dowodu)', () => {
    const prices = series('2025-12-08', [11.6, 11.55, 11.58, 11.574, 11.5705, 11.6, 11.55]);
    const before = new Map(prices);

    const applied = normalizeUnadjustedProviderSeries(new Map([['P500.DE', prices]]), [
      {
        ticker: 'P500.DE',
        isin: 'P500.DE',
        date: '2025-12-12',
        ratio: 100,
        txPrice: 0,
        providerPrice: 0,
        source: 'auto' as const,
      },
    ]);

    expect(applied).toEqual([]);
    expect([...prices.entries()]).toEqual([...before.entries()]);
  });

  it('domyka rachunek: loty sprzed i po splicie wyceniają się w jednej skali', () => {
    // Realne dane portfela: 0,4742 szt. kupione przed splitem (~1100 EUR) i 8,58 szt.
    // po splicie (~13 EUR). Bez korekty portfel pokazywał 121,79 EUR zamiast 753,26.
    const prices = series('2025-12-08', [1160, 1155, 1158, 1157.4, 11.5705, 11.6, 11.55, 11.7]);
    const split = {
      ticker: 'P500.DE',
      isin: 'P500.DE',
      date: '2025-12-12',
      ratio: 100,
      txPrice: 1157.4,
      providerPrice: 11.5705,
      source: 'auto' as const,
    };
    const transactions = [
      tx({ date: '2025-12-11T00:00:00', quantity: 0.4742, price: 1106.39 }),
      tx({ date: '2025-12-15T00:00:00', quantity: 8.58, price: 13.01 }),
    ];

    normalizeUnadjustedProviderSeries(new Map([['P500.DE', prices]]), [split]);
    const adjusted = adjustTransactionsForSplits(transactions, [split]);

    const shares = adjusted.reduce((acc, t) => acc + t.quantity, 0);
    expect(shares).toBeCloseTo(56.0, 4); // 0,4742 × 100 + 8,58

    // Wycena historyczna DZIEŃ PRZED splitem: 47,42 szt. w skali po splicie razy
    // znormalizowana cena. Bez normalizacji serii wyszłoby 100× więcej.
    const sharesBeforeEx = adjusted
      .filter((t) => t.date.slice(0, 10) < '2025-12-12')
      .reduce((acc, t) => acc + t.quantity, 0);
    const valueBeforeEx = sharesBeforeEx * prices.get('2025-12-11')!;
    expect(valueBeforeEx).toBeCloseTo(0.4742 * 1157.4, 6); // tyle samo, co w starej skali
  });
});
