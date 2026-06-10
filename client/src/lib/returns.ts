import type { PortfolioHistoryPoint } from 'shared';

/**
 * Zwrot za okres między dwoma punktami SKUMULOWANYCH zwrotów procentowych
 * (chain-linking). Skumulowane procenty nie składają się addytywnie:
 * portfel na +100%, który urósł do +110%, zarobił w okresie
 * (2.10 / 2.00 − 1) = +5%, a nie 110 − 100 = +10 p.p.
 */
export function chainLinkPct(endPct: number, startPct: number): number {
  const startIndex = 1 + startPct / 100;
  if (startIndex <= 0) return endPct - startPct; // degeneracja (≤ −100%) — bezpieczny fallback
  return ((1 + endPct / 100) / startIndex - 1) * 100;
}

/** Data początku zakresu dla presetów 1M/3M/6M/YTD/1Y/3Y; ALL → undefined. */
export function getPresetStartDate(range: string): string | undefined {
  const now = new Date();
  if (range === 'ALL') return undefined;
  if (range === 'YTD') return `${now.getFullYear()}-01-01`;
  const days: Record<string, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '3Y': 1095 };
  const d = new Date(now.getTime() - (days[range] || 0) * 86400000);
  return d.toISOString().split('T')[0];
}

/**
 * Filtruje historię do zakresu dat i rebase'uje, żeby pierwszy widoczny punkt = 0%.
 * Rebase chain-linkingiem — skumulowane procenty nie składają się addytywnie,
 * dzielimy indeksy (1 + pct/100) zamiast odejmować punkty procentowe.
 * Współdzielone przez DashboardPage i publiczną stronę share.
 */
export function filterAndRebaseHistory(
  history: PortfolioHistoryPoint[],
  startDate?: string,
  endDate?: string,
): PortfolioHistoryPoint[] {
  if (!history.length) return [];

  let filtered = history;
  if (startDate) {
    filtered = filtered.filter((p) => p.date >= startDate);
  }
  if (endDate) {
    filtered = filtered.filter((p) => p.date <= endDate);
  }

  if (!filtered.length) return [];
  if (!startDate && !endDate) return filtered; // ALL — no rebase needed

  const base = filtered[0];

  return filtered.map((p) => ({
    ...p,
    returnPct: chainLinkPct(p.returnPct, base.returnPct),
    benchmarkReturnPct: chainLinkPct(p.benchmarkReturnPct, base.benchmarkReturnPct),
    twrPct: chainLinkPct(p.twrPct, base.twrPct),
    benchmarkTwrPct: chainLinkPct(p.benchmarkTwrPct, base.benchmarkTwrPct),
  }));
}
