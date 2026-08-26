import type { PortfolioHistoryPoint } from 'shared';

/**
 * Scalanie historii kilku portfeli w jedną serię „portfela łączonego" — tak, jakby
 * zaznaczone rachunki były od początku jednym portfelem.
 *
 * DLACZEGO PO STRONIE KLIENTA. Silnik liczy MWR i TWR wyłącznie z wielkości, które
 * `PortfolioHistoryPoint` już eksportuje:
 *   returnPct = ((V + W − D) / D) × 100
 *   twrPct    = łańcuch V_t / (V_{t−1} + netCashFlow_t)
 * gdzie V = portfolioValue, D = cumulativeDeposits, W = cumulativeWithdrawals.
 * Zsumowanie tych trzech po portfelach i przepuszczenie sum przez te same wzory daje
 * dokładnie ten sam wynik, co przeliczenie silnika na scalonym portfelu — a serie i tak
 * są już w cache (pobiera je wykres porównania), więc scalanie kosztuje zero zapytań.
 *
 * JEDYNE PRZYBLIŻENIE dotyczy `benchmarkReturnPct` — patrz komentarz przy jego liczeniu.
 */

/** Jedna historia wchodząca do scalania. */
export interface CombineSource {
  points: PortfolioHistoryPoint[];
  /** Waluta bazowa portfela. Kwoty sprowadza do PLN `toPlnSeries`, ale indeks benchmarku
   *  zostaje liczony w walucie bazowej — stąd potrzeba jej znać przy sklejce indeksu. */
  baseCurrency: string;
}

/** Mnożniki kwot: pola pieniężne serii. Reszta (procenty, data) przechodzi bez zmian. */
function scaleAmounts(p: PortfolioHistoryPoint, rate: number): PortfolioHistoryPoint {
  return {
    ...p,
    portfolioValue: p.portfolioValue * rate,
    benchmarkValue: p.benchmarkValue * rate,
    investedCumulative: p.investedCumulative * rate,
    cumulativeDepositsPln: p.cumulativeDepositsPln * rate,
    cumulativeWithdrawalsPln: p.cumulativeWithdrawalsPln * rate,
  };
}

/**
 * Przelicza kwoty serii z waluty bazowej portfela na PLN kursem z DNIA punktu.
 *
 * Historia silnika jest w walucie BAZOWEJ portfela (nazwa `cumulativeDepositsPln` jest
 * historyczna), więc sub-konto USD trzeba przewalutować, zanim jego wartości dodamy do
 * portfela PLN-owego. Brak mapy = portfel PLN-owy → identyczność.
 *
 * Pola procentowe zostają nietknięte: portfel łączony liczy je od nowa z sum. Skutek
 * uboczny przewalutowania jest zamierzony — zwrot sub-konta USD widziany „po polsku"
 * zawiera wpływ kursu, bo tyle realnie zarobił inwestor rozliczający się w złotówkach.
 */
export function toPlnSeries(
  points: PortfolioHistoryPoint[],
  baseToPlnByDate?: Record<string, number>,
): PortfolioHistoryPoint[] {
  if (!baseToPlnByDate || points.length === 0) return points;

  // Dni bez notowania FX (weekend, luka u dostawcy) dziedziczą ostatni znany kurs;
  // dni sprzed pierwszego wpisu — pierwszy znany (back-fill), żeby początek serii nie
  // został po cichu potraktowany jak PLN.
  let firstKnown: number | undefined;
  for (const p of points) {
    const r = baseToPlnByDate[p.date];
    if (r && r > 0) {
      firstKnown = r;
      break;
    }
  }
  if (firstKnown === undefined) return points; // mapa bez pokrycia — lepiej nie zgadywać

  let last = firstKnown;
  return points.map((p) => {
    const r = baseToPlnByDate[p.date];
    if (r && r > 0) last = r;
    return scaleAmounts(p, last);
  });
}

/**
 * Scala N historii w jedną. Wynik jest zwykłym `PortfolioHistoryPoint[]`, więc idzie
 * dalej tą samą ścieżką co każda inna seria: `filterAndRebaseHistory`, `computeMetrics`,
 * `computeDrawdownSeries`, wykresy.
 *
 * Kwoty muszą być w JEDNEJ walucie — wywołujący przepuszcza serie walutowe przez
 * `toPlnSeries` przed wywołaniem.
 */
export function combineHistories(sources: CombineSource[]): PortfolioHistoryPoint[] {
  const usable = sources.filter((s) => s.points.length > 0);
  if (usable.length === 0) return [];
  if (usable.length === 1) return usable[0].points.slice();

  // Silnik generuje punkt na KAŻDY dzień kalendarzowy od pierwszej aktywności portfela,
  // więc unia dat jest ciągłym zakresem — serie różnią się tylko datą startu i (rzadko,
  // przy portfelu zamkniętym) wcześniejszym końcem.
  const dateSet = new Set<string>();
  for (const s of usable) for (const p of s.points) dateSet.add(p.date);
  const dates = Array.from(dateSet).sort();

  const cursors = usable.map(() => 0);
  /** Ostatni znany punkt serii — niesie wkład portfela po urwaniu jego historii. */
  const carried: (PortfolioHistoryPoint | null)[] = usable.map(() => null);

  // Referencja indeksu benchmarku: seria startująca najwcześniej, bo jej punkt zerowy
  // JEST punktem zerowym portfela łączonego (scale = 1).
  let refIdx = 0;
  for (let i = 1; i < usable.length; i++) {
    if (usable[i].points[0].date < usable[refIdx].points[0].date) refIdx = i;
  }
  let benchScale = 1;
  let prevBenchCombined: number | null = null;
  const prevBenchBySeries: (number | null)[] = usable.map(() => null);

  // Stan łańcucha TWR — 1:1 z `computePortfolioHistory`.
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

    const liveBenchIdx: (number | null)[] = usable.map(() => null);

    for (let i = 0; i < usable.length; i++) {
      const pts = usable[i].points;
      let live: PortfolioHistoryPoint | null = null;
      if (cursors[i] < pts.length && pts[cursors[i]].date === date) {
        live = pts[cursors[i]];
        cursors[i]++;
        carried[i] = live;
        liveBenchIdx[i] = 1 + live.benchmarkTwrPct / 100;
      }
      // Przed pierwszym punktem serii wkład = 0 (portfel jeszcze nie istniał);
      // po ostatnim — ostatni znany punkt (portfel zamknięty wciąż niesie swoje
      // skumulowane wpłaty i wypłaty do wyniku łącznego).
      const eff = live ?? carried[i];
      if (!eff) continue;
      V += eff.portfolioValue;
      D += eff.cumulativeDepositsPln;
      W += eff.cumulativeWithdrawalsPln;
      invested += eff.investedCumulative;
      benchValue += eff.benchmarkValue;
    }

    // MWR — wzór silnika na sumach (dokładny).
    const returnPct = D > 0 ? ((V + W - D) / D) * 100 : 0;

    // Benchmark MWR — ten sam wzór na zsumowanej symulacji DCA. PRZYBLIŻENIE: silnik
    // potrafi przyciąć wypłatę z benchmarku do jego bieżącej wartości, a przycięta kwota
    // (`benchTotalWithdrawn`) nie jest eksportowana; różnica pojawia się więc tylko wtedy,
    // gdy symulowany portfel indeksowy nie miał z czego wypłacić.
    const benchmarkReturnPct = D > 0 ? ((benchValue + W - D) / D) * 100 : 0;

    // TWR — replay łańcucha silnika (łącznie z bramką 5% szczytu: przy portfelu bliskim
    // likwidacji sub-okres jest zamrażany zamiast eksplodować).
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

    // Indeks benchmarku każdej serii ma WŁASNĄ bazę (P(t)/P(start_i)), więc bierzemy go
    // z serii referencyjnej. Gdy ta się urwie, doklejamy inną przez stały iloraz zmierzony
    // na ostatnim wspólnym dniu — ale tylko przy zgodnej walucie bazowej, bo silnik zapisuje
    // `firstBenchPrice` w walucie bazowej portfela i przy różnych bazach krzywe rozjeżdża
    // jeszcze dryf FX.
    let benchCombined = liveBenchIdx[refIdx];
    if (benchCombined !== null) {
      benchCombined *= benchScale;
    } else {
      const cand = usable.findIndex(
        (s, i) =>
          liveBenchIdx[i] !== null &&
          prevBenchBySeries[i] !== null &&
          s.baseCurrency === usable[refIdx].baseCurrency,
      );
      if (cand >= 0 && prevBenchCombined !== null && prevBenchBySeries[cand]) {
        benchScale = prevBenchCombined / prevBenchBySeries[cand]!;
        refIdx = cand;
        benchCombined = liveBenchIdx[cand]! * benchScale;
      } else {
        benchCombined = prevBenchCombined; // brak mostu — zamrażamy ostatnią wartość
      }
    }
    prevBenchCombined = benchCombined;
    for (let i = 0; i < usable.length; i++) prevBenchBySeries[i] = liveBenchIdx[i];

    out.push({
      date,
      portfolioValue: V,
      returnPct,
      twrPct: (twrCumulative - 1) * 100,
      benchmarkValue: benchValue,
      benchmarkReturnPct,
      benchmarkTwrPct: benchCombined !== null ? (benchCombined - 1) * 100 : 0,
      investedCumulative: invested,
      cumulativeDepositsPln: D,
      cumulativeWithdrawalsPln: W,
    });
  }

  // Wiodące dni, w których nic się jeszcze nie działo (portfele zaczynają później niż
  // najwcześniejsza data w unii po zaokrągleniu zakresu) — jak `firstActive` w silniku.
  const firstActive = out.findIndex((p) => p.portfolioValue !== 0 || p.cumulativeDepositsPln !== 0);
  return firstActive > 0 ? out.slice(firstActive) : out;
}
