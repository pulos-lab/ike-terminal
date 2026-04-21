import { useState, useMemo, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { usePortfolio } from '@/lib/portfolio-context';
import { QUERY_KEYS, invalidateCashFlow } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';
import { formatPLN, formatDate } from '@/lib/formatters';
import { useToggleSet } from '@/hooks/useToggleSet';
import { ChevronRight, ChevronDown, Loader2, Plus, Pencil, Trash2, Check, X, ArrowUp, ArrowDown } from 'lucide-react';

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

interface EntryForm {
  date: string;
  amount: string;
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

const emptyForm: EntryForm = { date: '', amount: '', type: 'deposit' };

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
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<EntryForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EntryForm>(emptyForm);

  const invalidateAll = () => invalidateCashFlow(queryClient);

  const createMutation = useMutation({
    mutationFn: (form: EntryForm) =>
      api.createDeposit({ date: form.date, amount: parseFloat(form.amount) }, form.type),
    onSuccess: () => {
      invalidateAll();
      setAddForm(emptyForm);
      setShowAddForm(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, form }: { id: number; form: EntryForm }) =>
      api.updateDeposit(id, { date: form.date, amount: parseFloat(form.amount) }),
    onSuccess: () => {
      invalidateAll();
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteDeposit(id),
    onSuccess: () => invalidateAll(),
  });

  function startEdit(entry: CashEntry) {
    setEditingId(entry.id);
    setEditForm({
      date: entry.date.split('T')[0],
      amount: Math.abs(entry.amount).toString(),
      type: entry.type,
    });
  }

  function handleDelete(entry: CashEntry) {
    const label = entry.type === 'deposit' ? 'wpłatę' : 'wypłatę';
    if (window.confirm(`Usunąć ${label} ${formatPLN(Math.abs(entry.amount))} z ${formatDate(entry.date)}?`)) {
      deleteMutation.mutate(entry.id);
    }
  }

  const entries: CashEntry[] = (depositsData?.deposits || []).map((d: any) => ({
    ...d,
    type: d.type || 'deposit',
  }));
  const ikzeLimits = activeSettings.ikzeIsDG ? IKZE_DG_LIMITS : IKZE_LIMITS;

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

  const isAddValid = addForm.date && addForm.amount && parseFloat(addForm.amount) > 0;
  const isEditValid = editForm.date && editForm.amount && parseFloat(editForm.amount) > 0;

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
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          onClick={() => {
            if (!showAddForm) {
              setAddForm({ date: new Date().toISOString().slice(0, 10), amount: '', type: 'deposit' });
            } else {
              setAddForm(emptyForm);
            }
            setShowAddForm(!showAddForm);
            setEditingId(null);
          }}
        >
          <Plus className="h-4 w-4" />
          Dodaj operację
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Wpłaty netto a wycena portfela</CardTitle>
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
                    formatPLN(Number(value) || 0),
                    name === 'netCashFlow' ? 'Wpłaty netto' : 'Wartość portfela',
                  ]}
                  labelFormatter={(label) => `Data: ${label}`}
                />
                <Area type="monotone" dataKey="portfolioValue" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.12} strokeWidth={2} name="portfolioValue" />
                <Area type="stepAfter" dataKey="netCashFlow" stroke="#71717a" fill="#71717a" fillOpacity={0.05} strokeWidth={1} strokeDasharray="4 4" name="netCashFlow" />
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
              (wpłaty: {formatPLN(grandTotalDeposits)}
              {grandTotalWithdrawals > 0 && <>, wypłaty: {formatPLN(grandTotalWithdrawals)}</>}
              , netto: {formatPLN(grandTotalDeposits - grandTotalWithdrawals)})
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
                  {showAddForm && (
                    <TableRow className="bg-muted/30">
                      <TableCell>
                        <Input
                          type="date"
                          value={addForm.date}
                          onChange={e => setAddForm({ ...addForm, date: e.target.value })}
                          className="h-8 w-[140px]"
                        />
                      </TableCell>
                      <TableCell colSpan={2}>
                        <div className="flex items-center gap-2">
                          <Select value={addForm.type} onValueChange={v => setAddForm({ ...addForm, type: v as 'deposit' | 'withdrawal' })}>
                            <SelectTrigger className="h-8 w-[110px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="deposit">Wpłata</SelectItem>
                              <SelectItem value="withdrawal">Wypłata</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="0.00"
                            value={addForm.amount}
                            onChange={e => setAddForm({ ...addForm, amount: e.target.value })}
                            className="h-8 w-[120px] text-right"
                          />
                        </div>
                      </TableCell>
                      <TableCell colSpan={limitColCount || 1} className="text-muted-foreground text-sm">
                        PLN
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => createMutation.mutate(addForm)}
                            disabled={!isAddValid || createMutation.isPending}
                            className="text-gain hover:text-gain/80"
                          >
                            {createMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          </Button>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => { setShowAddForm(false); setAddForm(emptyForm); }}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  {yearGroups.length === 0 && !showAddForm ? (
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
                              {group.totalDeposits > 0 ? formatPLN(group.totalDeposits) : '—'}
                            </TableCell>
                            <TableCell className="text-right font-medium text-loss">
                              {group.totalWithdrawals > 0 ? formatPLN(group.totalWithdrawals) : '—'}
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

                          {isExpanded && group.entries.map((entry) =>
                            editingId === entry.id ? (
                              <TableRow key={entry.id} className="bg-muted/30">
                                <TableCell className="pl-9">
                                  <Input
                                    type="date"
                                    value={editForm.date}
                                    onChange={e => setEditForm({ ...editForm, date: e.target.value })}
                                    className="h-8 w-[140px]"
                                  />
                                </TableCell>
                                <TableCell colSpan={2}>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={editForm.amount}
                                    onChange={e => setEditForm({ ...editForm, amount: e.target.value })}
                                    className="h-8 w-[120px] text-right"
                                  />
                                </TableCell>
                                <TableCell colSpan={limitColCount || 1} />
                                <TableCell>
                                  <div className="flex gap-1">
                                    <Button
                                      size="icon-xs"
                                      variant="ghost"
                                      onClick={() => updateMutation.mutate({ id: entry.id, form: editForm })}
                                      disabled={!isEditValid || updateMutation.isPending}
                                      className="text-gain hover:text-gain/80"
                                    >
                                      {updateMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                    </Button>
                                    <Button
                                      size="icon-xs"
                                      variant="ghost"
                                      onClick={() => setEditingId(null)}
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ) : (
                              <TableRow key={entry.id} className="bg-muted/30">
                                <TableCell className="text-muted-foreground pl-9 text-sm">
                                  <div className="flex items-center gap-1.5">
                                    {entry.type === 'deposit'
                                      ? <ArrowUp className="h-3 w-3 text-gain shrink-0" />
                                      : <ArrowDown className="h-3 w-3 text-loss shrink-0" />
                                    }
                                    {formatDate(entry.date)}
                                    {entry.description && (
                                      <span className="text-xs text-muted-foreground/70 ml-1">{entry.description}</span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className={`text-right ${entry.type === 'deposit' ? 'text-gain' : ''}`}>
                                  {entry.type === 'deposit' ? formatPLN(Math.abs(entry.amount)) : ''}
                                </TableCell>
                                <TableCell className={`text-right ${entry.type === 'withdrawal' ? 'text-loss' : ''}`}>
                                  {entry.type === 'withdrawal' ? formatPLN(Math.abs(entry.amount)) : ''}
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
                                        onClick={(e) => { e.stopPropagation(); startEdit(entry); }}
                                        className="text-muted-foreground hover:text-foreground"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </Button>
                                      <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        onClick={(e) => { e.stopPropagation(); handleDelete(entry); }}
                                        disabled={deleteMutation.isPending}
                                        className="text-muted-foreground hover:text-destructive"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  )}
                                </TableCell>
                              </TableRow>
                            )
                          )}
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
    </div>
  );
}
