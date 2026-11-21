import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';

interface ImportBadgeInput {
  quarantinePending?: number;
  orphanedSellsPending?: number;
  /** Importy uniwersalne — liczą się te oflagowane do ponownego wgrania. */
  batches?: Array<{ needsReimport?: boolean }>;
}

/**
 * Liczba spraw importu czekających na użytkownika: wiersze w skrzynce
 * „Do wyjaśnienia” + sprzedaże bez kupna + importy uniwersalne do ponownego
 * wgrania po korekcie mapowania.
 */
export function countImportIssues({
  quarantinePending = 0,
  orphanedSellsPending = 0,
  batches = [],
}: ImportBadgeInput): number {
  return quarantinePending + orphanedSellsPending + batches.filter((b) => b.needsReimport).length;
}

/**
 * Wspólny licznik dla wszystkich miejsc w powłoce (sidebar, menu mobilne, jego
 * przycisk). Klucze query współdzielone z hubem importu i GenericBatchesSection,
 * więc react-query robi z tego jedno zapytanie niezależnie od liczby wywołań.
 */
export function useImportBadgeCount(): number {
  const { data: importStatus } = useQuery({
    queryKey: QUERY_KEYS.importStatus,
    queryFn: api.getImportStatus,
  });
  const { data: genericBatches } = useQuery({
    queryKey: ['generic-batches'],
    queryFn: api.genericBatches,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return countImportIssues({
    quarantinePending: importStatus?.quarantinePending,
    orphanedSellsPending: importStatus?.orphanedSellsPending,
    batches: genericBatches?.batches,
  });
}

/** Etykieta dla czytników ekranu przy przycisku z licznikiem spraw importu. */
export function importIssuesLabel(count: number): string {
  if (count <= 0) return '';
  if (count === 1) return '1 sprawa importu do wyjaśnienia';
  const mod10 = count % 10;
  const mod100 = count % 100;
  const few = mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14);
  return `${count} ${few ? 'sprawy' : 'spraw'} importu do wyjaśnienia`;
}
