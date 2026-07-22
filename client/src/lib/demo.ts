import type { QueryClient } from '@tanstack/react-query';
import { DEMO_PORTFOLIO_ID } from 'shared';
import { getActivePortfolioId, setActivePortfolioId } from './api-client';

/**
 * Tryb demo: gość (bez sesji) przegląda współdzielony portfel demo w prawdziwym
 * /app. Jedynym nośnikiem stanu jest activePortfolioId === 'demo' — serwer
 * rozpoznaje ten sam identyfikator w nagłówku X-Portfolio-Id (demo-access
 * middleware, tylko GET-y). Wejście/wyjście czyści cache react-query, żeby
 * dane portfela demo i realnego użytkownika nigdy się nie przeplatały.
 */

export function isDemoMode(): boolean {
  return getActivePortfolioId() === DEMO_PORTFOLIO_ID;
}

export function enterDemo(queryClient: QueryClient): void {
  setActivePortfolioId(DEMO_PORTFOLIO_ID);
  queryClient.clear();
}

export function exitDemo(queryClient: QueryClient): void {
  // 'default' to bezpieczny fallback: dla gościa nie ma znaczenia (wraca na
  // landing), a po zalogowaniu ghost-detection w PortfolioProvider i tak
  // przestawi na pierwszy realny portfel użytkownika.
  setActivePortfolioId('default');
  queryClient.clear();
}
