import { describe, it, expect } from 'vitest';
import type { CashOperation, PortfolioHistoryPoint } from 'shared';
import { computePortfolioHistory } from '../portfolio-engine.js';

/**
 * BRAMKA PARYTETU dla portfela łączonego.
 *
 * Klient scala historie portfeli po stronie przeglądarki (`client/src/lib/combine-history.ts`)
 * zamiast liczyć silnik na scalonym zbiorze transakcji. Ten test pilnuje, że obie drogi
 * dają TEN SAM wynik — kopia algorytmu scalania niżej jest lustrem modułu klienta; gdy
 * silnik zmieni wzór MWR albo bramkę TWR, test się wywali i wymusi zmianę po obu stronach.
 *
 * Portfele są czysto gotówkowe (wpłaty / wypłaty / dywidendy), żeby test nie dotykał sieci:
 * dywidenda podnosi wartość bez przepływu zewnętrznego, więc TWR ma z czego rosnąć.
 *
 * UWAGA na dwa zachowania silnika, które kształtują tutejsze dane:
 *  - wypłata jest operacją o kwocie UJEMNEJ (saldo idzie z surowego `amount`, a licznik
 *    wypłat z `Math.abs`) — dodatnia „withdrawal" podniosłaby gotówkę,
 *  - historia urywa się na `lastActivityDate`, a za aktywność liczą się wpłaty/wypłaty
 *    i transakcje, NIE dywidendy — dlatego każdy portfel kończy się przepływem.
 */

function op(
  date: string,
  operationType: CashOperation['operationType'],
  amount: number,
): CashOperation {
  return {
    date,
    operationType,
    description: operationType,
    amount,
    currency: 'PLN',
    source: 'manual',
  };
}

async function history(operations: CashOperation[]): Promise<PortfolioHistoryPoint[]> {
  const { history: h } = await computePortfolioHistory(
    [],
    operations,
    new Map(),
    '',
    'none',
    undefined,
    '2025-01-10',
  );
  return h;
}

/** Lustro `combineHistories` z client/src/lib/combine-history.ts (ścieżka jednowalutowa). */
function combine(seriesList: PortfolioHistoryPoint[][]): PortfolioHistoryPoint[] {
  const usable = seriesList.filter((p) => p.length > 0);
  const dateSet = new Set<string>();
  for (const s of usable) for (const p of s) dateSet.add(p.date);
  const dates = Array.from(dateSet).sort();

  const cursors = usable.map(() => 0);
  const carried: (PortfolioHistoryPoint | null)[] = usable.map(() => null);

  let twrCumulative = 1;
  let prevV = 0;
  let prevD = 0;
  let prevW = 0;
  let peakV = 0;
  const out: PortfolioHistoryPoint[] = [];

  for (const date of dates) {
    let V = 0;
    let D = 0;
    let W = 0;
    let invested = 0;
    let benchValue = 0;

    for (let i = 0; i < usable.length; i++) {
      const pts = usable[i];
      let live: PortfolioHistoryPoint | null = null;
      if (cursors[i] < pts.length && pts[cursors[i]].date === date) {
        live = pts[cursors[i]];
        cursors[i]++;
        carried[i] = live;
      }
      const eff = live ?? carried[i];
      if (!eff) continue;
      V += eff.portfolioValue;
      D += eff.cumulativeDepositsPln;
      W += eff.cumulativeWithdrawalsPln;
      invested += eff.investedCumulative;
      benchValue += eff.benchmarkValue;
    }

    const netCashFlow = D - prevD - (W - prevW);
    const twrDenominator = prevV + netCashFlow;
    const meaningful = peakV * 0.05;
    if (prevV > meaningful && V > meaningful && twrDenominator > meaningful) {
      twrCumulative *= V / twrDenominator;
    } else if (V > 0 && prevV === 0) {
      twrCumulative = 1;
    }
    if (V > peakV) peakV = V;
    prevV = V;
    prevD = D;
    prevW = W;

    out.push({
      date,
      portfolioValue: V,
      returnPct: D > 0 ? ((V + W - D) / D) * 100 : 0,
      twrPct: (twrCumulative - 1) * 100,
      benchmarkValue: benchValue,
      benchmarkReturnPct: D > 0 ? ((benchValue + W - D) / D) * 100 : 0,
      benchmarkTwrPct: 0,
      investedCumulative: invested,
      cumulativeDepositsPln: D,
      cumulativeWithdrawalsPln: W,
    });
  }

  const firstActive = out.findIndex((p) => p.portfolioValue !== 0 || p.cumulativeDepositsPln !== 0);
  return firstActive > 0 ? out.slice(firstActive) : out;
}

describe('portfel łączony = silnik na scalonych operacjach', () => {
  it('portfele o różnych datach startu dają identyczną historię obiema drogami', async () => {
    const a = [
      op('2025-01-01', 'deposit', 10000),
      op('2025-01-03', 'dividend', 300),
      op('2025-01-05', 'deposit', 5000),
    ];
    // Drugi portfel startuje później, żyje dłużej i po drodze wypłaca.
    const b = [
      op('2025-01-04', 'deposit', 4000),
      op('2025-01-06', 'dividend', 120),
      op('2025-01-08', 'withdrawal', -1000),
    ];

    const [ha, hb, merged] = await Promise.all([history(a), history(b), history([...a, ...b])]);
    const combined = combine([ha, hb]);

    expect(combined.map((p) => p.date)).toEqual(merged.map((p) => p.date));
    for (let i = 0; i < merged.length; i++) {
      expect(combined[i].portfolioValue).toBeCloseTo(merged[i].portfolioValue, 8);
      expect(combined[i].cumulativeDepositsPln).toBeCloseTo(merged[i].cumulativeDepositsPln, 8);
      expect(combined[i].cumulativeWithdrawalsPln).toBeCloseTo(
        merged[i].cumulativeWithdrawalsPln,
        8,
      );
      expect(combined[i].returnPct).toBeCloseTo(merged[i].returnPct, 8);
      expect(combined[i].twrPct).toBeCloseTo(merged[i].twrPct, 8);
    }
  });

  it('portfel zamknięty w trakcie okresu nie wypada z sumy', async () => {
    const open = [
      op('2025-01-01', 'deposit', 8000),
      op('2025-01-06', 'dividend', 400),
      op('2025-01-07', 'deposit', 1000),
    ];
    // Zamknięty: wpłata, zysk, pełna wypłata → silnik urywa jego historię.
    const closed = [
      op('2025-01-01', 'deposit', 2000),
      op('2025-01-02', 'dividend', 150),
      op('2025-01-03', 'withdrawal', -2150),
    ];

    const [ho, hc, merged] = await Promise.all([
      history(open),
      history(closed),
      history([...open, ...closed]),
    ]);
    const combined = combine([ho, hc]);

    // Dowód, że przypadek jest realny: historia zamkniętego portfela KOŃCZY SIĘ wcześniej.
    expect(hc[hc.length - 1].date < ho[ho.length - 1].date).toBe(true);

    const last = combined[combined.length - 1];
    const lastMerged = merged[merged.length - 1];
    expect(last.portfolioValue).toBeCloseTo(lastMerged.portfolioValue, 8);
    expect(last.cumulativeDepositsPln).toBeCloseTo(lastMerged.cumulativeDepositsPln, 8);
    expect(last.cumulativeWithdrawalsPln).toBeCloseTo(lastMerged.cumulativeWithdrawalsPln, 8);
    expect(last.returnPct).toBeCloseTo(lastMerged.returnPct, 8);
  });
});
