import type { Position } from 'shared';

export type ContributionMode = 'value' | 'pct';

export interface DayContribution {
  isin: string;
  ticker: string;
  name: string;
  /** Kwota zmiany w walucie bazowej portfela — te kwoty sumują się do wyniku dnia. */
  amount: number;
  /** Dzienna zmiana ceny w %; null, gdy źródło jej nie podało. */
  pct: number | null;
  /** Długość słupka 0..1 względem największego ruchu na liście. */
  share: number;
  /** Opcja nie ma własnej strony instrumentu. */
  linkable: boolean;
}

export interface DayContributions {
  rows: DayContribution[];
  /**
   * Pozycje spoza listy zsumowane w jeden wiersz — dzięki niemu słupki składają
   * się na kwotę z nagłówka. Tylko w rankingu kwotowym: procenty się nie sumują.
   */
  rest: { amount: number; count: number; share: number } | null;
  /** Pozycje z danymi o zmianie dziennej / wszystkie pozycje. */
  coveredCount: number;
  totalCount: number;
}

type ContributionSource = Pick<
  Position,
  | 'isin'
  | 'ticker'
  | 'paperName'
  | 'shares'
  | 'category'
  | 'dailyChangePct'
  | 'dailyChangeValue'
  | 'dailyChangeValuePln'
>;

/**
 * Z czego złożył się wynik dnia.
 *
 * Kwota pozycji jest w walucie bazowej portfela, liczona tak samo jak suma
 * w `summarizeDayChange` na serwerze (PLN → `dailyChangeValuePln`, portfel
 * walutowy → wartości natywne) — inaczej wiersze nie dodawałyby się do nagłówka.
 *
 * - pozycja bez danych nie trafia na listę ani do „reszty" (nie udaje zera),
 * - ranking kwotowy porządkuje po WARTOŚCI BEZWZGLĘDNEJ: pytanie brzmi „co
 *   najmocniej ruszyło wynikiem", kierunek niesie kolor,
 * - ranking procentowy pomija opcje i pozycje krótkie: procent ceny opcji to
 *   nie jest ruch porównywalny z akcją, a dla shorta wzrost ceny jest stratą,
 * - pojedyncza pozycja poza limitem wchodzi na listę zamiast tworzyć „resztę"
 *   z jednego elementu.
 */
export function selectDayContributions(
  positions: ContributionSource[],
  {
    mode = 'value',
    limit = 5,
    useNative = false,
  }: { mode?: ContributionMode; limit?: number; useNative?: boolean } = {},
): DayContributions {
  const covered: Array<Omit<DayContribution, 'share'> & { rankable: boolean }> = [];
  for (const p of positions) {
    // Serwer liczy pozycję jako „pokrytą" tylko z obiema kwotami — trzymamy ten sam warunek.
    if (p.dailyChangeValuePln == null || p.dailyChangeValue == null) continue;
    covered.push({
      isin: p.isin,
      ticker: p.ticker,
      name: p.paperName,
      amount: useNative ? p.dailyChangeValue : p.dailyChangeValuePln,
      pct: p.dailyChangePct,
      linkable: p.category !== 'option',
      rankable: p.dailyChangePct != null && p.category !== 'option' && p.shares > 0,
    });
  }

  const counts = { coveredCount: covered.length, totalCount: positions.length };
  const byTicker = (a: { ticker: string }, b: { ticker: string }) =>
    a.ticker.localeCompare(b.ticker);
  const strip = ({ rankable: _rankable, ...row }: (typeof covered)[number]) => row;

  if (mode === 'pct') {
    const ranked = covered
      .filter((c) => c.rankable && c.pct !== 0)
      .sort((a, b) => Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0) || byTicker(a, b))
      .slice(0, limit);
    const max = Math.max(0, ...ranked.map((c) => Math.abs(c.pct ?? 0)));
    return {
      rows: ranked.map((c) => ({ ...strip(c), share: max > 0 ? Math.abs(c.pct ?? 0) / max : 0 })),
      rest: null,
      ...counts,
    };
  }

  const sorted = [...covered].sort(
    (a, b) => Math.abs(b.amount) - Math.abs(a.amount) || byTicker(a, b),
  );
  const cut = sorted.length - limit === 1 ? sorted.length : limit;
  const top = sorted.slice(0, cut).filter((c) => c.amount !== 0);
  const tail = sorted.slice(cut);
  const restAmount = tail.reduce((sum, c) => sum + c.amount, 0);
  const max = Math.max(0, ...top.map((c) => Math.abs(c.amount)), Math.abs(restAmount));
  const share = (amount: number) => (max > 0 ? Math.abs(amount) / max : 0);

  return {
    rows: top.map((c) => ({ ...strip(c), share: share(c.amount) })),
    rest:
      tail.length > 0 ? { amount: restAmount, count: tail.length, share: share(restAmount) } : null,
    ...counts,
  };
}
