import type { PortfolioHistoryPoint } from 'shared';

/** Jedna seria trybu porównania na dashboardzie: portfel + jego
 *  przefiltrowana/zrebase'owana historia. Aktywny portfel zawsze pierwszy. */
export interface CompareSeries {
  portfolioId: string;
  name: string;
  color: string;
  points: PortfolioHistoryPoint[];
}
