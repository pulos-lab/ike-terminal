import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
import { QUERY_KEYS, invalidateDividends } from '@/lib/query-keys';
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
import { AddDividendDialog } from './AddDividendDialog';
import {
  formatNumber,
  formatDate,
  formatPLN,
  formatQuantity,
  formatCurrency,
} from '@/lib/formatters';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { groupDividendsByYearAndCurrency } from '@/lib/dividends-yearly';
import { Loader2, Coins, Plus, Pencil, Trash2, RefreshCw, Calendar, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { ExpandableCard, ExpandableCardSubRow } from '@/components/ui/expandable-card';
import { useToggleSet } from '@/hooks/useToggleSet';
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
  const info = SOURCE_LABELS[source] || {
    label: source,
    className: 'bg-gray-500/15 text-gray-400',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${info.className}`}
    >
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

// Status uchwały z kalendarza GPW (stockwatch/biznesradar) — tylko dla wpisów,
// które go mają (źródło 'gpw-calendar'); Yahoo nie dostarcza statusu.
const CALENDAR_STATUS_STYLES: Record<string, string> = {
  proponowana: 'bg-muted text-muted-foreground',
  uchwalona: 'bg-emerald-500/15 text-emerald-500',
};

function CalendarStatusPill({ status }: { status?: string }) {
  if (!status || !CALENDAR_STATUS_STYLES[status]) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CALENDAR_STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

// ============ Upcoming Dividends Panel ============

function UpcomingDividendCardMobile({ d }: { d: UpcomingDividend }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ExpandableCard
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      expandedClassName="gap-1"
      headerLeft={
        <>
          <span className="font-mono font-semibold text-sm truncate">{d.ticker}</span>
          <CcyChip ccy={d.currency} />
        </>
      }
      headerRight={
        <span className="font-semibold text-sm tabular-nums text-gain shrink-0">
          {d.estimatedAmount > 0 ? formatNumber(d.estimatedAmount) : '—'}
        </span>
      }
      subHeader={
        <ExpandableCardSubRow>
          <span className="text-muted-foreground tabular-nums truncate">
            ex: {formatDate(d.exDividendDate)} · {formatQuantity(d.shares)} szt.
          </span>
          <span className="inline-flex items-center gap-1">
            <CalendarStatusPill status={d.status} />
            <StatusBadge exDate={d.exDividendDate} payDate={d.paymentDate} />
          </span>
        </ExpandableCardSubRow>
      }
    >
      <div className="flex justify-between gap-3 items-baseline">
        <span className="text-muted-foreground">Nazwa</span>
        <span className="text-right">{d.name}</span>
      </div>
      <div className="flex justify-between gap-3 items-baseline">
        <span className="text-muted-foreground">Data wypłaty</span>
        <span className="tabular-nums text-right">
          {d.paymentDate ? formatDate(d.paymentDate) : '—'}
        </span>
      </div>
    </ExpandableCard>
  );
}

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
        <div className="md:hidden flex flex-col gap-2">
          {upcoming.map((d: UpcomingDividend) => (
            <UpcomingDividendCardMobile key={d.ticker} d={d} />
          ))}
        </div>
        <div className="hidden md:block overflow-x-auto">
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
                  <TableCell>
                    <CcyChip ccy={d.currency} />
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1">
                      <CalendarStatusPill status={d.status} />
                      <StatusBadge exDate={d.exDividendDate} payDate={d.paymentDate} />
                    </span>
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
        toast.success(
          `Usunięto dywidendę ${d.ticker} — ${formatCurrency(d.amount, d.currency)} z ${formatDate(d.date)}`,
        );
      } else {
        toast.success('Usunięto dywidendę.');
      }
      setDeleting(null);
    },
    onError: (e: Error) => errorToast('Nie udało się usunąć', e),
  });

  const scanMutation = useMutation({
    mutationFn: () => api.scanDividends(),
    onSuccess: (result) => {
      invalidateDividends(queryClient);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.upcomingDividends });
      if (result.newDividends > 0) {
        toast.success(
          `Znaleziono ${result.newDividends} nowych dywidend (przeskanowano ${result.scanned} tickerów)`,
        );
      } else {
        toast.info(`Brak nowych dywidend (przeskanowano ${result.scanned} tickerów)`);
      }
    },
    onError: (e: Error) => errorToast('Skan nie powiódł się', e),
  });

  const dividends: DividendRecord[] = data?.dividends || [];
  const [expandedHistory, toggleHistory] = useToggleSet<number>();

  // Roczne sumy per waluta (stacked bars) — backend nie zwraca przeliczenia PLN
  // per rekord, więc nie wolno sumować różnych walut do jednego słupka "PLN".
  const { rows: yearlyData, currencies: yearlyCurrencies } = useMemo(
    () => groupDividendsByYearAndCurrency(dividends),
    [dividends],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => scanMutation.mutate()}
          disabled={scanMutation.isPending}
        >
          {scanMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
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
                      formatter={(v, name) => [
                        formatCurrency(Number(v) || 0, String(name)),
                        String(name),
                      ]}
                    />
                    {yearlyCurrencies.length > 1 && (
                      <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
                    )}
                    {yearlyCurrencies.map((currency, i) => (
                      <Bar
                        key={currency}
                        dataKey={currency}
                        stackId="dividends"
                        fill={`var(--chart-${(i % 5) + 1})`}
                        radius={i === yearlyCurrencies.length - 1 ? [4, 4, 0, 0] : undefined}
                        maxBarSize={80}
                      />
                    ))}
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
          ) : dividends.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              Brak danych. Kliknij &quot;Dodaj dywidende&quot; aby dodac pierwsza.
            </div>
          ) : (
            <>
              <div className="md:hidden flex flex-col gap-2">
                {dividends.map((d: DividendRecord) => {
                  const isExpanded = expandedHistory.has(d.id);
                  const hasDescription = !!(d.description && d.description.trim());
                  return (
                    <ExpandableCard
                      key={d.id}
                      expanded={isExpanded}
                      onToggle={() => toggleHistory(d.id)}
                      headerLeft={
                        <>
                          <span className="font-mono font-semibold text-sm truncate">
                            {d.ticker}
                          </span>
                          <CcyChip ccy={d.currency} />
                        </>
                      }
                      headerRight={
                        <span className="font-semibold text-sm tabular-nums text-gain shrink-0">
                          {formatNumber(d.amount)}
                        </span>
                      }
                      subHeader={
                        <ExpandableCardSubRow>
                          <span className="text-muted-foreground tabular-nums">
                            {formatDate(d.date)}
                          </span>
                          <SourceBadge source={d.source} />
                        </ExpandableCardSubRow>
                      }
                    >
                      {hasDescription && (
                        <div className="flex justify-between gap-3 items-baseline">
                          <span className="text-muted-foreground shrink-0">Opis</span>
                          <span className="text-right">{d.description}</span>
                        </div>
                      )}
                      {(d.source === 'manual' || d.source === 'auto-yahoo') && (
                        <div className="flex justify-end gap-1.5 pt-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditing(d)}
                            className="h-7 px-2 text-xs"
                          >
                            <Pencil className="h-3 w-3 mr-1" />
                            Edytuj
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDeleting(d)}
                            disabled={deleteMutation.isPending}
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Usuń
                          </Button>
                        </div>
                      )}
                    </ExpandableCard>
                  );
                })}
              </div>
              <div className="hidden md:block overflow-x-auto">
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
                    {dividends.map((d: DividendRecord) => (
                      <TableRow key={d.id}>
                        <TableCell>{formatDate(d.date)}</TableCell>
                        <TableCell className="font-mono font-medium">{d.ticker}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {d.description}
                        </TableCell>
                        <TableCell className="text-right font-medium text-gain tabular-nums">
                          {formatNumber(d.amount)}
                        </TableCell>
                        <TableCell>
                          <CcyChip ccy={d.currency} />
                        </TableCell>
                        <TableCell>
                          <SourceBadge source={d.source} />
                        </TableCell>
                        <TableCell>
                          {(d.source === 'manual' || d.source === 'auto-yahoo') && (
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
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AddDividendDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <AddDividendDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        defaultValues={
          editing
            ? {
                id: editing.id,
                date: editing.date,
                ticker: editing.ticker,
                amount: editing.amount,
                currency: editing.currency,
                description: editing.description,
                source: editing.source,
              }
            : undefined
        }
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
