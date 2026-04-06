import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { Trash2, Plus, GitBranch } from 'lucide-react';
import type { StockSplit } from 'shared';

function formatRatio(ratio: number): string {
  if (ratio >= 1) {
    const rounded = Math.round(ratio);
    return `${rounded}:1`;
  }
  const inv = Math.round(1 / ratio);
  return `1:${inv}`;
}

export function SplitsPanel() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ isin: '', ticker: '', splitDate: '', ratio: '' });

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.splits,
    queryFn: api.getSplits,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteSplit(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.splits });
      invalidatePortfolio(queryClient);
    },
  });

  const createMutation = useMutation({
    mutationFn: () => api.createSplit({
      isin: form.isin,
      ticker: form.ticker,
      splitDate: form.splitDate,
      ratio: parseFloat(form.ratio),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.splits });
      invalidatePortfolio(queryClient);
      setShowForm(false);
      setForm({ isin: '', ticker: '', splitDate: '', ratio: '' });
    },
  });

  const splits: StockSplit[] = data?.splits ?? [];

  if (isLoading) return <LoadingSpinner />;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-5 w-5" />
          Splity akcji
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4 mr-1" />
          Dodaj split
        </Button>
      </CardHeader>
      <CardContent>
        {showForm && (
          <div className="mb-4 p-3 border rounded-md space-y-2 bg-muted/30">
            <div className="grid grid-cols-4 gap-2">
              <Input
                placeholder="ISIN"
                value={form.isin}
                onChange={e => setForm(f => ({ ...f, isin: e.target.value }))}
              />
              <Input
                placeholder="Ticker (np. AVGO)"
                value={form.ticker}
                onChange={e => setForm(f => ({ ...f, ticker: e.target.value }))}
              />
              <Input
                type="date"
                placeholder="Data splitu"
                value={form.splitDate}
                onChange={e => setForm(f => ({ ...f, splitDate: e.target.value }))}
              />
              <Input
                type="number"
                step="0.01"
                placeholder="Ratio (np. 10 dla 10:1)"
                value={form.ratio}
                onChange={e => setForm(f => ({ ...f, ratio: e.target.value }))}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={!form.isin || !form.ticker || !form.splitDate || !form.ratio || createMutation.isPending}
              >
                Zapisz
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                Anuluj
              </Button>
            </div>
          </div>
        )}

        {splits.length === 0 ? (
          <EmptyState message="Brak wykrytych lub ręcznych splitów akcji" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticker</TableHead>
                <TableHead>ISIN</TableHead>
                <TableHead>Data splitu</TableHead>
                <TableHead>Ratio</TableHead>
                <TableHead>Źródło</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {splits.map((split: StockSplit) => (
                <TableRow key={split.id}>
                  <TableCell className="font-medium">{split.ticker}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{split.isin}</TableCell>
                  <TableCell>{split.splitDate}</TableCell>
                  <TableCell>{formatRatio(split.ratio)}</TableCell>
                  <TableCell>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      split.source === 'auto'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300'
                    }`}>
                      {split.source === 'auto' ? 'Wykryty' : 'Ręczny'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => split.id && deleteMutation.mutate(split.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
