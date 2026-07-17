/**
 * Metryki ryzyko–zwrot instrumentu z serii cen zamknięcia (cache
 * price_history.db — zapełniany przy liczeniu historii portfela, zero sieci).
 * Zwrot = zmiana ceny za okres; zmienność = odchylenie standardowe dziennych
 * zwrotów annualizowane √252 (ta sama konwencja co Volatility portfela
 * w PerformanceStats).
 */

/** Minimum punktów, poniżej którego metryki są zbyt szumowe (≈ 3 miesiące sesji). */
export const MIN_RISK_RETURN_POINTS = 60;

export interface PricePoint {
  date: string;
  close: number;
}

export function computeRiskReturnFromPrices(
  prices: PricePoint[],
): { returnPct: number; volatilityPct: number; dataPoints: number } | null {
  // Zera/ujemne ceny (np. artefakty cache) psują zwroty — odfiltrowane wprost.
  const usable = prices.filter((p) => Number.isFinite(p.close) && p.close > 0);
  if (usable.length < MIN_RISK_RETURN_POINTS) return null;

  const dailyReturns: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    dailyReturns.push(usable[i].close / usable[i - 1].close - 1);
  }

  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length;
  const volatilityPct = Math.sqrt(variance) * Math.sqrt(252) * 100;
  const returnPct = (usable[usable.length - 1].close / usable[0].close - 1) * 100;

  return { returnPct, volatilityPct, dataPoints: usable.length };
}
