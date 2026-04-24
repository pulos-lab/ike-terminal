import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidateDividends } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { CcyChip } from '@/components/ui/ccy-chip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { AddDividendDialog } from './AddDividendDialog';
import { formatNumber, formatDate, formatPLN, formatQuantity, formatCurrency } from '@/lib/formatters';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2, Coins, Plus, Pencil, Trash2, RefreshCw, Calendar, Clock } from 'lucide-react';
import { toast } from 'sonner';
import type { DividendRecord, UpcomingDividend } from 'shared';

const SOURCE_LABELS: Record<string, { label: string; className: string }> = {
  'auto-yahoo': { label: 'Auto', className: 'bg-blue-500/15 text-blue-500' },
  manual: { label: 'Ręczne', className: 'bg-gray-500/15 text-gray-400' },
  bossa: { label: 'Bossa', className: 'bg-amber-500/15 text-amber-500' },
  mbank: { label: 'mBank', className: 'bg-amber-500/15 text-amber-500' },
  degiro: { label: 'DEGIRO', className: 'bg-amber-500/15 text-amber-500' },
  xtb: { label: 'XTB', className: 'bg-amber-500/15 text-amber-500' },
};

function SourceBadge({ source }: { source: string }) {
  const info = SOURCE_LABELS[source] || { label: source, className: 'bg-gray-500/15 text-gray-400' };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${info.className}`}>
      {info.label}
    </span>
  );
}

function StatusBadge({ exDate, payDate }: { exDate: string; payDate: string | null }) {
  const today = new Date().toISOString().split('T')[0];
  if (exDate > today) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-500/15 text-yellow-500">
        Nadchodzi
      </span>
    );
  }
  if (payDate && payDate >= today) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-blue-500/15 text-blue-500">
        Oczekuje wypłaty
      </span>
    );
  }
  return null;
}

// ============ Upcoming Dividends Panel ============

function UpcomingDividendsPanel() {
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.upcomingDividends,
    queryFn: api.getUpcomingDividends,
    staleTime: 5 * 60 * 1000, // 5 min
  });

  const upcoming = data?.upcoming || [];

  if (isLoading) return <LoadingSpinner />;
  if (upcoming.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          Nadchodzące dywidendy
          <span className="text-muted-foreground font-normal">({upcoming.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticker</TableHead>
                <TableHead>Nazwa</TableHead>
                <TableHead>Ex-date</TableHead>
                <TableHead>Data wypłaty</TableHead>
                <TableHead>Akcje</TableHead>
                <TableHead className="text-right">Szac. kwota</TableHead>
                <TableHead>Waluta</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {upcoming.map((d: UpcomingDividend) => (
                <TableRow key={d.ticker}>
                  <TableCell className="font-mono font-medium">{d.ticker}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{d.name}</TableCell>
                  <TableCell>{formatDate(d.exDividendDate)}</TableCell>
                  <TableCell>{d.paymentDate ? formatDate(d.paymentDate) : '—'}</TableCell>
                  <TableCell>{formatQuantity(d.shares)}</TableCell>
                  <TableCell className="text-right font-medium text-gain tabular-nums">
                    {d.estimatedAmount > 0 ? formatNumber(d.estimatedAmount) : '—'}
                  </TableCell>
                  <TableCell><CcyChip ccy={d.currency} /></TableCell>
                  <TableCell>
                    <StatusBadge exDate={d.exDividendDate} payDate={d.paymentDate} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ============ Main Page ============

export function DividendsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.dividends,
    queryFn: api.getDividends,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<DividendRecord | null>(null);
  const [deleting, setDeleting] = useState<DividendRecord | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteDividend(id),
    onSuccess: (_, id) => {
      invalidateDividends(queryClient);
      const d = deleting;
      if (d && d.id === id) {
        toast.success(`Usunięto dywidendę ${d.ticker} — ${formatCurrency(d.amount, d.currency)} z ${formatDate(d.date)}`);
      } else {
        toast.success('Usunięto dywidendę.');
      }
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(`Nie udało się usunąć: ${e.message}`),
  });

  const scanMutation = useMutation({
    mutationFn: () => api.scanDividends(),
    onSuccess: (result) => {
      invalidateDividends(queryClient);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.upcomingDividends });
      if (result.newDividends > 0) {
        toast.success(`Znaleziono ${result.newDividends} nowych dywidend (przeskanowano ${result.scanned} tickerów)`);
      } else {
        toast.info(`Brak nowych dywidend (przeskanowano ${result.scanned} tickerów)`);
      }
    },
    onError: (e: Error) => toast.error(`Skan nie powiódł się: ${e.message}`),
  });

  const dividends: DividendRecord[] = data?.dividends || [];

  const yearlyData = dividends.reduce((acc: any[], d) => {
    const year = new Date(d.date).getFullYear().toString();
    const existing = acc.find((a: any) => a.year === year);
    if (existing) { existing.amount += d.amount; }
    else { acc.push({ year, amount: d.amount }); }
    return acc;
  }, []).sort((a: any, b: any) => a.year.localeCompare(b.year));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => scanMutation.mutate()}
          disabled={scanMutation.isPending}
        >
          {scanMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Skanuj dywidendy
        </Button>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Dodaj dywidende
        </Button>
      </div>

      {data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Coins className="h-4 w-4" />
                Suma dywidend
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-gain">{formatPLN(data.totalPln)}</div>
              {data.totalUsd > 0 && (
                <div className="text-sm text-muted-foreground mt-1">
                  + {formatNumber(data.totalUsd)} USD
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Dywidendy rocznie</CardTitle>
            </CardHeader>
            <CardContent>
              {yearlyData.length > 0 && (
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={yearlyData}>
                    <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip
                      cursor={{ fill: 'var(--primary)', fillOpacity: 0.1 }}
                      contentStyle={{
                        backgroundColor: 'var(--popover)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: 'var(--popover-foreground)', fontWeight: 600 }}
                      itemStyle={{ color: 'var(--primary)' }}
                      formatter={(v) => [formatPLN(Number(v) || 0), 'Dywidendy']}
                    />
                    <Bar dataKey="amount" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={80} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <UpcomingDividendsPanel />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Historia dywidend
            {dividends.length > 0 && (
              <span className="text-muted-foreground font-normal">({dividends.length})</span>
            )}
          </CardTitle>
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
                    <TableHead>Ticker</TableHead>
                    <TableHead>Opis</TableHead>
                    <TableHead className="text-right">Kwota</TableHead>
                    <TableHead>Waluta</TableHead>
                    <TableHead>Źródło</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dividends.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                        Brak danych. Kliknij &quot;Dodaj dywidende&quot; aby dodac pierwsza.
                      </TableCell>
                    </TableRow>
                  ) : (
                    dividends.map((d: DividendRecord) => (
                      <TableRow key={d.id}>
                        <TableCell>{formatDate(d.date)}</TableCell>
                        <TableCell className="font-mono font-medium">{d.ticker}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">{d.description}</TableCell>
                        <TableCell className="text-right font-medium text-gain tabular-nums">{formatNumber(d.amount)}</TableCell>
                        <TableCell><CcyChip ccy={d.currency} /></TableCell>
                        <TableCell>
                          <SourceBadge source={d.source} />
                        </TableCell>
                        <TableCell>
                          {d.source === 'manual' && (
                            <div className="flex gap-1">
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => setEditing(d)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => setDeleting(d)}
                                disabled={deleteMutation.isPending}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddDividendDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <AddDividendDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        defaultValues={editing ? { id: editing.id, date: editing.date, ticker: editing.ticker, amount: editing.amount, currency: editing.currency } : undefined}
      />
      <ConfirmDeleteDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        description={
          deleting
            ? `Usunąć dywidendę ${deleting.ticker} — ${formatCurrency(deleting.amount, deleting.currency)} z ${formatDate(deleting.date)}?`
            : ''
        }
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
