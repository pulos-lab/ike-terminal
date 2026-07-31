import { describe, it, expect } from 'vitest';
import { planFix } from '../fix-mbank-fx-commission.js';

/**
 * Liczby pochodzą z PRODUKCJI (2 portfele, 7 wierszy walutowych) plus kursy
 * USDPLN z cache'u aplikacji na te same dni. Test pilnuje, żeby skrypt
 * naprawczy zachował się dokładnie tak, jak wyliczyliśmy przy diagnozie.
 */
describe('planFix — odtworzenie kursu rozliczenia mBanku', () => {
  it('A: prowizja to realne 0,29% kwoty w PLN → kurs z taryfy', () => {
    // MICRON TECH 2026-05-11, 3 × 771,00 USD, prowizja 24,15 PLN; rynek 3,59595
    const plan = planFix(
      { side: 'K', quantity: 3, price: 771, value: 2313, commission: 24.15 },
      3.59595,
    )!;

    expect(plan.how).toBe('tariff');
    expect(plan.fxRate).toBeCloseTo(3.6003, 3); // 0,12% od kursu rynkowego
    expect(plan.commission).toBeCloseTo(6.71, 2); // 24,15 PLN → USD
    expect(plan.total).toBeCloseTo(2319.71, 2);
  });

  it('B: w polu prowizji siedzi kwota rozliczenia → kurs z niej, prowizja zerowana', () => {
    // MICRON TECH 2026-05-12, 4 × 721,00 USD, „prowizja" 10 464,02; rynek 3,62195.
    // Ślad po parserze sprzed 2026-06-10, który zgadywał indeks kolumny.
    const plan = planFix(
      { side: 'K', quantity: 4, price: 721, value: 2884, commission: 10464.02 },
      3.62195,
    )!;

    expect(plan.how).toBe('settlement-in-commission');
    expect(plan.fxRate).toBeCloseTo(3.6283, 4);
    expect(plan.commission).toBe(0);
    expect(plan.total).toBe(2884); // było 13 348,02 „USD"
  });

  it('C: prowizja minimalna → kurs rynkowy, bo taryfy nie da się odwrócić', () => {
    // PALANTIR 2026-06-09, 2 × 134,80 USD, prowizja 14,00 PLN (minimum); rynek 3,6741.
    // Odwrócenie taryfy dałoby kurs 17,9 — bez sensu, więc fallback.
    const plan = planFix(
      { side: 'K', quantity: 2, price: 134.8, value: 269.6, commission: 14 },
      3.6741,
    )!;

    expect(plan.how).toBe('market-fallback');
    expect(plan.fxRate).toBeCloseTo(3.6741, 4);
    expect(plan.commission).toBeCloseTo(3.81, 2); // było 14,00 traktowane jako USD
    expect(plan.total).toBeCloseTo(273.41, 2);
  });

  it('sprzedaż: prowizja pomniejsza total', () => {
    // UBER 2026-05-11, S, 20 × 75,36 USD, prowizja 15,71 PLN; rynek 3,59595
    const plan = planFix(
      { side: 'S', quantity: 20, price: 75.36, value: 1507.2, commission: 15.71 },
      3.59595,
    )!;

    expect(plan.how).toBe('tariff');
    expect(plan.total).toBeLessThan(1507.2);
  });

  it('prowizja zero → nie ma czego poprawiać', () => {
    expect(
      planFix({ side: 'K', quantity: 101, price: 114.02, value: 11516.02, commission: 0 }, 3.64349),
    ).toBeNull();
  });

  it('jest idempotentny: druga runda na już poprawionym wierszu nic nie psuje', () => {
    // Po naprawie prowizja jest w walucie notowania, a `fx_rate` wypełniony —
    // zapytanie skryptu (fx_rate IS NULL) już takiego wiersza nie zwróci.
    // Gdyby jednak trafił, taryfa nie zadziała (prowizja w USD, nie w PLN),
    // a fallback zostawi wartości bliskie oryginałowi — bez katastrofy.
    const first = planFix(
      { side: 'K', quantity: 3, price: 771, value: 2313, commission: 24.15 },
      3.59595,
    )!;
    const second = planFix(
      { side: 'K', quantity: 3, price: 771, value: 2313, commission: first.commission },
      3.59595,
    )!;
    expect(second.how).toBe('market-fallback');
    expect(second.commission).toBeLessThan(first.commission);
  });
});
