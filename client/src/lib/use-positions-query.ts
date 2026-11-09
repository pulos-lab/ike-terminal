import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';

/**
 * Otwarte pozycje z bieżącymi cenami — wspólne zapytanie Portfela, paska metryk
 * i dashboardu (jeden klucz, więc react-query robi z tego jedno żądanie).
 *
 * Tempo odświeżania dyktuje serwer przez `quotes.nextRefreshAt` (TTL wg stanu
 * rynku): co ~15 min w trakcie sesji, co kilka godzin po zamknięciu, praktycznie
 * zero pollingu w weekend. Sztywne 15 min nie miało związku z tym, kiedy dane
 * faktycznie się zmieniają.
 */
export function usePositionsQuery() {
  return useQuery({
    queryKey: QUERY_KEYS.positions,
    queryFn: api.getPositions,
    refetchInterval: (query) => {
      const next = query.state.data?.quotes?.nextRefreshAt;
      const ms = next ? Date.parse(next) - Date.now() : NaN;
      return Number.isFinite(ms) ? Math.max(ms, 60_000) : 15 * 60 * 1000;
    },
  });
}
