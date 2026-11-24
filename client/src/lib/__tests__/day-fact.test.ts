import { describe, it, expect } from 'vitest';
import {
  describeBenchmarkDay,
  describeDayInHistory,
  localIsoDate,
  sessionReturns,
} from '../day-fact';

/** Historia z dziennych stóp zwrotu w % (0 = dzień bez sesji), od 2025-01-01. */
function historyFrom(returnsPct: number[]) {
  let index = 1;
  const start = Date.parse('2025-01-01T00:00:00Z');
  const points = [{ date: '2024-12-31', twrPct: 0 }];
  returnsPct.forEach((r, i) => {
    index *= 1 + r / 100;
    points.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      twrPct: (index - 1) * 100,
    });
  });
  return points;
}

/** n sesji o stopach rozłożonych równo w (−1%, +1%), w kolejności przeplatanej. */
function spread(n: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const magnitude = ((Math.floor(i / 2) + 1) / n) * 2;
    return i % 2 === 0 ? magnitude : -magnitude;
  });
}

const FAR = '2099-01-01';

describe('sessionReturns', () => {
  it('pomija dni bez ruchu indeksu — weekend nie jest sesją', () => {
    const r = sessionReturns(historyFrom([1, 0, 0, -2]), FAR);
    expect(r.map((s) => s.date)).toEqual(['2025-01-01', '2025-01-04']);
    expect(r[0].pct).toBeCloseTo(1, 10);
    expect(r[1].pct).toBeCloseTo(-2, 10);
  });

  it('odcina punkty od dnia sesji wzwyż — dzisiejszy bywa kopią wczorajszego', () => {
    const r = sessionReturns(historyFrom([1, 2, 3]), '2025-01-03');
    expect(r.map((s) => s.date)).toEqual(['2025-01-01', '2025-01-02']);
  });
});

describe('describeDayInHistory', () => {
  it('milczy przy zbyt krótkiej historii, braku wyniku i dniu bez ruchu', () => {
    expect(describeDayInHistory(historyFrom(spread(40)), 1, FAR)).toBeNull();
    expect(describeDayInHistory(historyFrom(spread(200)), null, FAR)).toBeNull();
    expect(describeDayInHistory(historyFrom(spread(200)), 0, FAR)).toBeNull();
  });

  it('rekord: najlepszy dzień w historii', () => {
    const f = describeDayInHistory(historyFrom(spread(200)), 5, FAR);
    expect(f).toMatchObject({
      kind: 'rank',
      direction: 'up',
      headline: 'Najlepszy dzień w historii portfela',
      detail: 'na 200 sesji',
    });
  });

  it('miejsce w rankingu przy długiej historii', () => {
    // 300 sesji, dodatnie co 1/150 pp do +1.00%: nad +0.99% są tylko +1.00% i +0.9933%.
    const f = describeDayInHistory(historyFrom(spread(300)), 0.99, FAR);
    expect(f?.headline).toBe('3. najlepszy dzień w historii portfela');
    expect(f?.detail).toBe('lepszy niż 99.3% z 300 sesji');
  });

  it('spadek: najsłabszy dzień liczony od dołu', () => {
    const f = describeDayInHistory(historyFrom(spread(300)), -4, FAR);
    expect(f).toMatchObject({
      direction: 'down',
      headline: 'Najsłabszy dzień w historii portfela',
    });
  });

  it('krótka historia: trzecie miejsce na 80 sesji to nie wyróżnienie', () => {
    const f = describeDayInHistory(historyFrom(spread(80)), 0.93, FAR);
    expect(f?.kind).not.toBe('rank');
  });

  it('„najlepszy dzień od …" po co najmniej kwartale przerwy', () => {
    // Dawno temu dziesięć dni po +3%, potem 100 spokojnych sesji ±0.1% — dziś +2%.
    const calm = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1));
    const f = describeDayInHistory(historyFrom([...Array(10).fill(3), ...calm]), 2, FAR);
    expect(f).toMatchObject({ kind: 'since', headline: 'Najlepszy dzień od 10.01.2025' });
  });

  it('seria: trzecia wzrostowa sesja z rzędu', () => {
    const f = describeDayInHistory(historyFrom([...spread(198), 0.4, 0.3]), 0.2, FAR);
    expect(f).toMatchObject({ kind: 'streak', headline: '3. wzrostowa sesja z rzędu' });
  });

  it('zwykły dzień: percentyl zaokrąglony w dół', () => {
    // Ostatnia sesja spread(200) jest spadkowa, więc seria się nie zaczyna.
    const f = describeDayInHistory(historyFrom(spread(200)), 0.105, FAR);
    expect(f).toMatchObject({
      kind: 'percentile',
      headline: 'Lepszy niż 55% sesji w historii portfela',
      detail: 'na 200 sesji',
    });
  });

  it('w trakcie sesji fakt jest tymczasowy', () => {
    const f = describeDayInHistory(historyFrom(spread(200)), 5, FAR, { provisional: true });
    expect(f?.headline).toBe('Na razie najlepszy dzień w historii portfela');
  });

  it('remis z dawną sesją nie daje rekordu', () => {
    const f = describeDayInHistory(historyFrom([...spread(200), 5, -0.2]), 5, FAR);
    expect(f?.headline).toBe('2. najlepszy dzień w historii portfela');
  });
});

describe('describeBenchmarkDay', () => {
  // Południe czasu lokalnego — ta sama data kalendarzowa w każdej strefie runnera.
  const noon = new Date(2026, 10, 23, 12, 0, 0);
  const sessionDate = localIsoDate(noon);
  const bench = (changePct: number | null, asOf: Date | null = noon) => ({
    benchmark: 'sp500',
    changePct,
    asOf: asOf ? asOf.toISOString() : null,
  });

  it('pokazuje zmianę indeksu i różnicę w punktach procentowych', () => {
    expect(describeBenchmarkDay(bench(0.42), 'S&P 500', 1.21, sessionDate)).toBe(
      'S&P 500 +0.42% · lepiej o 0.79 pp',
    );
    expect(describeBenchmarkDay(bench(0.42), 'S&P 500', -0.5, sessionDate)).toBe(
      'S&P 500 +0.42% · gorzej o 0.92 pp',
    );
  });

  it('notowanie indeksu z innego dnia niż sesja portfela — bez porównania', () => {
    const yesterday = new Date(2026, 10, 22, 12, 0, 0);
    expect(describeBenchmarkDay(bench(0.42, yesterday), 'S&P 500', 1.21, sessionDate)).toBeNull();
  });

  it('brak danych indeksu albo znacznika czasu', () => {
    expect(describeBenchmarkDay(bench(null), 'S&P 500', 1, sessionDate)).toBeNull();
    expect(describeBenchmarkDay(bench(0.4, null), 'S&P 500', 1, sessionDate)).toBeNull();
    expect(describeBenchmarkDay(undefined, 'S&P 500', 1, sessionDate)).toBeNull();
  });

  it('bez procentu portfela zostaje sama zmiana indeksu', () => {
    expect(describeBenchmarkDay(bench(-1.5), 'WIG', null, sessionDate)).toBe('WIG -1.50%');
  });
});
