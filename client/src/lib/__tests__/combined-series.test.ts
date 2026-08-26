import { describe, it, expect } from 'vitest';
import type { PortfolioHistoryPoint } from 'shared';
import { buildCombinedHistory, combinedBaseCurrencyConflict } from '../combined-series';

/** Punkt WEJŚCIOWY: wartość + skumulowane przepływy (twrPct/returnPct składników
 *  są dla buildCombinedHistory bez znaczenia — liczy oba od nowa z kwot). */
function pt(
  date: string,
  portfolioValue: number,
  cumulativeDepositsPln: number,
  cumulativeWithdrawalsPln = 0,
  bench: Partial<
    Pick<PortfolioHistoryPoint, 'benchmarkTwrPct' | 'benchmarkReturnPct' | 'benchmarkValue'>
  > = {},
): PortfolioHistoryPoint {
  return {
    date,
    portfolioValue,
    returnPct: 0,
    twrPct: 0,
    benchmarkValue: bench.benchmarkValue ?? 0,
    benchmarkReturnPct: bench.benchmarkReturnPct ?? 0,
    benchmarkTwrPct: bench.benchmarkTwrPct ?? 0,
    investedCumulative: cumulativeDepositsPln,
    cumulativeDepositsPln,
    cumulativeWithdrawalsPln,
  };
}

describe('buildCombinedHistory', () => {
  it('puste wejście → pusta seria', () => {
    expect(buildCombinedHistory([])).toEqual([]);
    expect(buildCombinedHistory([[], []])).toEqual([]);
  });

  it('pojedynczy portfel: TWR chain-linkiem z przepływem na starcie dnia, MWR z sum', () => {
    const result = buildCombinedHistory([
      [
        pt('2024-01-01', 1000, 1000),
        pt('2024-01-02', 1100, 1000), // +10% bez przepływu
        pt('2024-01-03', 1540, 1400), // wpłata 400, potem wzrost: 1540/(1100+400)
      ],
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].twrPct).toBeCloseTo(0, 6);
    expect(result[1].twrPct).toBeCloseTo(10, 6);
    // 1.1 × (1540/1500) − 1 = 12.9333…%
    expect(result[2].twrPct).toBeCloseTo(12.933333, 4);
    // MWR: (1540 + 0 − 1400) / 1400 = 10%
    expect(result[2].returnPct).toBeCloseTo(10, 6);
    expect(result[2].portfolioValue).toBe(1540);
  });

  it('dwa portfele o tych samych datach: TWR łączny między TWR-ami składników', () => {
    const a = [pt('2024-01-01', 1000, 1000), pt('2024-01-02', 1100, 1000)]; // +10%
    const b = [pt('2024-01-01', 1000, 1000), pt('2024-01-02', 1000, 1000)]; // 0%
    const result = buildCombinedHistory([a, b]);
    // 2100/2000 − 1 = +5% — kapitałowo ważona średnia, nie średnia procentów.
    expect(result[1].twrPct).toBeCloseTo(5, 6);
    expect(result[1].returnPct).toBeCloseTo(5, 6);
  });

  it('portfel dołączający później: jego wpłata wchodzi jako przepływ, nie jako zwrot', () => {
    const a = [
      pt('2024-01-01', 1000, 1000),
      pt('2024-01-02', 1200, 1000), // +20%
      pt('2024-01-03', 1200, 1000),
    ];
    const b = [
      pt('2024-01-02', 500, 500), // start w d2, wartość = wpłata (dzień neutralny)
      pt('2024-01-03', 550, 500), // +10%
    ];
    const result = buildCombinedHistory([a, b]);
    expect(result.map((p) => p.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
    // d2: 1700/(1000+500) − 1 = +13.33% — gdyby wpłata B liczyła się jako zysk,
    // wyszłoby 1700/1000 = +70%.
    expect(result[1].twrPct).toBeCloseTo((1700 / 1500 - 1) * 100, 4);
    // d3: ×(1750/1700) → łącznie +16.67%
    expect(result[2].twrPct).toBeCloseTo(((1700 / 1500) * (1750 / 1700) - 1) * 100, 4);
    expect(result[2].cumulativeDepositsPln).toBe(1500);
  });

  it('wypłata pomniejsza mianownik TWR i wchodzi do MWR', () => {
    const result = buildCombinedHistory([
      [
        pt('2024-01-01', 1000, 1000),
        pt('2024-01-02', 550, 1000, 500), // wypłata 500, potem +10% na 500
      ],
    ]);
    // 550/(1000−500) − 1 = +10%
    expect(result[1].twrPct).toBeCloseTo(10, 6);
    // MWR: (550 + 500 − 1000) / 1000 = +5%
    expect(result[1].returnPct).toBeCloseTo(5, 6);
  });

  it('zamrożenie TWR gdy wartość spada poniżej 5% szczytu (guard silnika)', () => {
    const result = buildCombinedHistory([
      [
        pt('2024-01-01', 1000, 1000),
        pt('2024-01-02', 1100, 1000),
        pt('2024-01-03', 10, 1000), // < 5% szczytu (55) → łańcuch zamrożony
        pt('2024-01-04', 12, 1000),
      ],
    ]);
    expect(result[1].twrPct).toBeCloseTo(10, 6);
    expect(result[2].twrPct).toBeCloseTo(10, 6);
    expect(result[3].twrPct).toBeCloseTo(10, 6);
  });

  it('bez wpłat MWR = 0 (degeneracja mianownika)', () => {
    const result = buildCombinedHistory([[pt('2024-01-01', 100, 0)]]);
    expect(result[0].returnPct).toBe(0);
  });

  it('benchmark: join z serii aktywnego + płaski carry poza jego zakresem', () => {
    const active = [
      pt('2024-01-02', 1000, 1000, 0, { benchmarkTwrPct: 5, benchmarkValue: 105 }),
      pt('2024-01-03', 1010, 1000, 0, { benchmarkTwrPct: 6, benchmarkValue: 106 }),
    ];
    const other = [
      pt('2024-01-01', 500, 500),
      pt('2024-01-02', 500, 500),
      pt('2024-01-03', 500, 500),
    ];
    const result = buildCombinedHistory([active, other]);
    // Przed inception aktywnego: wartości z jego PIERWSZEGO punktu (płasko —
    // zerowy dzienny zwrot benchmarku zamiast sztucznego skoku z 0).
    expect(result[0].benchmarkTwrPct).toBe(5);
    expect(result[1].benchmarkTwrPct).toBe(5);
    expect(result[2].benchmarkTwrPct).toBe(6);
    expect(result[2].benchmarkValue).toBe(106);
  });
});

describe('combinedBaseCurrencyConflict', () => {
  it('zgodne waluty → null', () => {
    expect(combinedBaseCurrencyConflict(['PLN', 'PLN', 'PLN'])).toBeNull();
    expect(combinedBaseCurrencyConflict(['USD'])).toBeNull();
  });

  it('różne waluty → lista do komunikatu', () => {
    expect(combinedBaseCurrencyConflict(['PLN', 'USD'])).toBe('PLN, USD');
    expect(combinedBaseCurrencyConflict(['PLN', 'USD', 'PLN', 'EUR'])).toBe('PLN, USD, EUR');
  });
});
