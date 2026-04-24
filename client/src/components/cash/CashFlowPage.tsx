import { useState, useMemo, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { usePortfolio } from '@/lib/portfolio-context';
import { QUERY_KEYS, invalidateCashFlow } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { AddDepositDialog } from './AddDepositDialog';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';
import {
  Tooltip as UITooltip,
  TooltipContent as UITooltipContent,
  TooltipProvider as UITooltipProvider,
  TooltipTrigger as UITooltipTrigger,
} from '@/components/ui/tooltip';
import { formatPLN, formatDate, formatCurrency } from '@/lib/formatters';
import { useToggleSet } from '@/hooks/useToggleSet';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, ArrowUp, ArrowDown, Info } from 'lucide-react';
import { toast } from 'sonner';

// XTB Transfer między sub-kontami trafia do CashOperation.description z tym prefixem.
// Wykrywamy go, by pokazać ikonę + tooltip wyjaśniający że to wymiana walutowa,
// ale traktowana jako depozyt/wypłata dla celów MWR/TWR.
const FX_MARKER_RE = /^\[z wymiany walut(?:\s+(\S+)\s+@\s+([\d.]+))?\]\s*(.*)$/;

function DepositDescription({ text }: { text: string }) {
  const m = text.match(FX_MARKER_RE);
  if (!m) {
    return <span className="text-xs text-muted-foreground/70 ml-1">{text}</span>;
  }
  const [, pair, rate, rest] = m;
  const label = pair ? `wymiana ${pair} @ ${rate}` : 'wymiana walut';
  return (
    <UITooltip>
      <UITooltipTrigger asChild>
        <span className="text-xs text-muted-foreground/70 ml-1 inline-flex items-center gap-1 cursor-help">
          <Info className="h-3 w-3" />
          {label}
          {rest && <span className="opacity-70">· {rest}</span>}
        </span>
      </UITooltipTrigger>
      <UITooltipContent className="max-w-xs">
        Ta operacja powstała z wymiany walutowej w ramach XTB (Transfer między sub-kontami).
        Traktujemy ją jako depozyt / wypłatę dla celów obliczania MWR/TWR, bo z perspektywy
        tego sub-konta reprezentuje środki wprowadzone z zewnątrz (lub wyprowadzone na zewnątrz).
      </UITooltipContent>
    </UITooltip>
  );
}

// Historyczne limity IKE/IKZE są centralne w shared/src/ike-ikze-limits.ts (2012–2026).
// Trzymaj tam wszystkie edycje — ten komponent jest tylko konsumentem.
import { IKE_LIMITS, IKZE_LIMITS, IKZE_DG_LIMITS } from 'shared';

interface CashEntry {
  id: number;
  date: string;
  amount: number;
  currency: string;
  source: string;
  description: string;
  type: 'deposit' | 'withdrawal';
}

interface YearGroup {
  year: number;
  totalDeposits: number;
  totalWithdrawals: number;
  ikeLimit: number;
  ikzeLimit: number;
  entries: CashEntry[];
}

export function CashFlowPage() {
  const queryClient = useQueryClient();
  const { activeSettings } = usePortfolio();

  const showIKE = activeSettings.isIKE;
  const showIKZE = activeSettings.isIKZE;
  const showLimits = showIKE || showIKZE;

  const { data: cashFlowData, isLoading: cashFlowLoading } = useQuery({
    queryKey: QUERY_KEYS.cashFlow,
    queryFn: api.getCashFlow,
    staleTime: 60 * 60 * 1000,
  });

  const { data: depositsData, isLoading: depositsLoading } = useQuery({
    queryKey: QUERY_KEYS.deposits,
    queryFn: api.getDeposits,
  });

  const [expandedYears, toggleYear] = useToggleSet<number>();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CashEntry | null>(null);
  const [deleting, setDeleting] = useState<CashEntry | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteDeposit(id),
    onSuccess: (_, id) => {
      invalidateCashFlow(queryClient);
      const entry = deleting;
      if (entry && entry.id === id) {
        const label = entry.type === 'deposit' ? 'wpłatę' : 'wypłatę';
        toast.success(
          `Usunięto ${label} ${formatCurrency(Math.abs(entry.amount), entry.currency || 'PLN')} z ${formatDate(entry.date)}`,
        );
      } else {
        toast.success('Usunięto operację.');
      }
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(`Nie udało się usunąć: ${e.message}`),
  });

  const entries: CashEntry[] = (depositsData?.deposits || []).map((d: any) => ({
    ...d,
    type: d.type || 'deposit',
  }));
  const ikzeLimits = activeSettings.ikzeIsDG ? IKZE_DG_LIMITS : IKZE_LIMITS;

  // Dominant currency across all entries — if all entries share one currency,
  // use it for aggregates (year totals, grand totals, chart axis). For mixed-
  // currency portfolios fall back to PLN as a common denominator (which may be
  // imprecise — IKE/IKZE limits are PLN-only anyway and sumy bez konwersji FX
  // nie mają sensu; osobny follow-up).
  const displayCurrency = useMemo(() => {
    const currencies = new Set(entries.map(e => (e.currency || 'PLN').toUpperCase()));
    if (currencies.size === 1) return [...currencies][0];
    return 'PLN';
  }, [entries]);
  const isMultiCurrency = useMemo(() => {
    const currencies = new Set(entries.map(e => (e.currency || 'PLN').toUpperCase()));
    return currencies.size > 1;
  }, [entries]);
  const fmtAgg = (v: number) => formatCurrency(v, displayCurrency);

  const yearGroups = useMemo(() => {
    if (!entries.length) return [];

    const byYear = new Map<number, CashEntry[]>();
    for (const entry of entries) {
      const year = parseInt(entry.date.slice(0, 4));
      const arr = byYear.get(year) || [];
      arr.push(entry);
      byYear.set(year, arr);
    }

    const groups: YearGroup[] = [];
    for (const [year, yearEntries] of byYear) {
      const totalDeposits = yearEntries
        .filter(e => e.type === 'deposit')
        .reduce((s, d) => s + Math.abs(d.amount), 0);
      const totalWithdrawals = yearEntries
        .filter(e => e.type === 'withdrawal')
        .reduce((s, d) => s + Math.abs(d.amount), 0);
      const ikeLimit = IKE_LIMITS[year] || 0;
      const ikzeLimit = ikzeLimits[year] || 0;
      yearEntries.sort((a, b) => b.date.localeCompare(a.date));
      groups.push({ year, totalDeposits, totalWithdrawals, ikeLimit, ikzeLimit, entries: yearEntries });
    }

    groups.sort((a, b) => b.year - a.year);
    return groups;
  }, [entries, ikzeLimits]);

  const grandTotalDeposits = useMemo(() => yearGroups.reduce((s, g) => s + g.totalDeposits, 0), [yearGroups]);
  const grandTotalWithdrawals = useMemo(() => yearGroups.reduce((s, g) => s + g.totalWithdrawals, 0), [yearGroups]);

  const getYearLimit = (group: YearGroup) => {
    let total = 0;
    if (showIKE) total += group.ikeLimit;
    if (showIKZE) total += group.ikzeLimit;
    return total;
  };

  const getRemaining = (group: YearGroup) => {
    const limit = getYearLimit(group);
    return Math.max(limit - group.totalDeposits, 0);
  };

  const getUsagePct = (group: YearGroup) => {
    const limit = getYearLimit(group);
    return limit > 0 ? (group.totalDeposits / limit) * 100 : 0;
  };

  const limitColCount = (showIKE ? 1 : 0) + (showIKZE ? 1 : 0) + (showLimits ? 2 : 0);
  const totalCols = 3 + limitColCount + 1; // rok + wpłaty + wypłaty + limits + actions

  const cardTitle = showIKE && showIKZE
    ? 'Przepływy gotówkowe vs limity IKE/IKZE'
    : showIKE
    ? 'Przepływy gotówkowe vs limit IKE'
    : showIKZE
    ? 'Przepływy gotówkowe vs limit IKZE'
    : 'Przepływy gotówkowe';

  return (
    <UITooltipProvider delayDuration={150}>
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Dodaj operację
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Wpłaty netto a wycena portfela
            {cashFlowData?.baseCurrency && cashFlowData.baseCurrency !== 'PLN' && (
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                (w {cashFlowData.baseCurrency})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {cashFlowLoading ? (
            <LoadingSpinner />
          ) : cashFlowData?.cashFlow?.length ? (
            <ResponsiveContainer width="100%" height={400}>
              <AreaChart data={cashFlowData.cashFlow}>
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  formatter={(value, name) => [
                    formatCurrency(Number(value) || 0, cashFlowData?.baseCurrency || 'PLN'),
                    name === 'netCashFlow' ? 'Wpłaty netto' : 'Wartość portfela',
                  ]}
                  labelFormatter={(label) => `Data: ${label}`}
                />
                <Area type="monotone" dataKey="portfolioValue" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.12} strokeWidth={2} name="portfolioValue" />
                <Area type="stepAfter" dataKey="netCashFlow" stroke="var(--muted-foreground)" fill="var(--muted-foreground)" fillOpacity={0.05} strokeWidth={1} strokeDasharray="4 4" name="netCashFlow" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-80 text-muted-foreground">
              Brak danych.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {cardTitle}
            <span className="ml-2 text-muted-foreground font-normal">
              (wpłaty: {fmtAgg(grandTotalDeposits)}
              {grandTotalWithdrawals > 0 && <>, wypłaty: {fmtAgg(grandTotalWithdrawals)}</>}
              , netto: {fmtAgg(grandTotalDeposits - grandTotalWithdrawals)}
              {isMultiCurrency && <span className="text-xs"> — uwaga: kwoty w różnych walutach, sumowane bez konwersji</span>})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {depositsLoading ? (
            <LoadingSpinner />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rok</TableHead>
                    <TableHead className="text-right">Wpłaty</TableHead>
                    <TableHead className="text-right">Wypłaty</TableHead>
                    {showIKE && <TableHead className="text-right">Limit IKE</TableHead>}
                    {showIKZE && <TableHead className="text-right">Limit IKZE</TableHead>}
                    {showLimits && <TableHead className="text-right">Pozostało</TableHead>}
                    {showLimits && <TableHead className="text-right">Wykorzystanie</TableHead>}
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {yearGroups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={totalCols} className="text-center py-12 text-muted-foreground">
                        Brak operacji gotówkowych. Kliknij &quot;Dodaj operację&quot; aby dodać pierwszą.
                      </TableCell>
                    </TableRow>
                  ) : (
                    yearGroups.map((group) => {
                      const isExpanded = expandedYears.has(group.year);
                      const remaining = getRemaining(group);
                      const usagePct = getUsagePct(group);
                      const isFull = showLimits && remaining <= 0;
                      return (
                        <Fragment key={group.year}>
                          <TableRow
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => toggleYear(group.year)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleYear(group.year); } }}
                          >
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-1">
                                {isExpanded
                                  ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                                  : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                                }
                                {group.year}
                                <span className="text-xs text-muted-foreground ml-1">({group.entries.length})</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-medium text-gain">
                              {group.totalDeposits > 0 ? fmtAgg(group.totalDeposits) : '—'}
                            </TableCell>
                            <TableCell className="text-right font-medium text-loss">
                              {group.totalWithdrawals > 0 ? fmtAgg(group.totalWithdrawals) : '—'}
                            </TableCell>
                            {showIKE && (
                              <TableCell className="text-right text-muted-foreground">
                                {group.ikeLimit > 0 ? formatPLN(group.ikeLimit) : '—'}
                              </TableCell>
                            )}
                            {showIKZE && (
                              <TableCell className="text-right text-muted-foreground">
                                {group.ikzeLimit > 0 ? formatPLN(group.ikzeLimit) : '—'}
                              </TableCell>
                            )}
                            {showLimits && (
                              <TableCell className={`text-right font-medium ${isFull ? 'text-gain' : 'text-yellow-500'}`}>
                                {getYearLimit(group) > 0 ? formatPLN(remaining) : '—'}
                              </TableCell>
                            )}
                            {showLimits && (
                              <TableCell className="text-right">
                                {getYearLimit(group) > 0 && (
                                  <Badge
                                    variant={isFull ? 'default' : 'secondary'}
                                    className={`text-xs ${isFull ? 'bg-gain/10 text-gain' : 'bg-muted text-muted-foreground'}`}
                                  >
                                    {usagePct.toFixed(0)}%
                                  </Badge>
                                )}
                              </TableCell>
                            )}
                            <TableCell />
                          </TableRow>

                          {isExpanded && group.entries.map((entry) => (
                            <TableRow key={entry.id} className="bg-muted/30">
                              <TableCell className="text-muted-foreground pl-9 text-sm">
                                <div className="flex items-center gap-1.5">
                                  {entry.type === 'deposit'
                                    ? <ArrowUp className="h-3 w-3 text-gain shrink-0" />
                                    : <ArrowDown className="h-3 w-3 text-loss shrink-0" />
                                  }
                                  {formatDate(entry.date)}
                                  {entry.description && <DepositDescription text={entry.description} />}
                                </div>
                              </TableCell>
                              <TableCell className={`text-right ${entry.type === 'deposit' ? 'text-gain' : ''}`}>
                                {entry.type === 'deposit' ? formatCurrency(Math.abs(entry.amount), entry.currency || 'PLN') : ''}
                              </TableCell>
                              <TableCell className={`text-right ${entry.type === 'withdrawal' ? 'text-loss' : ''}`}>
                                {entry.type === 'withdrawal' ? formatCurrency(Math.abs(entry.amount), entry.currency || 'PLN') : ''}
                              </TableCell>
                              <TableCell colSpan={limitColCount > 0 ? limitColCount - 1 : 0} />
                              <TableCell className="text-right">
                                {entry.source === 'manual' && (
                                  <Badge variant="secondary" className="text-xs bg-blue-500/10 text-blue-500">
                                    ręczna
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell>
                                {entry.source === 'manual' && (
                                  <div className="flex gap-1">
                                    <Button
                                      size="icon-xs"
                                      variant="ghost"
                                      onClick={(e) => { e.stopPropagation(); setEditing(entry); }}
                                      className="text-muted-foreground hover:text-foreground"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </Button>
                                    <Button
                                      size="icon-xs"
                                      variant="ghost"
                                      onClick={(e) => { e.stopPropagation(); setDeleting(entry); }}
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
                        </Fragment>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddDepositDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <AddDepositDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        defaultValues={editing ? { id: editing.id, date: editing.date, amount: editing.amount, type: editing.type } : undefined}
      />
      <ConfirmDeleteDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        description={
          deleting
            ? `Usunąć ${deleting.type === 'deposit' ? 'wpłatę' : 'wypłatę'} ${formatCurrency(Math.abs(deleting.amount), deleting.currency || 'PLN')} z ${formatDate(deleting.date)}?`
            : ''
        }
        loading={deleteMutation.isPending}
      />
    </div>
    </UITooltipProvider>
  );
}
