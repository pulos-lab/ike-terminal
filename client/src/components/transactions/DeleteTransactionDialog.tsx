import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDate, formatNumber, formatQuantity } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { AlertTriangle, Check, Info, Loader2, Sparkles, Trash2 } from 'lucide-react';

interface DeleteTarget {
  id: number;
  date: string;
  ticker: string;
  isin: string;
  side: 'K' | 'S';
  quantity: number;
  price: number;
  commission: number;
  currency: string;
  syntheticOrigin?: string;
}

interface Props {
  target: DeleteTarget | null;
  onClose: () => void;
}

type Mode = 'single' | 'smart' | 'multi';

export function DeleteTransactionDialog({ target, onClose }: Props) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('single');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Reset state when target changes
  useEffect(() => {
    if (target) {
      setMode('single');
      setSelectedIds(new Set([target.id]));
      setError(null);
    }
  }, [target?.id]);

  const { data: fifoData, isLoading: fifoLoading } = useQuery({
    queryKey: QUERY_KEYS.fifoMatching(target?.isin ?? ''),
    queryFn: () => api.getFifoMatching(target!.isin),
    enabled: !!target,
    staleTime: 30_000,
  });

  const { data: smartPreview, isLoading: smartLoading } = useQuery({
    queryKey: QUERY_KEYS.smartDeletePreview(target?.id ?? -1),
    queryFn: () => api.smartDeletePreview(target!.id),
    enabled: !!target,
    staleTime: 30_000,
  });

  const singleMutation = useMutation({
    mutationFn: (id: number) => api.deleteTransaction(id),
    onSuccess: () => {
      invalidatePortfolio(queryClient);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const bulkMutation = useMutation({
    mutationFn: (ids: number[]) => api.bulkDeleteTransactions(ids),
    onSuccess: () => {
      invalidatePortfolio(queryClient);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const smartMutation = useMutation({
    mutationFn: (id: number) => api.smartDeleteApply(id),
    onSuccess: () => {
      invalidatePortfolio(queryClient);
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const isPending = singleMutation.isPending || bulkMutation.isPending || smartMutation.isPending;

  // Target row — derived FIFO status (from fetched matching)
  const targetFifo = useMemo(() => {
    if (!target || !fifoData) return null;
    return fifoData.transactions.find((t) => t.txId === target.id) ?? null;
  }, [target, fifoData]);

  // FIFO consequence analysis for "single" mode warnings
  const singleModeWarnings = useMemo(() => {
    if (!target || !targetFifo) return [];
    const warnings: string[] = [];
    if (targetFifo.side === 'K' && targetFifo.status !== 'open') {
      const orphanedSells = targetFifo.matches.length;
      const matchedQty = targetFifo.matchedQty;
      warnings.push(
        `Ta transakcja K była dopasowana do ${orphanedSells} sprzedaż${orphanedSells === 1 ? 'y' : 'y'} (${formatQuantity(matchedQty)} akcji). Po usunięciu odpowiednie sprzedaże mogą wyjść "oversold" — silnik wykryje to i może potraktować jako split.`,
      );
    }
    if (targetFifo.side === 'S' && targetFifo.status === 'orphan') {
      warnings.push(
        'Ta sprzedaż nie ma matchującej K (oversold). Usunięcie jest czysto kosmetyczne.',
      );
    }
    return warnings;
  }, [target, targetFifo]);

  // Multi-select mode: list all ISIN transactions, sorted K→S, by date
  const isinTransactions = useMemo(() => {
    if (!fifoData) return [];
    return [...fifoData.transactions].sort((a, b) => {
      if (a.side !== b.side) return a.side === 'K' ? -1 : 1;
      return a.date.localeCompare(b.date);
    });
  }, [fifoData]);

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!fifoData) return;
    setSelectedIds(new Set(fifoData.transactions.map((t) => t.txId)));
  };
  const selectSide = (side: 'K' | 'S') => {
    if (!fifoData) return;
    setSelectedIds(
      new Set(fifoData.transactions.filter((t) => t.side === side).map((t) => t.txId)),
    );
  };
  const selectNone = () => setSelectedIds(new Set());

  const handleConfirm = () => {
    if (!target) return;
    setError(null);
    if (mode === 'single') {
      singleMutation.mutate(target.id);
    } else if (mode === 'smart') {
      if (smartPreview?.unsupported) {
        setError(smartPreview.unsupported);
        return;
      }
      smartMutation.mutate(target.id);
    } else if (mode === 'multi') {
      if (selectedIds.size === 0) {
        setError('Zaznacz przynajmniej jedną transakcję.');
        return;
      }
      bulkMutation.mutate([...selectedIds]);
    }
  };

  const smartAvailable = !!smartPreview && !smartPreview.unsupported;
  const smartTotalAffected = smartPreview
    ? (smartPreview.deletes?.length ?? 0) + (smartPreview.edits?.length ?? 0)
    : 0;

  return (
    <TooltipProvider delayDuration={150}>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) onClose();
        }}
      >
        <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <DialogTitle>Usunąć transakcję?</DialogTitle>
            </div>
            <DialogDescription asChild>
              <div className="pt-2">
                {target && (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                    <div className="flex items-center gap-2 mb-1">
                      <SideChip side={target.side} />
                      <span className="font-mono font-semibold text-foreground">
                        {target.ticker}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        · {formatDate(target.date)}
                      </span>
                      {target.syntheticOrigin && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3 w-3 text-amber-500/80 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[280px] text-xs">
                            Auto-wygenerowana: {target.syntheticOrigin}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatQuantity(target.quantity)} × {formatNumber(target.price)}{' '}
                      {target.currency}
                      {target.commission > 0 && <> · prow. {formatNumber(target.commission)}</>}
                    </div>
                  </div>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>

          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList className="w-full">
              <TabsTrigger value="single" className="flex-1">
                <Trash2 className="h-3.5 w-3.5" />
                Tylko ta
              </TabsTrigger>
              <TabsTrigger
                value="smart"
                className="flex-1"
                disabled={!smartAvailable && !smartLoading}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Smart FIFO
                {smartAvailable && smartTotalAffected > 1 && (
                  <span className="ml-1 text-[10px] rounded-sm bg-primary/10 text-primary px-1">
                    {smartTotalAffected}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="multi" className="flex-1">
                Wybierz
                {selectedIds.size > 0 && mode === 'multi' && (
                  <span className="ml-1 text-[10px] rounded-sm bg-primary/10 text-primary px-1">
                    {selectedIds.size}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="single" className="space-y-2 mt-2">
              <p className="text-xs text-muted-foreground">
                Usunięta zostanie tylko ta jedna transakcja. Pozostałe transakcje tego papieru
                zachowane.
              </p>
              {fifoLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Analiza FIFO...
                </div>
              )}
              {singleModeWarnings.length > 0 && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 space-y-1">
                  {singleModeWarnings.map((w, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 text-[11px] text-amber-600 dark:text-amber-400"
                    >
                      <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="smart" className="space-y-2 mt-2">
              {smartLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Liczenie planu FIFO...
                </div>
              )}
              {smartPreview?.unsupported && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 flex items-start gap-2 text-[11px] text-destructive">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>{smartPreview.unsupported}</span>
                </div>
              )}
              {smartAvailable && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Silnik sam wyliczy które transakcje trzeba dodatkowo usunąć albo proporcjonalnie
                    zmniejszyć, tak żeby FIFO pozostało spójne.
                  </p>
                  <div className="rounded-md border border-border bg-background overflow-hidden">
                    <div className="border-b border-border bg-muted/40 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground flex items-center justify-between">
                      <span>Plan zmian</span>
                      <span className="tabular-nums">
                        {smartPreview.deletes.length} usunięć · {smartPreview.edits.length} edycji
                      </span>
                    </div>
                    <div className="max-h-[200px] overflow-y-auto">
                      {smartPreview.deletes.map((id) => {
                        const tx = fifoData?.transactions.find((t) => t.txId === id);
                        if (!tx) return null;
                        return (
                          <div
                            key={`del-${id}`}
                            className="flex items-center gap-2 px-2 py-1.5 text-xs border-b border-border/50 last:border-0"
                          >
                            <Trash2 className="h-3 w-3 text-destructive shrink-0" />
                            <span className="font-mono w-5">
                              <SideChip side={tx.side} />
                            </span>
                            <span className="tabular-nums w-[80px] text-right">
                              {formatQuantity(tx.quantity)}
                            </span>
                            <span className="text-muted-foreground tabular-nums w-[80px] text-right">
                              {formatNumber(tx.price)}
                            </span>
                            <span className="text-muted-foreground flex-1">
                              {formatDate(tx.date)}
                            </span>
                            <span className="text-[10px] text-destructive">usuń</span>
                          </div>
                        );
                      })}
                      {smartPreview.edits.map((edit) => {
                        const tx = fifoData?.transactions.find((t) => t.txId === edit.txId);
                        if (!tx) return null;
                        return (
                          <div
                            key={`edit-${edit.txId}`}
                            className="flex items-center gap-2 px-2 py-1.5 text-xs border-b border-border/50 last:border-0"
                          >
                            <Check className="h-3 w-3 text-amber-500 shrink-0" />
                            <span className="font-mono w-5">
                              <SideChip side={tx.side} />
                            </span>
                            <span className="tabular-nums w-[80px] text-right">
                              <span className="text-muted-foreground line-through">
                                {formatQuantity(edit.originalQuantity)}
                              </span>
                              <span className="ml-1">{formatQuantity(edit.newQuantity)}</span>
                            </span>
                            <span className="text-muted-foreground tabular-nums w-[80px] text-right">
                              {formatNumber(tx.price)}
                            </span>
                            <span className="text-muted-foreground flex-1">
                              {formatDate(tx.date)}
                            </span>
                            <span className="text-[10px] text-amber-500">edytuj qty</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {smartPreview.warnings.length > 0 && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 space-y-1">
                      {smartPreview.warnings.map((w, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-2 text-[11px] text-amber-600 dark:text-amber-400"
                        >
                          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent value="multi" className="space-y-2 mt-2">
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className="mr-1">Szybkie zaznaczenie:</span>
                <button className="underline hover:text-foreground" onClick={selectAll}>
                  wszystkie
                </button>
                <span>·</span>
                <button className="underline hover:text-foreground" onClick={() => selectSide('K')}>
                  K
                </button>
                <span>·</span>
                <button className="underline hover:text-foreground" onClick={() => selectSide('S')}>
                  S
                </button>
                <span>·</span>
                <button className="underline hover:text-foreground" onClick={selectNone}>
                  wyczyść
                </button>
              </div>
              <div className="rounded-md border border-border max-h-[260px] overflow-y-auto">
                {fifoLoading ? (
                  <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Ładowanie...
                  </div>
                ) : (
                  isinTransactions.map((tx) => {
                    const isSelected = selectedIds.has(tx.txId);
                    const isTarget = tx.txId === target?.id;
                    return (
                      <label
                        key={tx.txId}
                        className={cn(
                          'flex items-center gap-2 px-2 py-1.5 text-xs border-b border-border/50 last:border-0 cursor-pointer hover:bg-muted/50',
                          isSelected && 'bg-destructive/5',
                          isTarget && 'border-l-2 border-l-primary',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelected(tx.txId)}
                          className="h-3.5 w-3.5 accent-destructive"
                          disabled={!!tx.syntheticOrigin}
                        />
                        <SideChip side={tx.side} />
                        <span className="tabular-nums w-[80px] text-right">
                          {formatQuantity(tx.quantity)}
                        </span>
                        <span className="text-muted-foreground tabular-nums w-[80px] text-right">
                          {formatNumber(tx.price)}
                        </span>
                        <span className="text-muted-foreground flex-1">{formatDate(tx.date)}</span>
                        <StatusBadge status={tx.status} />
                        {tx.syntheticOrigin && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="h-3 w-3 text-amber-500/80" />
                            </TooltipTrigger>
                            <TooltipContent className="text-xs max-w-[240px]">
                              Auto-wygenerowana, nie można usunąć bezpośrednio.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
              {fifoData && (
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  Łącznie: {fifoData.transactions.length} transakcji · K:{' '}
                  {formatQuantity(fifoData.totalBuys)} · S: {formatQuantity(fifoData.totalSells)} ·
                  netto otwarte: {formatQuantity(fifoData.netOpenQty)}
                </div>
              )}
            </TabsContent>
          </Tabs>

          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose} disabled={isPending}>
              Anuluj
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirm}
              disabled={
                isPending ||
                (mode === 'multi' && selectedIds.size === 0) ||
                (mode === 'smart' && !smartAvailable)
              }
            >
              {isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {mode === 'single' && 'Usuń transakcję'}
              {mode === 'smart' &&
                `Usuń z kaskadą FIFO${smartTotalAffected > 1 ? ` (${smartTotalAffected})` : ''}`}
              {mode === 'multi' &&
                `Usuń zaznaczone${selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

function SideChip({ side }: { side: 'K' | 'S' }) {
  const isBuy = side === 'K';
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-md font-bold w-6 h-5 text-[11px]',
        isBuy ? 'bg-gain/15 text-gain' : 'bg-loss/15 text-loss',
      )}
    >
      {side}
    </span>
  );
}

function StatusBadge({ status }: { status: 'fully-matched' | 'partial' | 'open' | 'orphan' }) {
  const labels: Record<typeof status, { label: string; cls: string }> = {
    'fully-matched': { label: 'zamknięta', cls: 'bg-muted text-muted-foreground' },
    partial: { label: 'częściowa', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    open: { label: 'otwarta', cls: 'bg-gain/15 text-gain' },
    orphan: { label: 'oversold', cls: 'bg-loss/15 text-loss' },
  };
  const { label, cls } = labels[status];
  return (
    <span className={cn('text-[9px] uppercase px-1.5 py-0.5 rounded-sm tabular-nums', cls)}>
      {label}
    </span>
  );
}
