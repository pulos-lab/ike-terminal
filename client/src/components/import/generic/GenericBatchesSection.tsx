import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';

/**
 * Poprzednie importy uniwersalne tego portfela — domyka pętlę kuracji z F5:
 * gdy admin zatwierdzi poprawiony profil, batch dostaje flagę needsReimport,
 * a użytkownik widzi tu przycisk „Przetwórz ponownie" (idempotentny re-import
 * z przechowanego pliku przy użyciu aktualnego profilu).
 */
export function GenericBatchesSection() {
  const queryClient = useQueryClient();
  const [resultMsg, setResultMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data } = useQuery({
    queryKey: ['generic-batches'],
    queryFn: api.genericBatches,
  });

  const reimport = useMutation({
    mutationFn: (importBatch: string) => api.genericReimport(importBatch),
    onSuccess: (result) => {
      void queryClient.invalidateQueries();
      const added = (result.transactionsImported ?? 0) + (result.operationsImported ?? 0);
      setResultMsg({
        ok: true,
        text:
          `Przetworzono ponownie poprawionym profilem. ` +
          (added > 0
            ? `Nowe wiersze: ${added}.`
            : 'Dane bez zmian (wszystko już było zaimportowane).'),
      });
    },
    onError: (err) =>
      setResultMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Nie udało się przetworzyć ponownie.',
      }),
  });

  const batches = data?.batches ?? [];
  if (batches.length === 0) return null;

  const flagged = batches.filter((b) => b.needsReimport);

  return (
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        Twoje poprzednie importy uniwersalne
      </p>
      {flagged.length > 0 && (
        <div className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-xs text-info">
          Administrator poprawił mapowanie {flagged.length === 1 ? 'formatu' : 'formatów'} —{' '}
          {flagged.length === 1 ? '1 import czeka' : `${flagged.length} importy czekają`} na
          ponowne przetworzenie. To bezpieczne: istniejące wiersze nie zostaną zdublowane.
        </div>
      )}
      {resultMsg && (
        <div
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            resultMsg.ok
              ? 'border-success/30 bg-success/5 text-success'
              : 'border-destructive/30 bg-destructive/5 text-destructive'
          }`}
        >
          {resultMsg.ok ? (
            <CheckCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          )}
          {resultMsg.text}
        </div>
      )}
      <ul className="space-y-1.5">
        {batches.map((b) => (
          <li
            key={b.importBatch}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">
                {b.fileName ?? b.importBatch}
                {b.brokerLabel && (
                  <span className="ml-1.5 text-muted-foreground">· {b.brokerLabel}</span>
                )}
              </span>
              <span className="text-muted-foreground">
                {new Date(b.importedAt + (b.importedAt.endsWith('Z') ? '' : 'Z')).toLocaleDateString(
                  'pl-PL',
                )}{' '}
                · profil v{b.profileVersion}
              </span>
            </span>
            {b.needsReimport ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs shrink-0 border-info/50 text-info"
                disabled={reimport.isPending}
                onClick={() => reimport.mutate(b.importBatch)}
              >
                {reimport.isPending && reimport.variables === b.importBatch ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                <span className="ml-1">Przetwórz ponownie</span>
              </Button>
            ) : (
              <span className="text-muted-foreground shrink-0">aktualny</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
