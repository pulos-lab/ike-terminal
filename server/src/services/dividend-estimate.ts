/**
 * Estymacja kwoty dywidendy per akcja dla nadchodzącej wypłaty.
 *
 * Preferuje kwotę OSTATNIEJ realnej dywidendy z historii zdarzeń (Yahoo) —
 * to najlepszy predyktor kolejnej wypłaty niezależnie od częstotliwości
 * (kwartalna/półroczna/roczna). Gdy brak zdarzeń, fallback annualRate / 4
 * (większość płatników w US wypłaca kwartalnie; poprzednia heurystyka /2
 * zawyżała estymatę 2x).
 */
export function estimateDividendPerShare(
  events: Array<{ date: string; amount: number }>,
  annualRate: number,
): number | null {
  let latest: { date: string; amount: number } | null = null;
  for (const event of events) {
    if (event.amount <= 0) continue;
    if (!latest || event.date > latest.date) latest = event;
  }
  if (latest) return latest.amount;
  return annualRate > 0 ? annualRate / 4 : null;
}
