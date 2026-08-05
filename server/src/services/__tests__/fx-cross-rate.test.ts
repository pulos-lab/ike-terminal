import { describe, it, expect } from 'vitest';
import { crossRateSeries } from '../fx-cross-rate.js';

function p(date: string, close: number) {
  return { date, close };
}

describe('crossRateSeries', () => {
  it('liczy iloraz na datach wspólnych', () => {
    const out = crossRateSeries(
      [p('2026-04-01', 4.0), p('2026-04-02', 4.2)],
      [p('2026-04-01', 5.0), p('2026-04-02', 4.2)],
    );
    expect(out).toEqual([p('2026-04-01', 0.8), p('2026-04-02', 1)]);
  });

  it('przeciąga brakującą nogę zamiast gubić punkt (dziura w środku serii)', () => {
    const out = crossRateSeries(
      [p('2026-04-01', 4.0), p('2026-04-02', 4.4), p('2026-04-03', 4.8)],
      [p('2026-04-01', 4.0), p('2026-04-03', 4.0)], // brak 04-02
    );
    expect(out).toEqual([p('2026-04-01', 1), p('2026-04-02', 1.1), p('2026-04-03', 1.2)]);
  });

  it('REGRESJA: nogi zestarzałe niezależnie nie obcinają końcówki wykresu', () => {
    // Realny kształt z prod: USDPLN świeży do 04.08, EURPLN do 05.08 — stare
    // przecięcie dat kończyło cross na 02.08 mimo danych po obu stronach.
    const out = crossRateSeries(
      [p('2026-08-02', 3.74), p('2026-08-03', 3.75), p('2026-08-04', 3.76)],
      [p('2026-08-02', 4.3), p('2026-08-03', 4.3), p('2026-08-05', 4.31)],
    );
    expect(out.map((x) => x.date)).toEqual([
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
    // 04.08 z EURPLN przeciągniętym z 03.08, 05.08 z USDPLN przeciągniętym z 04.08
    expect(out.at(-2)?.close).toBeCloseTo(3.76 / 4.3, 10);
    expect(out.at(-1)?.close).toBeCloseTo(3.76 / 4.31, 10);
  });

  it('nie przeciąga w nieskończoność — po 5 dniach przerwy urywa serię', () => {
    const out = crossRateSeries(
      [p('2026-04-01', 4.0), p('2026-04-20', 4.0)],
      [p('2026-04-01', 4.0), p('2026-04-20', 5.0)],
    );
    // 04-01 liczone normalnie; między nimi brak dat w OBU seriach, więc nie ma
    // czego pomijać — kluczowe, że 04-20 wraca (obie nogi znów świeże)
    expect(out).toEqual([p('2026-04-01', 1), p('2026-04-20', 0.8)]);
  });

  it('luka jednej nogi dłuższa niż sufit → punkty z tego okna wypadają', () => {
    const out = crossRateSeries(
      [
        p('2026-04-01', 4.0),
        p('2026-04-08', 4.0), // EURPLN stoi od 04-01 = 7 dni > sufit
        p('2026-04-09', 4.0),
      ],
      [p('2026-04-01', 4.0), p('2026-04-09', 5.0)],
    );
    expect(out.map((x) => x.date)).toEqual(['2026-04-01', '2026-04-09']);
  });

  it('pomija okres przed pierwszym notowaniem drugiej nogi', () => {
    const out = crossRateSeries(
      [p('2026-04-01', 4.0), p('2026-04-02', 4.0)],
      [p('2026-04-02', 5.0)],
    );
    expect(out).toEqual([p('2026-04-02', 0.8)]);
  });

  it('ignoruje niedodatnie kwotowania zamiast dzielić przez zero', () => {
    const out = crossRateSeries(
      [p('2026-04-01', 4.0), p('2026-04-02', 4.4)],
      [p('2026-04-01', 4.0), p('2026-04-02', 0)],
    );
    // 04-02 liczone starym (dodatnim) kursem EUR, nie zerem
    expect(out).toEqual([p('2026-04-01', 1), p('2026-04-02', 1.1)]);
  });

  it('puste wejście → pusta seria', () => {
    expect(crossRateSeries([], [p('2026-04-01', 4.0)])).toEqual([]);
    expect(crossRateSeries([p('2026-04-01', 4.0)], [])).toEqual([]);
  });
});
