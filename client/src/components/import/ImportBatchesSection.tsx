import { useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import {
  Loader2, Undo2, CheckCircle, AlertCircle, AlertTriangle, Info,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SKIP_REASON_LABELS } from '@/lib/import-labels';
import type { ImportBatchInfo, RecordSource } from 'shared';

export function ImportBatchesSection({ sourceFilter }: { sourceFilter?: RecordSource }) {
  const queryClient = useQueryClient();
  const [resultMsg, setResultMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['import-batches'],
    queryFn: api.getImportBatches,
  });

  const batchResult = useQuery({
    queryKey: ['import-batch-result', expandedBatch],
    queryFn: () => api.getImportBatchResult(expandedBatch!),
    enabled: !!expandedBatch,
  });

  const quarantine = useQuery({
    queryKey: ['import-quarantine', expandedBatch],
    queryFn: () => api.getQuarantineByBatch(expandedBatch!),
    enabled: !!expandedBatch,
  });

  const undo = useMutation({
    mutationFn: (importBatch: string) => api.deleteImportBatch(importBatch),
    onSuccess: (result) => {
      void queryClient.invalidateQueries();
      setExpandedBatch(null);
      setResultMsg({
        ok: true,
        text: `Usunięto ${result.transactionsRemoved} transakcji i ${result.operationsRemoved} operacji.`,
      });
    },
    onError: (err) =>
      setResultMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Nie udało się cofnąć importu.',
      }),
  });

  const allBatches: ImportBatchInfo[] = data?.batches ?? [];
  const batches = useMemo(
    () =>
      sourceFilter
        ? allBatches.filter((b) => b.sources.includes(sourceFilter))
        : allBatches,
    [allBatches, sourceFilter],
  );
  if (batches.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        Poprzednie importy
      </p>

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

      <ul className="space-y-1">
        {batches.map((b) => {
          const isExpanded = expandedBatch === b.importBatch;
          const result = batchResult.data?.result;
          return (
            <li key={b.importBatch} className="border border-border rounded-md">
              <button
                type="button"
                onClick={() => setExpandedBatch(isExpanded ? null : b.importBatch)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-accent/50 transition-colors text-left"
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {b.importBatch}
                    {b.sources.length > 0 && (
                      <span className="ml-1.5 not-italic font-sans text-muted-foreground/60">
                        · {b.sources.join(', ')}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {b.firstDate && new Date(b.firstDate + 'T00:00:00Z').toLocaleDateString('pl-PL')}
                    {b.transactionsCount > 0 && ` · ${b.transactionsCount} tx`}
                    {b.operationsCount > 0 && ` · ${b.operationsCount} ops`}
                    {b.skippedCount > 0 && ` · ${b.skippedCount} pom.`}
                    {b.quarantineCount > 0 && (
                      <span className="text-warning"> · {b.quarantineCount} kw.</span>
                    )}
                  </span>
                </div>
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>

              {isExpanded && (
                <div className="border-t border-border px-3 py-3 space-y-3">
                  {/* Summary */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <SummaryCard
                      label="Transakcje"
                      value={b.transactionsCount}
                      detail={b.syntheticTransactionsCount ? `w tym ${b.syntheticTransactionsCount} syntetycznych` : undefined}
                    />
                    <SummaryCard label="Operacje" value={b.operationsCount} />
                    <SummaryCard
                      label="Pominięte"
                      value={b.skippedCount}
                      warn={b.skippedCount > 0}
                    />
                    <SummaryCard
                      label="Kwarantanna"
                      value={b.quarantineCount}
                      warn={b.quarantineCount > 0}
                    />
                  </div>

                  {/* Info messages */}
                  {b.info && b.info.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <Info className="h-3 w-3 text-info" />
                        Informacje ({b.info.length})
                      </p>
                      <ul className="space-y-0.5">
                        {b.info.map((msg, i) => (
                          <li key={i} className="text-[11px] text-info bg-info/5 border border-info/20 rounded px-2 py-1">
                            {msg}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Warnings */}
                  {b.warnings.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <AlertTriangle className="h-3 w-3 text-warning" />
                        Ostrzeżenia ({b.warnings.length})
                      </p>
                      <ul className="space-y-0.5">
                        {b.warnings.map((w, i) => (
                          <li key={i} className="text-[11px] text-muted-foreground bg-muted/30 rounded px-2 py-1">
                            {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Skipped rows from stored result */}
                  {result?.skipped && result.skipped.filter(s => s.reason !== 'redemption_reconciled' && s.reason !== 'bond_subscription_consumed').length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <AlertTriangle className="h-3 w-3 text-warning" />
                        Pominięte wiersze ({result.skipped.filter(s => s.reason !== 'redemption_reconciled' && s.reason !== 'bond_subscription_consumed').length})
                      </p>
                      <div className="max-h-48 overflow-y-auto space-y-0.5">
                        {result.skipped.filter(s => s.reason !== 'redemption_reconciled' && s.reason !== 'bond_subscription_consumed').map((s, i) => (
                          <div key={i} className="text-[11px] text-warning bg-warning/5 border border-warning/20 rounded px-2 py-1">
                            {s.paperName && <span className="font-medium">{s.paperName} </span>}
                            <span>(wiersz {s.row}) — {SKIP_REASON_LABELS[s.reason] || s.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Quarantine */}
                  {quarantine.data && quarantine.data.records.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <AlertCircle className="h-3 w-3 text-destructive" />
                        Kwarantanna ({quarantine.data.records.length} wierszy)
                      </p>
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {quarantine.data.records.map((q, i) => (
                          <div key={i} className="text-[11px] bg-background/50 rounded px-2 py-1 border border-border/30">
                            <span className={q.severity === 'malformed' ? 'text-destructive' : 'text-warning'}>
                              [{q.severity === 'malformed' ? 'STRUKTURA' : 'DANE'}] wiersz {q.rowNumber}:
                            </span>{' '}
                            {q.message}
                            {q.suggestions?.length ? (
                              <span className="text-muted-foreground/70"> Sugestia: {q.suggestions.join(', ')}</span>
                            ) : null}
                            <div className="text-muted-foreground/40 mt-0.5 truncate" title={q.raw.join(';')}>
                              surowe: {q.raw.join(';')}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {quarantine.isLoading && expandedBatch && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Ładowanie kwarantanny…
                    </div>
                  )}

                  {/* Undo */}
                  <div className="flex justify-end pt-1">
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7 text-xs"
                      disabled={undo.isPending}
                      onClick={() => undo.mutate(b.importBatch)}
                    >
                      {undo.isPending && undo.variables === b.importBatch ? (
                        <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Cofanie…</>
                      ) : (
                        <><Undo2 className="h-3 w-3 mr-1" /> Cofnij import</>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  warn,
  detail,
}: {
  label: string;
  value: number;
  warn?: boolean;
  detail?: string;
}) {
  return (
    <div className={`rounded border ${warn && value > 0 ? 'border-warning/30 bg-warning/5' : 'border-border/50 bg-muted/20'} px-2.5 py-1.5 text-center`}>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      {detail && <p className="text-[9px] text-muted-foreground/60 mt-0.5">{detail}</p>}
    </div>
  );
}
