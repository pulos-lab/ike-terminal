import { describe, it, expect } from 'vitest';
import type { FxExchangeRecord } from 'shared';
import {
  pairOf,
  directionOf,
  baseAmount,
  exchangeRate,
  aggregateByDay,
  buildAvgRateLedger,
  markerSize,
} from '../fx-chart-data';

/** Rekord jak z extractFxExchanges — pole `rate` celowo bywa w obu konwencjach. */
function ex(over: Partial<FxExchangeRecord>): FxExchangeRecord {
  return {
    date: '2026-01-10',
    pair: 'USD/PLN',
    rate: 4,
    amountFrom: 4000,
    currencyFrom: 'PLN',
    amountTo: 1000,
    currencyTo: 'USD',
    source: 'ibkr',
    ...over,
  };
}

describe('pairOf', () => {
  it('dopasowuje po zbiorze walut — konwencja bossy (fx_pair "PLN/USD") i IBKR ("USD/PLN")', () => {
    // bossa: pair = kierunek PLN→USD
    expect(pairOf(ex({ pair: 'PLN/USD', currencyFrom: 'PLN', currencyTo: 'USD' }))).toBe('USDPLN');
    // IBKR: pair = para rynkowa, kierunek odwrotny (sprzedaż USD)
    expect(
      pairOf(
        ex({
          pair: 'USD/PLN',
          currencyFrom: 'USD',
          currencyTo: 'PLN',
          amountFrom: 1000,
          amountTo: 4000,
        }),
      ),
    ).toBe('USDPLN');
    expect(
      pairOf(ex({ currencyFrom: 'EUR', currencyTo: 'USD', amountFrom: 100, amountTo: 110 })),
    ).toBe('USDEUR');
    expect(pairOf(ex({ currencyFrom: 'PLN', currencyTo: 'EUR' }))).toBe('EURPLN');
    // Para spoza wykresów (GBP)
    expect(pairOf(ex({ currencyFrom: 'PLN', currencyTo: 'GBP' }))).toBeNull();
  });
});

describe('exchangeRate / directionOf / baseAmount', () => {
  it('kurs liczony z KWOT, nie z pola rate — obie konwencje dają to samo', () => {
    // bossa: PLN→USD, rate = 4.1367 (kurs pary)
    const bossa = ex({
      currencyFrom: 'PLN',
      currencyTo: 'USD',
      amountFrom: 7400,
      amountTo: 1788.87,
      rate: 4.1367,
    });
    // ręczny dialog mógłby zapisać rate=0.2417 (amountFrom/amountTo) — kwoty te same
    const manual = ex({ ...bossa, rate: 7400 / 1788.87, source: 'manual' });
    expect(exchangeRate(bossa, 'USDPLN')).toBeCloseTo(4.1367, 3);
    expect(exchangeRate(manual, 'USDPLN')).toBeCloseTo(4.1367, 3);
    expect(directionOf(bossa, 'USDPLN')).toBe('buy');
    expect(baseAmount(bossa, 'USDPLN')).toBeCloseTo(1788.87);
  });

  it('sprzedaż USD (IBKR USD→PLN): ten sam kurs, kierunek sell', () => {
    const sell = ex({
      currencyFrom: 'USD',
      currencyTo: 'PLN',
      amountFrom: 10260,
      amountTo: 40773.75,
      rate: 3.97405,
    });
    expect(exchangeRate(sell, 'USDPLN')).toBeCloseTo(3.97405, 4);
    expect(directionOf(sell, 'USDPLN')).toBe('sell');
    expect(baseAmount(sell, 'USDPLN')).toBe(10260);
  });

  it('USDEUR: kurs = EUR za 1 USD niezależnie od kierunku', () => {
    const eurToUsd = ex({
      currencyFrom: 'EUR',
      currencyTo: 'USD',
      amountFrom: 400,
      amountTo: 453.08,
      rate: 1.1327,
    });
    expect(exchangeRate(eurToUsd, 'USDEUR')).toBeCloseTo(400 / 453.08, 6);
    expect(directionOf(eurToUsd, 'USDEUR')).toBe('buy');
  });

  it('zerowe kwoty → null (bez dzielenia przez zero)', () => {
    expect(exchangeRate(ex({ amountTo: 0 }), 'USDPLN')).toBeNull();
  });
});

describe('aggregateByDay', () => {
  it('skleja wymiany z jednego dnia i kierunku, kurs ważony kwotą', () => {
    const exchanges = [
      ex({ date: '2026-01-10', amountFrom: 4000, amountTo: 1000 }), // 4.00
      ex({ date: '2026-01-10', amountFrom: 420, amountTo: 100 }), // 4.20 (resztówka)
      ex({ date: '2026-01-11', amountFrom: 4000, amountTo: 1000 }),
    ];
    const aggs = aggregateByDay(exchanges, 'USDPLN');
    expect(aggs).toHaveLength(2);
    expect(aggs[0].date).toBe('2026-01-10');
    expect(aggs[0].amountBase).toBe(1100);
    // (1000·4.00 + 100·4.20) / 1100
    expect(aggs[0].rate).toBeCloseTo(4.01818, 4);
    expect(aggs[0].exchanges).toHaveLength(2);
  });

  it('przeciwne kierunki tego samego dnia NIE są sklejane; obce pary odpadają', () => {
    const exchanges = [
      ex({ date: '2026-01-10' }), // buy USD
      ex({
        date: '2026-01-10',
        currencyFrom: 'USD',
        currencyTo: 'PLN',
        amountFrom: 500,
        amountTo: 2000,
      }), // sell USD
      ex({ date: '2026-01-10', currencyFrom: 'PLN', currencyTo: 'EUR' }), // EURPLN
    ];
    const aggs = aggregateByDay(exchanges, 'USDPLN');
    expect(aggs).toHaveLength(2);
    expect(aggs.map((a) => a.direction).sort()).toEqual(['buy', 'sell']);
  });

  it('data ISO z częścią czasu (bossa "2023-08-29T00:00:00") → dzień kalendarzowy', () => {
    const aggs = aggregateByDay([ex({ date: '2023-08-29T00:00:00' })], 'USDPLN');
    expect(aggs[0].date).toBe('2023-08-29');
  });
});

describe('buildAvgRateLedger', () => {
  const dates = ['2026-01-09', '2026-01-10', '2026-01-13', '2026-01-14'];

  it('kupno ustawia średnią, kolejne kupno ją przesuwa, sprzedaż nie zmienia', () => {
    const aggs = aggregateByDay(
      [
        ex({ date: '2026-01-10', amountFrom: 4000, amountTo: 1000 }), // buy 1000 @ 4.00
        ex({ date: '2026-01-13', amountFrom: 4400, amountTo: 1000 }), // buy 1000 @ 4.40
        ex({
          date: '2026-01-14',
          currencyFrom: 'USD',
          currencyTo: 'PLN',
          amountFrom: 500,
          amountTo: 2500,
        }), // sell 500 — średnia zostaje
      ],
      'USDPLN',
    );
    const ledger = buildAvgRateLedger(aggs, dates);
    expect(ledger).toHaveLength(4);
    expect(ledger[0].value).toBeUndefined(); // przed pierwszym kupnem
    expect(ledger[1].value).toBeCloseTo(4.0);
    expect(ledger[2].value).toBeCloseTo(4.2); // (1000·4 + 1000·4.4)/2000
    expect(ledger[3].value).toBeCloseTo(4.2);
  });

  it('wyprzedanie całości → przerwa (whitespace), po niej nowa średnia', () => {
    const aggs = aggregateByDay(
      [
        ex({ date: '2026-01-09', amountFrom: 4000, amountTo: 1000 }),
        ex({
          date: '2026-01-10',
          currencyFrom: 'USD',
          currencyTo: 'PLN',
          amountFrom: 1000,
          amountTo: 4100,
        }),
        ex({ date: '2026-01-13', amountFrom: 4300, amountTo: 1000 }),
      ],
      'USDPLN',
    );
    const ledger = buildAvgRateLedger(aggs, dates);
    expect(ledger[0].value).toBeCloseTo(4.0);
    expect(ledger[1].value).toBeUndefined(); // saldo 0
    expect(ledger[2].value).toBeCloseTo(4.3);
  });

  it('sprzedaż bez wcześniejszego kupna (import od środka historii) → bez ujemnych sald', () => {
    const aggs = aggregateByDay(
      [
        ex({
          date: '2026-01-09',
          currencyFrom: 'USD',
          currencyTo: 'PLN',
          amountFrom: 1000,
          amountTo: 4000,
        }),
        ex({ date: '2026-01-13', amountFrom: 4100, amountTo: 1000 }),
      ],
      'USDPLN',
    );
    const ledger = buildAvgRateLedger(aggs, dates);
    expect(ledger[0].value).toBeUndefined();
    expect(ledger[2].value).toBeCloseTo(4.1);
  });
});

describe('markerSize', () => {
  it('sqrt-scale w [0.6, 1.4]; max → 1.4, brak max → 1', () => {
    expect(markerSize(10000, 10000)).toBeCloseTo(1.4);
    expect(markerSize(2500, 10000)).toBeCloseTo(1.0); // sqrt(0.25)=0.5 → 0.6+0.4
    expect(markerSize(0.36, 10000)).toBeLessThan(0.62);
    expect(markerSize(100, 0)).toBe(1);
  });
});
