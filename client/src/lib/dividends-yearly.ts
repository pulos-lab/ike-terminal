/**
 * Roczne grupowanie dywidend per waluta — do wykresu słupkowego (stacked bars).
 *
 * Backend nie zwraca przeliczenia per rekord (DividendRecord ma tylko amount + currency),
 * więc NIE sumujemy różnych walut do jednej kwoty "PLN" — każda waluta to osobna seria.
 */

export interface DividendLike {
  date: string;
  amount: number;
  currency: string;
}

/** Wiersz wykresu: { year: '2024', PLN: 123.45, USD: 10.2 } */
export type YearlyDividendRow = { year: string } & Record<string, number | string>;

export interface YearlyDividendsByCurrency {
  rows: YearlyDividendRow[];
  /** Waluty obecne w danych — PLN pierwsza, reszta alfabetycznie. Kolejność serii na wykresie. */
  currencies: string[];
}

export function groupDividendsByYearAndCurrency(
  dividends: DividendLike[],
): YearlyDividendsByCurrency {
  const yearMap = new Map<string, Map<string, number>>();
  const currencySet = new Set<string>();

  for (const d of dividends) {
    const year = new Date(d.date).getFullYear().toString();
    const currency = d.currency || 'PLN';
    currencySet.add(currency);
    const perCurrency = yearMap.get(year) ?? new Map<string, number>();
    perCurrency.set(currency, (perCurrency.get(currency) ?? 0) + d.amount);
    yearMap.set(year, perCurrency);
  }

  const currencies = Array.from(currencySet).sort((a, b) => {
    if (a === 'PLN') return -1;
    if (b === 'PLN') return 1;
    return a.localeCompare(b);
  });

  const rows = Array.from(yearMap.entries())
    .map(([year, perCurrency]) => {
      const row: YearlyDividendRow = { year };
      for (const [currency, amount] of perCurrency) row[currency] = amount;
      return row;
    })
    .sort((a, b) => a.year.localeCompare(b.year));

  return { rows, currencies };
}
