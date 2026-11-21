import type { ImportStatusResponse } from 'shared';

/**
 * Czy pokazać kartę „Pierwsze kroki” na dashboardzie.
 *
 * Portfel jest „pusty”, gdy nie ma ani jednej transakcji i ani jednej operacji
 * gotówkowej. Dopóki status się nie wczytał, karty NIE pokazujemy — mignięcie
 * onboardingu użytkownikowi z pełnym portfelem przy każdym wejściu byłoby
 * gorsze niż chwila pustego miejsca u nowego. W trybie demo portfel zawsze ma
 * dane, a gość nie może nic wgrać.
 */
export function shouldShowGettingStarted(
  status: Pick<ImportStatusResponse, 'transactions' | 'operations'> | undefined,
  demoMode: boolean,
): boolean {
  if (demoMode || !status) return false;
  return status.transactions + status.operations === 0;
}
