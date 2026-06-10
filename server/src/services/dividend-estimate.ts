/**
 * Estymacja kwoty dywidendy per akcja dla nadchodzącej wypłaty.
 *
 * Preferuje kwotę OSTATNIEJ realnej dywidendy z historii zdarzeń (Yahoo) —
 * to najlepszy predyktor kolejnej wypłaty niezależnie od częstotliwości
 * (kwartalna/półroczna/roczna). Gdy brak zdarzeń, fallback z rocznej stawki
 * podzielonej przez liczbę wypłat w roku: 4 dla rynków o dominującym schemacie
 * kwartalnym (US), 1 dla spółek GPW (wypłata roczna) — Yahoo często nie ma
 * eventów historycznych dla .WA (np. KGH, PEO), a dzielenie rocznej stawki
 * przez 4 zaniżało estymatę czterokrotnie.
 */
export function estimateDividendPerShare(
  events: Array<{ date: string; amount: number }>,
  annualRate: number,
  payoutsPerYear: number = 4,
): number | null {
  let latest: { date: string; amount: number } | null = null;
  for (const event of events) {
    if (event.amount <= 0) continue;
    if (!latest || event.date > latest.date) latest = event;
  }
  if (latest) return latest.amount;
  if (annualRate <= 0 || payoutsPerYear <= 0) return null;
  return annualRate / payoutsPerYear;
}

/** Liczba wypłat dywidendy w roku zakładana dla tickera (fallback estymaty). */
export function assumedPayoutsPerYear(ticker: string): number {
  // GPW: dywidenda wypłacana raz w roku (po WZA zatwierdzającym podział zysku).
  if (ticker.toUpperCase().endsWith('.WA')) return 1;
  return 4;
}
