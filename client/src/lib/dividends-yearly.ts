/**
 * Grupowanie dywidend per okres (rok/miesiąc) i waluta — do wykresu słupkowego
 * (stacked bars).
 *
 * Backend nie zwraca przeliczenia per rekord (DividendRecord ma tylko amount + currency),
 * więc NIE sumujemy różnych walut do jednej kwoty "PLN" — każda waluta to osobna seria.
 */

export interface DividendLike {
  date: string;
  amount: number;
  currency: string;
}

/** Wiersz wykresu: { year: '2024', PLN: 123.45, USD: 10.2 } — `year` to klucz okresu. */
export type YearlyDividendRow = { year: string } & Record<string, number | string>;

export interface YearlyDividendsByCurrency {
  rows: YearlyDividendRow[];
  /** Waluty obecne w danych — PLN pierwsza, reszta alfabetycznie. Kolejność serii na wykresie. */
  currencies: string[];
}

/** Wspólny rdzeń: grupowanie po dowolnym kluczu okresu (sortowalnym leksykograficznie). */
function groupByPeriodAndCurrency(
  dividends: DividendLike[],
  periodKey: (date: string) => string,
): YearlyDividendsByCurrency {
  const periodMap = new Map<string, Map<string, number>>();
  const currencySet = new Set<string>();

  for (const d of dividends) {
    const period = periodKey(d.date);
    const currency = d.currency || 'PLN';
    currencySet.add(currency);
    const perCurrency = periodMap.get(period) ?? new Map<string, number>();
    perCurrency.set(currency, (perCurrency.get(currency) ?? 0) + d.amount);
    periodMap.set(period, perCurrency);
  }

  const currencies = Array.from(currencySet).sort((a, b) => {
    if (a === 'PLN') return -1;
    if (b === 'PLN') return 1;
    return a.localeCompare(b);
  });

  const rows = Array.from(periodMap.entries())
    .map(([year, perCurrency]) => {
      const row: YearlyDividendRow = { year };
      for (const [currency, amount] of perCurrency) row[currency] = amount;
      return row;
    })
    .sort((a, b) => a.year.localeCompare(b.year));

  return { rows, currencies };
}

export function groupDividendsByYearAndCurrency(
  dividends: DividendLike[],
): YearlyDividendsByCurrency {
  return groupByPeriodAndCurrency(dividends, (date) => new Date(date).getFullYear().toString());
}

/**
 * Miesięczne grupowanie ("YYYY-MM") — dla portfeli bez pełnej historii rocznej
 * (wykres roczny z jednym słupkiem nic nie mówi) i do oglądania sezonowości wypłat.
 *
 * Klucz bierzemy ze STRINGA daty, nie przez `new Date()` — data domenowa jest
 * kalendarzowa, a parsowanie 'YYYY-MM-DD' jako UTC cofa miesiąc w strefach na
 * zachód od UTC (ta sama pułapka co w formatterach dat).
 *
 * Miesiące bez wypłat dostają puste słupki — inaczej oś czasu ściskałaby się
 * i ukrywała sezonowość (na GPW wypłaty kumulują się latem).
 */
export function groupDividendsByMonthAndCurrency(
  dividends: DividendLike[],
): YearlyDividendsByCurrency {
  const grouped = groupByPeriodAndCurrency(dividends, (date) => date.slice(0, 7));
  if (grouped.rows.length < 2) return grouped;

  const filled: YearlyDividendRow[] = [];
  const last = grouped.rows[grouped.rows.length - 1].year;
  const byPeriod = new Map(grouped.rows.map((r) => [r.year, r]));

  let [y, m] = grouped.rows[0].year.split('-').map(Number);
  for (let key = grouped.rows[0].year; key <= last; ) {
    filled.push(byPeriod.get(key) ?? { year: key });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    key = `${y}-${String(m).padStart(2, '0')}`;
  }

  return { rows: filled, currencies: grouped.currencies };
}
