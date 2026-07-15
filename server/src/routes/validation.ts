/**
 * Wspólne guardy wejścia dla route'ów. Osobny moduł (a nie portfolio.ts),
 * żeby wpięcia w handlery były jednolinijkowe i nie rozpychały hot-file'a.
 */

/** Data w formacie ISO YYYY-MM-DD (klient śle input type="date" / slice(0,10)). */
export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Skończona liczba (odrzuca NaN/±Infinity — JSON.parse('1e999') daje
 * Infinity i bez tego guardu ląduje w bazie).
 */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
