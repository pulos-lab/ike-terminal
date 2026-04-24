import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidateFx } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { CcyChip } from '@/components/ui/ccy-chip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { AddFxExchangeDialog } from './AddFxExchangeDialog';
import { formatNumber, formatDate } from '@/lib/formatters';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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

  const fx = pricesData?.fx;
  const usdEur = fx?.USDPLN && fx?.EURPLN ? fx.USDPLN / fx.EURPLN : null;

  const deleteMutation = useMutation({
    mutationFn: ({ fromId, toId }: { fromId: number; toId: number }) =>
      api.deleteFxExchange(fromId, toId),
    onSuccess: () => {
      invalidateFx(queryClient);
      const ex = deleting;
      if (ex) {
        toast.success(`Usunięto wymianę ${ex.currencyFrom} → ${ex.currencyTo} (${formatNumber(ex.amountFrom)} ${ex.currencyFrom})`);
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-sm text-muted-foreground">USD/PLN</div>
              <div className="text-2xl font-bold font-mono">{formatNumber(fx.USDPLN, 4)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-sm text-muted-foreground">EUR/PLN</div>
              <div className="text-2xl font-bold font-mono">{formatNumber(fx.EURPLN, 4)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-sm text-muted-foreground">USD/EUR</div>
              <div className="text-2xl font-bold font-mono">{usdEur ? formatNumber(usdEur, 4) : '—'}</div>
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
          ) : (
            <div className="overflow-x-auto">
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
                  {data?.exchanges?.length ? (
                    data.exchanges.map((ex: FxExchangeRecord, i: number) => (
                      <TableRow key={i}>
                        <TableCell className="tabular-nums">{formatDate(ex.date)}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1">
                            <CcyChip ccy={ex.currencyFrom} />
                            <span className="text-muted-foreground text-xs">→</span>
                            <CcyChip ccy={ex.currencyTo} />
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatNumber(ex.rate, 4)}</TableCell>
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
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                        Brak danych.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddFxExchangeDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <ConfirmDeleteDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting?.fromOperationId && deleting?.toOperationId) {
            deleteMutation.mutate({ fromId: deleting.fromOperationId, toId: deleting.toOperationId });
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
