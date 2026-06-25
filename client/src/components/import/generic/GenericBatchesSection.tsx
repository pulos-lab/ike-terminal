import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Loader2, Upload, CheckCircle, AlertCircle } from 'lucide-react';

/**
 * Poprzednie importy uniwersalne tego portfela — domyka pętlę kuracji z F5:
 * gdy admin zatwierdzi poprawiony profil, batch dostaje flagę needsReimport,
 * a użytkownik wgrywa plik PONOWNIE (plików nie przechowujemy). Re-import używa
 * aktualnego profilu i zastępuje stary batch (ten sam import_batch).
 */
export function GenericBatchesSection() {
  const queryClient = useQueryClient();
  const [resultMsg, setResultMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data } = useQuery({
    queryKey: ['generic-batches'],
    queryFn: api.genericBatches,
  });

  const reimport = useMutation({
    mutationFn: ({ importBatch, file }: { importBatch: string; file: File }) =>
      api.genericReimport(importBatch, file),
    // uploadFile NIE rzuca na błędy HTTP — zły plik (400) wraca jako success:false.
    onSuccess: (result) => {
      if (!result.success) {
        setResultMsg({
          ok: false,
          text: result.error || result.errors?.join('; ') || 'Nie udało się przetworzyć ponownie.',
        });
        return;
      }
      void queryClient.invalidateQueries();
      setResultMsg({
        ok: true,
        text: 'Zaimportowano ponownie z poprawionym mapowaniem. Stary import został zastąpiony.',
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
          poprawkę. Wgraj ponownie ten sam plik — plików nie przechowujemy, więc korekta wymaga
          wgrania go jeszcze raz. Stary, błędnie zmapowany import zostanie zastąpiony.
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
              <label
                className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-info/50 px-2 text-xs text-info hover:bg-info/10 ${
                  reimport.isPending ? 'pointer-events-none opacity-60' : ''
                }`}
              >
                {reimport.isPending && reimport.variables?.importBatch === b.importBatch ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Upload className="h-3 w-3" />
                )}
                <span>Wgraj plik ponownie</span>
                <input
                  type="file"
                  accept=".csv,.xlsx"
                  className="hidden"
                  disabled={reimport.isPending}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) reimport.mutate({ importBatch: b.importBatch, file });
                  }}
                />
              </label>
            ) : (
              <span className="text-muted-foreground shrink-0">aktualny</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
