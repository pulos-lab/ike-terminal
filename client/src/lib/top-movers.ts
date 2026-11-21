import type { Position } from 'shared';

export interface Mover {
  isin: string;
  ticker: string;
  name: string;
  /**
   * Kwota zmiany w walucie bazowej portfela — WYŁĄCZNIE do rankingu (kwoty
   * w różnych walutach nie są porównywalne). Na ekran idzie `nativeAmount`.
   */
  amount: number | null;
  /** Ta sama zmiana w walucie notowania waloru — to pokazujemy użytkownikowi. */
  nativeAmount: number | null;
  /** Waluta notowania waloru (ISO 4217), w niej wyrażone jest `nativeAmount`. */
  currency: string;
  /** Dzienna zmiana ceny w %; null, gdy źródło jej nie podało. */
  pct: number | null;
}

export interface MoversSide {
  gainers: Mover[];
  losers: Mover[];
}

export interface TopMovers {
  /** Ranking wg wpływu na wartość portfela (kwota). */
  byValue: MoversSide;
  /** Ranking wg procentowej zmiany ceny. */
  byPct: MoversSide;
  /** Pozycje z danymi o zmianie dziennej / wszystkie pozycje. */
  coveredCount: number;
  totalCount: number;
}

type MoverSource = Pick<
  Position,
  | 'isin'
  | 'ticker'
  | 'paperName'
  | 'shares'
  | 'category'
  | 'currency'
  | 'dailyChangePct'
  | 'dailyChangeValue'
  | 'dailyChangeValuePln'
>;

/**
 * Największe dzienne wzrosty i spadki w portfelu.
 *
 * Dwa rankingi, bo odpowiadają na dwa różne pytania: „co najmocniej ruszyło
 * moim wynikiem” (kwota — duża pozycja z małym ruchem) i „co najmocniej się
 * ruszyło” (procent — mała pozycja z dużym ruchem).
 *
 * - pozycja bez danych nie trafia do żadnego rankingu (nie udaje zera),
 * - ranking procentowy pomija opcje i pozycje krótkie: procent ceny opcji to
 *   nie jest ruch porównywalny z akcją, a dla shorta wzrost ceny jest stratą,
 * - wzrosty są ściśle > 0, spadki ściśle < 0 — pozycja bez ruchu nie jest
 *   ani jednym, ani drugim; lista bywa krótsza niż `limit`.
 */
export function selectTopMovers(
  positions: MoverSource[],
  { limit = 3, useNative = false }: { limit?: number; useNative?: boolean } = {},
): TopMovers {
  const valued: Mover[] = [];
  const pctRanked: Mover[] = [];

  for (const p of positions) {
    const amount = useNative ? p.dailyChangeValue : p.dailyChangeValuePln;
    if (amount == null) continue;
    const mover: Mover = {
      isin: p.isin,
      ticker: p.ticker,
      name: p.paperName,
      amount,
      nativeAmount: p.dailyChangeValue ?? null,
      currency: p.currency,
      pct: p.dailyChangePct,
    };
    valued.push(mover);
    if (p.dailyChangePct != null && p.category !== 'option' && p.shares > 0) {
      pctRanked.push(mover);
    }
  }

  const side = (list: Mover[], key: (m: Mover) => number): MoversSide => ({
    gainers: list
      .filter((m) => key(m) > 0)
      .sort((a, b) => key(b) - key(a))
      .slice(0, limit),
    losers: list
      .filter((m) => key(m) < 0)
      .sort((a, b) => key(a) - key(b))
      .slice(0, limit),
  });

  return {
    byValue: side(valued, (m) => m.amount ?? 0),
    byPct: side(pctRanked, (m) => m.pct ?? 0),
    coveredCount: valued.length,
    totalCount: positions.length,
  };
}
