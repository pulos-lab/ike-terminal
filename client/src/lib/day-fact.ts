import type { BenchmarkDayChange, PortfolioHistoryPoint } from 'shared';
import { formatDate, formatPercent } from '@/lib/formatters';

/** Poniżej tylu sesji percentyl i rankingi to szum — linijka się nie pokazuje. */
export const MIN_SESSIONS_FOR_FACT = 60;
/** „Najlepszy dzień od …" ma sens dopiero po mniej więcej kwartale przerwy. */
const SINCE_MIN_SESSIONS = 60;
/** Seria krótsza niż trzy sesje to nie seria. */
const STREAK_MIN = 3;

export interface DayFact {
  kind: 'rank' | 'since' | 'streak' | 'percentile';
  /** Kierunek dnia — steruje ikoną i kolorem. */
  direction: 'up' | 'down';
  headline: string;
  detail: string | null;
}

type HistoryPoint = Pick<PortfolioHistoryPoint, 'date' | 'twrPct'>;

/** Data w strefie użytkownika jako YYYY-MM-DD (daty historii są kalendarzowe). */
export function localIsoDate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Dzienne stopy zwrotu z SESJI sprzed `beforeDate`, w procentach.
 *
 * Historia ma punkt na każdy dzień kalendarzowy — weekendy i święta powielają
 * poprzednią wartość. Dzień bez ruchu indeksu nie jest sesją: zostawiony,
 * zawyżałby percentyl każdego dodatniego dnia i rwał serie. Punkty od
 * `beforeDate` wzwyż odpadają, bo dzisiejszy bywa kopią poprzedniego, dopóki
 * nie spłyną zamknięcia — a dzisiejszy wynik i tak przychodzi z kursów live.
 */
export function sessionReturns(
  history: HistoryPoint[],
  beforeDate: string,
): Array<{ date: string; pct: number }> {
  const out: Array<{ date: string; pct: number }> = [];
  for (let i = 1; i < history.length; i++) {
    if (history[i].date >= beforeDate) break;
    const prevIndex = 1 + history[i - 1].twrPct / 100;
    const curIndex = 1 + history[i].twrPct / 100;
    if (prevIndex <= 0) continue;
    const pct = (curIndex / prevIndex - 1) * 100;
    if (pct === 0) continue;
    out.push({ date: history[i].date, pct });
  }
  return out;
}

/** Ile miejsc rankingu zasługuje na wzmiankę: przy krótkiej historii „top 5" to nic rzadkiego. */
function notableRankLimit(sessions: number): number {
  return Math.max(1, Math.min(5, Math.floor(sessions / 50)));
}

/** Udział zaokrąglony W DÓŁ — „lepszy niż 100% sesji" bez rekordu byłby nieprawdą. */
function shareText(share: number): string {
  const pct = share * 100;
  return pct >= 99 ? `${(Math.floor(pct * 10) / 10).toFixed(1)}%` : `${Math.floor(pct)}%`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Jedna linijka kontekstu: jak dzisiejszy wynik wypada na tle historii portfela.
 * Wybiera najrzadszy fakt: miejsce w rankingu → „najlepszy od" → seria → percentyl.
 *
 * `todayPct` to wynik dnia z kursów live (ruch cen po bieżącym kursie walut),
 * a historia to dzienny TWR z ruchem walut w środku. Dla percentyla różnica jest
 * pomijalna; przy rankingu może przestawić sąsiednie miejsca, dlatego w trakcie
 * sesji (`provisional`) fakt jest opatrzony „Na razie".
 */
export function describeDayInHistory(
  history: HistoryPoint[],
  todayPct: number | null | undefined,
  sessionDate: string,
  { provisional = false }: { provisional?: boolean } = {},
): DayFact | null {
  if (todayPct == null || !Number.isFinite(todayPct) || todayPct === 0) return null;
  const sessions = sessionReturns(history, sessionDate);
  const n = sessions.length;
  if (n < MIN_SESSIONS_FOR_FACT) return null;

  const up = todayPct > 0;
  const direction = up ? 'up' : 'down';
  // „Pobite" = sesje słabsze od dzisiejszej przy wzroście, mocniejsze przy spadku.
  const beaten = sessions.filter((s) => (up ? s.pct < todayPct : s.pct > todayPct)).length;
  const rank = n - beaten + 1; // 1 = rekord; remis z dawną sesją nie daje awansu
  const adjective = up ? 'najlepszy' : 'najsłabszy';
  const percentile = `${up ? 'lepszy' : 'gorszy'} niż ${shareText(beaten / n)}`;
  const finish = (fact: DayFact): DayFact =>
    provisional ? { ...fact, headline: `Na razie ${lowerFirst(fact.headline)}` } : fact;

  if (rank <= notableRankLimit(n)) {
    return finish({
      kind: 'rank',
      direction,
      headline:
        rank === 1
          ? `${up ? 'Najlepszy' : 'Najsłabszy'} dzień w historii portfela`
          : `${rank}. ${adjective} dzień w historii portfela`,
      detail: rank === 1 ? `na ${n} sesji` : `${percentile} z ${n} sesji`,
    });
  }

  // Ostatnia sesja co najmniej tak mocna (słaba) jak dzisiejsza.
  let lastMatch = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (up ? sessions[i].pct >= todayPct : sessions[i].pct <= todayPct) {
      lastMatch = i;
      break;
    }
  }
  if (lastMatch >= 0 && n - 1 - lastMatch >= SINCE_MIN_SESSIONS) {
    return finish({
      kind: 'since',
      direction,
      headline: `${up ? 'Najlepszy' : 'Najsłabszy'} dzień od ${formatDate(sessions[lastMatch].date)}`,
      detail: `${percentile} sesji`,
    });
  }

  let streak = 1;
  for (let i = n - 1; i >= 0 && sessions[i].pct > 0 === up; i--) streak++;
  if (streak >= STREAK_MIN) {
    return finish({
      kind: 'streak',
      direction,
      headline: `${streak}. ${up ? 'wzrostowa' : 'spadkowa'} sesja z rzędu`,
      detail: `${percentile} sesji`,
    });
  }

  return finish({
    kind: 'percentile',
    direction,
    headline: `${up ? 'Lepszy' : 'Gorszy'} niż ${shareText(beaten / n)} sesji w historii portfela`,
    detail: `na ${n} sesji`,
  });
}

/**
 * „S&P 500 +0.42% · lepiej o 0.79 pp" — albo null, gdy notowanie indeksu jest
 * z innego dnia niż sesja portfela. Rano, przed otwarciem w USA, źródło wciąż
 * zwraca WCZORAJSZĄ zmianę S&P; zestawiona z dzisiejszym wynikiem GPW byłaby
 * porównaniem dwóch różnych dni.
 */
export function describeBenchmarkDay(
  benchmark: BenchmarkDayChange | null | undefined,
  label: string,
  portfolioPct: number | null | undefined,
  sessionDate: string,
): string | null {
  if (!benchmark || benchmark.changePct == null || !benchmark.asOf || !label) return null;
  const asOf = new Date(benchmark.asOf);
  if (Number.isNaN(asOf.getTime()) || localIsoDate(asOf) !== sessionDate) return null;

  const base = `${label} ${formatPercent(benchmark.changePct)}`;
  if (portfolioPct == null || !Number.isFinite(portfolioPct)) return base;
  const diff = portfolioPct - benchmark.changePct;
  if (Math.abs(diff) < 0.005) return `${base} · tak samo`;
  return `${base} · ${diff > 0 ? 'lepiej' : 'gorzej'} o ${Math.abs(diff).toFixed(2)} pp`;
}
