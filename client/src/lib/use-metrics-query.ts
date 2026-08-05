import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';

/**
 * Metryki dashboardu (kafle + hero KPI).
 *
 * Polling jest tu JAWNY, bo globalny `refetchInterval` zniknął z App.tsx —
 * odpalał się dla wszystkich query, także tych bez cen. `/metrics` niesie
 * wartość portfela, więc odświeżanie ma sens; interwał odpowiada TTL ceny
 * w sesji (poniżej i tak nie ma świeższych danych — źródło jest opóźnione
 * ~15 min). Oba widoki dzielą klucz, więc react-query robi z tego jedno
 * zapytanie.
 */
export function useMetricsQuery() {
  return useQuery({
    queryKey: QUERY_KEYS.metrics,
    queryFn: api.getMetrics,
    refetchInterval: 15 * 60 * 1000,
  });
}
