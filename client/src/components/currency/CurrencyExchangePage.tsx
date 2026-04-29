import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidateFx } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { CcyChip } from '@/components/ui/ccy-chip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { AddFxExchangeDialog } from './AddFxExchangeDialog';
import { formatNumber, formatDate } from '@/lib/formatters';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { useToggleSet } from '@/hooks/useToggleSet';
import type { FxExchangeRecord } from 'shared';

export function CurrencyExchangePage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.fxHistory,
    queryFn: api.getFxHistory,
  });

  const { data: pricesData } = useQuery({
    queryKey: QUERY_KEYS.livePrices,
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<FxExchangeRecord | null>(null);
  const [expandedFx, toggleFx] = useToggleSet<string>();

  const fx = pricesData?.fx;
  const usdEur = fx?.USDPLN && fx?.EURPLN ? fx.USDPLN / fx.EURPLN : null;

  const deleteMutation = useMutation({
    mutationFn: ({ fromId, toId }: { fromId: number; toId: number }) =>
      api.deleteFxExchange(fromId, toId),
    onSuccess: () => {
      invalidateFx(queryClient);
      const ex = deleting;
      if (ex) {
        toast.success(
          `Usunięto wymianę ${ex.currencyFrom} → ${ex.currencyTo} (${formatNumber(ex.amountFrom)} ${ex.currencyFrom})`,
        );
      } else {
        toast.success('Usunięto wymianę.');
      }
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(`Nie udało się usunąć: ${e.message}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Dodaj wymianę
        </Button>
      </div>

      {fx && (
        <div className="grid grid-cols-3 gap-2 md:gap-3">
          <Card>
            <CardContent className="px-3 py-2.5 md:pt-4 md:pb-3 md:px-6">
              <div className="text-[11px] md:text-sm text-muted-foreground">USD/PLN</div>
              <div className="text-base md:text-2xl font-bold font-mono">
                {formatNumber(fx.USDPLN, 4)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="px-3 py-2.5 md:pt-4 md:pb-3 md:px-6">
              <div className="text-[11px] md:text-sm text-muted-foreground">EUR/PLN</div>
              <div className="text-base md:text-2xl font-bold font-mono">
                {formatNumber(fx.EURPLN, 4)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="px-3 py-2.5 md:pt-4 md:pb-3 md:px-6">
              <div className="text-[11px] md:text-sm text-muted-foreground">USD/EUR</div>
              <div className="text-base md:text-2xl font-bold font-mono">
                {usdEur ? formatNumber(usdEur, 4) : '—'}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Historia wymian walut</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSpinner />
          ) : !data?.exchanges?.length ? (
            <div className="text-center py-12 text-muted-foreground text-sm">Brak danych.</div>
          ) : (
            <>
              <div className="md:hidden flex flex-col gap-2">
                {data.exchanges.map((ex: FxExchangeRecord, i: number) => {
                  const key = `${ex.fromOperationId ?? i}-${ex.toOperationId ?? i}`;
                  const isExpanded = expandedFx.has(key);
                  return (
                    <div
                      key={key}
                      className="rounded-xl border border-border bg-card overflow-hidden"
                    >
                      <div
                        className="p-3 flex flex-col gap-1 cursor-pointer hover:bg-muted/40 active:bg-muted/60 transition-colors"
                        onClick={() => toggleFx(key)}
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleFx(key);
                          }
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            )}
                            <CcyChip ccy={ex.currencyFrom} />
                            <span className="text-muted-foreground text-xs">→</span>
                            <CcyChip ccy={ex.currencyTo} />
                          </div>
                          <span className="font-mono font-semibold text-sm tabular-nums shrink-0">
                            {formatNumber(ex.rate, 4)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-[11px] pl-5">
                          <span className="tabular-nums truncate">
                            <span className="text-loss">
                              −{formatNumber(ex.amountFrom)} {ex.currencyFrom}
                            </span>
                            <span className="text-muted-foreground mx-1">→</span>
                            <span className="text-gain">
                              +{formatNumber(ex.amountTo)} {ex.currencyTo}
                            </span>
                          </span>
                          <span className="text-muted-foreground tabular-nums shrink-0">
                            {formatDate(ex.date)}
                          </span>
                        </div>
                      </div>
                      {isExpanded && (
                        <div
                          className="bg-muted/20 border-t border-border px-3 py-2.5 flex flex-col gap-1 text-[11px]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex justify-between gap-3 items-baseline">
                            <span className="text-muted-foreground">Kwota (z)</span>
                            <span className="tabular-nums text-right text-loss">
                              −{formatNumber(ex.amountFrom)} {ex.currencyFrom}
                            </span>
                          </div>
                          <div className="flex justify-between gap-3 items-baseline">
                            <span className="text-muted-foreground">Kwota (na)</span>
                            <span className="tabular-nums text-right text-gain">
                              +{formatNumber(ex.amountTo)} {ex.currencyTo}
                            </span>
                          </div>
                          <div className="flex justify-between gap-3 items-baseline">
                            <span className="text-muted-foreground">Kurs</span>
                            <span className="tabular-nums text-right">{formatNumber(ex.rate, 4)}</span>
                          </div>
                          {ex.source === 'manual' && (
                            <div className="flex justify-end pt-1">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={deleteMutation.isPending}
                                onClick={() => setDeleting(ex)}
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3 mr-1" />
                                Usuń
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data</TableHead>
                      <TableHead>Para</TableHead>
                      <TableHead className="text-right">Kurs</TableHead>
                      <TableHead className="text-right">Kwota (z)</TableHead>
                      <TableHead className="text-right">Kwota (na)</TableHead>
                      <TableHead className="w-[60px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.exchanges.map((ex: FxExchangeRecord, i: number) => (
                      <TableRow key={i}>
                        <TableCell className="tabular-nums">{formatDate(ex.date)}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1">
                            <CcyChip ccy={ex.currencyFrom} />
                            <span className="text-muted-foreground text-xs">→</span>
                            <CcyChip ccy={ex.currencyTo} />
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatNumber(ex.rate, 4)}
                        </TableCell>
                        <TableCell className="text-right text-loss tabular-nums">
                          −{formatNumber(ex.amountFrom)} {ex.currencyFrom}
                        </TableCell>
                        <TableCell className="text-right text-gain tabular-nums">
                          +{formatNumber(ex.amountTo)} {ex.currencyTo}
                        </TableCell>
                        <TableCell>
                          {ex.source === 'manual' && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              disabled={deleteMutation.isPending}
                              onClick={() => setDeleting(ex)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AddFxExchangeDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <ConfirmDeleteDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting?.fromOperationId && deleting?.toOperationId) {
            deleteMutation.mutate({
              fromId: deleting.fromOperationId,
              toId: deleting.toOperationId,
            });
          }
        }}
        description={
          deleting
            ? `Usunąć wymianę ${deleting.currencyFrom} → ${deleting.currencyTo} z ${formatDate(deleting.date)} (−${formatNumber(deleting.amountFrom)} ${deleting.currencyFrom})?`
            : ''
        }
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
