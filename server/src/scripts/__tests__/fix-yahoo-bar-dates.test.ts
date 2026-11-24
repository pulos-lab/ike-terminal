import { describe, it, expect } from 'vitest';
import {
  isShiftedSeriesCandidate,
  planBarDateRepair,
  weekdayOf,
  type PriceRow,
} from '../fix-yahoo-bar-dates.js';

/** Sesje pon–pt 13–21.07.2026 pod datami sesji (tak datuje je kod po poprawce). */
const CORRECT: PriceRow[] = [
  { date: '2026-07-13', close: 3.79437 },
  { date: '2026-07-14', close: 3.80429 },
  { date: '2026-07-15', close: 3.78316 },
  { date: '2026-07-16', close: 3.76565 },
  { date: '2026-07-17', close: 3.77825 },
  { date: '2026-07-20', close: 3.79734 },
  { date: '2026-07-21', close: 3.79431 },
];

/** Te same sesje tak, jak zapisał je dawny kod: każda dzień wcześniej. */
const SHIFTED: PriceRow[] = [
  { date: '2026-07-12', close: 3.79437 }, // niedziela = sesja poniedziałkowa
  { date: '2026-07-13', close: 3.80429 },
  { date: '2026-07-14', close: 3.78316 },
  { date: '2026-07-15', close: 3.76565 },
  { date: '2026-07-16', close: 3.77825 }, // czwartek = sesja piątkowa
  { date: '2026-07-19', close: 3.79734 }, // niedziela = sesja poniedziałkowa
  { date: '2026-07-20', close: 3.79431 },
];

describe('isShiftedSeriesCandidate', () => {
  it('niedziele bez sobót = seria przesunięta', () => {
    expect(isShiftedSeriesCandidate({ sundays: 174, saturdays: 1 })).toBe(true);
  });

  it('rynek 7-dniowy (krypto) i seria bez niedziel nie są kandydatami', () => {
    expect(isShiftedSeriesCandidate({ sundays: 260, saturdays: 260 })).toBe(false);
    expect(isShiftedSeriesCandidate({ sundays: 0, saturdays: 0 })).toBe(false);
  });
});

describe('planBarDateRepair', () => {
  it('seria przesunięta: znikają niedziele, dochodzi piątek, kursy zmieniają dzień', () => {
    const plan = planBarDateRepair(SHIFTED, CORRECT);
    if (plan.kind !== 'replace') throw new Error(`oczekiwano podmiany, jest: ${plan.reason}`);

    // Usuwamy od dnia przed pierwszą świeżą sesją — tam leży jej przesunięty wiersz.
    expect(plan.deleteFrom).toBe('2026-07-12');
    expect(plan.deleted).toBe(7);
    expect(plan.inserted).toBe(7);
    expect(plan.keptOlder).toBe(0);
    expect(plan.weekendBefore).toBe(2);
    expect(plan.weekendAfter).toBe(0);
    expect(plan.datesRemoved).toBe(2); // 12.07 i 19.07
    expect(plan.datesAdded).toBe(2); // 17.07 i 21.07
    // 13–16.07 i 20.07 istnieją przed i po, ale niosą kurs innej sesji.
    expect(plan.valuesChanged).toBe(5);
    expect(plan.examples[0]).toEqual({ date: '2026-07-13', before: 3.80429, after: 3.79437 });
  });

  it('seria poprawna: ponowne pobranie niczego nie zmienia (idempotencja)', () => {
    const plan = planBarDateRepair(CORRECT, CORRECT);
    if (plan.kind !== 'replace') throw new Error(`oczekiwano podmiany, jest: ${plan.reason}`);

    expect(plan.datesRemoved).toBe(0);
    expect(plan.datesAdded).toBe(0);
    expect(plan.valuesChanged).toBe(0);
    expect(plan.weekendAfter).toBe(0);
  });

  it('nowszy ogon świeżej serii to same daty dochodzące', () => {
    const fresh = [...CORRECT, { date: '2026-07-22', close: 3.8 }];
    const plan = planBarDateRepair(CORRECT, fresh);
    if (plan.kind !== 'replace') throw new Error(`oczekiwano podmiany, jest: ${plan.reason}`);

    expect(plan.datesRemoved).toBe(0);
    expect(plan.datesAdded).toBe(1);
  });

  it('pusta odpowiedź Yahoo → seria zostaje nietknięta', () => {
    expect(planBarDateRepair(SHIFTED, [])).toEqual({
      kind: 'skip',
      reason: 'Yahoo oddało pustą serię',
    });
  });

  it('odpowiedź wyraźnie krótsza od zastanej serii → seria zostaje nietknięta', () => {
    // Yahoo oddało tylko początek zakresu: podmiana skasowałaby resztę historii.
    const plan = planBarDateRepair(SHIFTED, CORRECT.slice(0, 3));
    expect(plan.kind).toBe('skip');
  });

  it('nowszy ogon nie maskuje dziury w środku zakresu', () => {
    // 3 sesje z zakresu zastanej serii + długi ogon nowszych dat: łącznie wierszy
    // jest więcej niż zastanych, ale na wspólnym zakresie brakuje ponad połowy.
    const tail: PriceRow[] = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-08-${String(i + 3).padStart(2, '0')}`,
      close: 3.8,
    }));
    const plan = planBarDateRepair(SHIFTED, [...CORRECT.slice(0, 3), ...tail]);
    expect(plan.kind).toBe('skip');
  });

  it('wiersze starsze niż zasięg świeżej serii zostają', () => {
    const older: PriceRow[] = [{ date: '2026-07-01', close: 3.7 }];
    const plan = planBarDateRepair([...older, ...SHIFTED], CORRECT);
    if (plan.kind !== 'replace') throw new Error(`oczekiwano podmiany, jest: ${plan.reason}`);

    expect(plan.keptOlder).toBe(1);
    expect(plan.deleted).toBe(7);
  });
});

describe('weekdayOf', () => {
  it('liczy dzień tygodnia z samej daty, bez strefy procesu', () => {
    expect(weekdayOf('2026-07-12')).toBe(0);
    expect(weekdayOf('2026-07-17')).toBe(5);
  });
});
