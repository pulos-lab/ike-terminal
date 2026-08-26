/**
 * Kolory serii wykresów Lightweight Charts — lustro zmiennych --chart-*
 * z index.css (:root i .dark). LWC parsuje kolory własnym parserem i NIE
 * rozumie oklch(), więc wartości są przeliczone do hex (oklch → sRGB).
 * Przy zmianie palety w index.css zaktualizuj też tę mapę.
 */

/** Amber aktywnego portfela z PortfolioChart (primary dashboardu) — w trybie
 *  porównania aktywny zachowuje swój kolor z trybu pojedynczego. */
export const ACTIVE_SERIES_COLOR = { light: '#c27a0a', dark: '#f59e0b' } as const;

/** Kolor linii benchmarku — spójny z PortfolioChart; odróżnia się od serii
 *  portfeli także stylem (przerywana 1px vs ciągła 2px). */
export const BENCHMARK_COLOR = { light: '#787068', dark: '#71717a' } as const;

/**
 * Kolory DOKŁADANYCH portfeli w trybie porównania (aktywny ma własny amber).
 * Kolejność wg siły kontrastu z amberem, żeby przy 2-3 portfelach różnice były
 * największe: sage → błękit → rust → ochra (ochra najbliższa amberowi, więc na
 * końcu). Szary z --chart-2 jest CELOWO pominięty — to kolor linii benchmarku,
 * portfel w tym kolorze czytałoby się jak indeks.
 *   light: --chart-3, --chart-6, --chart-4, --chart-5
 */
export const COMPARE_SERIES_COLORS = {
  // oklch: (0.55 0.12 150) (0.55 0.12 245) (0.55 0.13 35) (0.65 0.08 85)
  light: ['#33854a', '#2677b2', '#b05139', '#a68c54'],
  // oklch: (0.7 0.12 150) (0.7 0.12 245) (0.65 0.15 35) (0.78 0.08 85)
  dark: ['#63b376', '#58a5e4', '#db684c', '#cfb47c'],
} as const;

/**
 * Kolor linii „Razem" (portfel łączony). Fiolet jest jedynym odcieniem spoza palety
 * porównania i benchmarku, więc suma nie myli się z żadną składową ani z indeksem;
 * dodatkowo rysujemy ją grubszą kreską (patrz ComparisonChart).
 *   oklch: (0.52 0.15 300) / (0.72 0.14 300)
 */
export const COMBINED_SERIES_COLOR = { light: '#7c50b8', dark: '#b18ce8' } as const;

/** Kolor i-tego DOKŁADANEGO portfela (i = 0 dla pierwszego po aktywnym). */
export function compareSeriesColor(index: number, isDark: boolean): string {
  const palette = isDark ? COMPARE_SERIES_COLORS.dark : COMPARE_SERIES_COLORS.light;
  return palette[index % palette.length];
}
