import type { PortfolioHistoryPoint } from 'shared';

/**
 * Seria „Łącznie" — historia wybranych portfeli policzona tak, jakby były
 * JEDNYM rachunkiem: dzienne wartości i skumulowane przepływy się sumują,
 * a TWR/MWR liczone są od nowa na zsumowanych wielkościach wzorami silnika
 * (pętla dzienna w server/src/services/portfolio-engine.ts). Procenty
 * składników NIE są uśredniane — średnia TWR-ów nie jest TWR-em połączonego
 * rachunku (pomija wagi kapitału i momenty przepływów).
 *
 * Założenia:
 * - wszystkie serie są w tej samej walucie bazowej (pilnuje
 *   `combinedBaseCurrencyConflict` po stronie wywołującego);
 * - serwer emituje każdy dzień kalendarzowy od inception portfela, więc unia
 *   dat jest gęsta; przed inception danego portfela jego wkład = 0
 *   (carry-forward ostatniego punktu jest czysto defensywny);
 * - pierwsza seria na liście = AKTYWNY portfel: z niej join pól benchmarku
 *   (semantyka dashboardu — benchmark DCA symuluje wpłaty aktywnego). Poza
 *   zakresem aktywnego pola benchmarku są płaskie (zerowy dzienny zwrot) —
 *   świadoma aproksymacja dla beta/alfy w computeMetrics.
 */
export function buildCombinedHistory(
  histories: PortfolioHistoryPoint[][],
): PortfolioHistoryPoint[] {
  const nonEmpty = histories.filter((h) => h.length > 0);
  if (!nonEmpty.length) return [];

  const byDate = nonEmpty.map((h) => new Map(h.map((p) => [p.date, p])));
  const dates = [...new Set(nonEmpty.flatMap((h) => h.map((p) => p.date)))].sort();

  const activeHistory = histories[0] ?? [];
  const activeByDate = new Map(activeHistory.map((p) => [p.date, p]));
  // Przed inception aktywnego benchmark trzyma wartości z jego pierwszego
  // punktu — bez tego w dniu startu aktywnego seria benchmarku skakałaby
  // z 0 do realnej wartości i produkowała fałszywy dzienny zwrot.
  const firstActive: PortfolioHistoryPoint | null = activeHistory[0] ?? null;

  const result: PortfolioHistoryPoint[] = [];
  // Lustro zmiennych pętli dziennej silnika (portfolio-engine.ts:2712-2740).
  let twrCumulative = 1;
  let prevTotalValue = 0;
  let peakTotalValue = 0;
  let prevDeposits = 0;
  let prevWithdrawals = 0;
  const lastSeen: (PortfolioHistoryPoint | undefined)[] = nonEmpty.map(() => undefined);
  let lastBench: PortfolioHistoryPoint | null = null;

  for (const date of dates) {
    let totalValue = 0;
    let deposits = 0;
    let withdrawals = 0;
    let invested = 0;
    for (let i = 0; i < byDate.length; i++) {
      const cur = byDate[i].get(date);
      if (cur) lastSeen[i] = cur;
      const p = cur ?? lastSeen[i];
      if (!p) continue; // portfel jeszcze nie wystartował
      totalValue += p.portfolioValue;
      deposits += p.cumulativeDepositsPln;
      withdrawals += p.cumulativeWithdrawalsPln;
      invested += p.investedCumulative;
    }

    // Dzienny przepływ netto z różnicy skumulowanych wpłat/wypłat — dokładnie
    // tak samo wyprowadza go computeCashFlowChartData w silniku.
    const netCashFlow = deposits - prevDeposits - (withdrawals - prevWithdrawals);
    const twrDenominator = prevTotalValue + netCashFlow;
    const MEANINGFUL_VALUE = peakTotalValue * 0.05;
    if (
      prevTotalValue > MEANINGFUL_VALUE &&
      totalValue > MEANINGFUL_VALUE &&
      twrDenominator > MEANINGFUL_VALUE
    ) {
      twrCumulative *= totalValue / twrDenominator;
    } else if (totalValue > 0 && prevTotalValue === 0) {
      twrCumulative = 1;
    }
    if (totalValue > peakTotalValue) peakTotalValue = totalValue;
    prevTotalValue = totalValue;
    prevDeposits = deposits;
    prevWithdrawals = withdrawals;

    const returnPct = deposits > 0 ? ((totalValue + withdrawals - deposits) / deposits) * 100 : 0;

    const benchCur = activeByDate.get(date);
    if (benchCur) lastBench = benchCur;
    const bench = benchCur ?? lastBench ?? firstActive;

    result.push({
      date,
      portfolioValue: totalValue,
      returnPct,
      twrPct: (twrCumulative - 1) * 100,
      benchmarkValue: bench?.benchmarkValue ?? 0,
      benchmarkReturnPct: bench?.benchmarkReturnPct ?? 0,
      benchmarkTwrPct: bench?.benchmarkTwrPct ?? 0,
      investedCumulative: invested,
      cumulativeDepositsPln: deposits,
      cumulativeWithdrawalsPln: withdrawals,
    });
  }

  return result;
}

/**
 * Konflikt walut bazowych łączonych portfeli: null gdy wszystkie zgodne,
 * inaczej lista walut do komunikatu (np. "PLN, USD"). Sumowanie wartości
 * w różnych walutach bez przeliczenia FX dawałoby bezsensowne kwoty.
 */
export function combinedBaseCurrencyConflict(currencies: string[]): string | null {
  const unique = [...new Set(currencies.filter(Boolean))];
  return unique.length > 1 ? unique.join(', ') : null;
}
