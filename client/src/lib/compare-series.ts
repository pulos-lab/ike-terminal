import type { PortfolioHistoryPoint } from 'shared';

/** Sztuczny identyfikator serii „Łącznie" — poza formatem UUID portfeli,
 *  więc nie koliduje z żadnym realnym id. */
export const COMBINED_SERIES_ID = '__combined__';

/** Jedna seria trybu porównania na dashboardzie: portfel + jego
 *  przefiltrowana/zrebase'owana historia. Aktywny portfel zawsze pierwszy. */
export interface CompareSeries {
  portfolioId: string;
  name: string;
  color: string;
  points: PortfolioHistoryPoint[];
  /** Grubość linii na wykresie (domyślnie 2). Seria „Łącznie" dostaje 3 —
   *  agregat odróżnia się od składników nie tylko kolorem. */
  lineWidth?: 1 | 2 | 3 | 4;
}
