import { useState, useMemo, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { usePortfolio } from '@/lib/portfolio-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';
import { formatPLN, formatDate } from '@/lib/formatters';
import { ChevronRight, ChevronDown, Loader2, Plus, Pencil, Trash2, Check, X } from 'lucide-react';

const IKE_LIMITS: Record<number, number> = {
  2021: 15777,
  2022: 17766,
  2023: 20805,
  2024: 23472,
  2025: 26019,
  2026: 28260,
};

const IKZE_LIMITS: Record<number, number> = {
  2021: 6310.80,
  2022: 7106.40,
  2023: 8322.00,
  2024: 9388.80,
  2025: 10407.60,
  2026: 11305.20,
};

const IKZE_DG_LIMITS: Record<number, number> = {
  2021: 9466.20,
  2022: 10659.60,
  2023: 12483.00,
  2024: 14083.20,
  2025: 15611.40,
  2026: 16957.80,
};

interface Deposit {
  id: number;
  date: string;
  amount: number;
  currency: string;
  source: 'bossa' | 'manual';
  description: string;
}

interface DepositForm {
  date: string;
  amount: string;
}

interface YearGroup {
  year: number;
  totalDeposits: number;
  ikeLimit: number;
  ikzeLimit: number;
  deposits: Deposit[];
}

const emptyForm: DepositForm = { date: '', amount: '' };

export function CashFlowPage() {
  const queryClient = useQueryClient();
  const { activeSettings } = usePortfolio();

  const showIKE = activeSettings.isIKE;
  const showIKZE = activeSettings.isIKZE;
  const showLimits = showIKE || showIKZE;

  const { data: cashFlowData, isLoading: cashFlowLoading } = useQuery({
    queryKey: ['portfolio', 'cash-flow'],
    queryFn: api.getCashFlow,
    staleTime: 60 * 60 * 1000,
  });

  const { data: depositsData, isLoading: depositsLoading } = useQuery({
    queryKey: ['portfolio', 'deposits'],
    queryFn: api.getDeposits,
  });

  const [expandedYears, setExpandedYears] = useState<Set<number>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<DepositForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<DepositForm>(emptyForm);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['portfolio', 'deposits'] });
    queryClient.invalidateQueries({ queryKey: ['portfolio', 'cash-flow'] });
    queryClient.invalidateQueries({ queryKey: ['portfolio', 'metrics'] });
  };

  const createMutation = useMutation({
    mutationFn: (form: DepositForm) =>
      api.createDeposit({ date: form.date, amount: parseFloat(form.amount) }),
    onSuccess: () => {
      invalidateAll();
      setAddForm(emptyForm);
      setShowAddForm(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, form }: { id: number; form: DepositForm }) =>
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

  const toggleYear = (year: number) => {
    setExpandedYears(prev => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      return next;
    });
  };

  function startEdit(dep: Deposit) {
    setEditingId(dep.id);
    setEditForm({
      date: dep.date.split('T')[0],
      amount: dep.amount.toString(),
    });
  }

  function handleDelete(dep: Deposit) {
    if (window.confirm(`Usunąć wpłatę ${formatPLN(dep.amount)} z ${formatDate(dep.date)}?`)) {
      deleteMutation.mutate(dep.id);
    }
  }

  const deposits: Deposit[] = depositsData?.deposits || [];
  const ikzeLimits = activeSettings.ikzeIsDG ? IKZE_DG_LIMITS : IKZE_LIMITS;

  const yearGroups = useMemo(() => {
    if (!deposits.length) return [];

    const byYear = new Map<number, Deposit[]>();
    for (const dep of deposits) {
      const year = parseInt(dep.date.slice(0, 4));
      const arr = byYear.get(year) || [];
      arr.push(dep);
      byYear.set(year, arr);
    }

    const groups: YearGroup[] = [];
    for (const [year, yearDeposits] of byYear) {
      const totalDeposits = yearDeposits.reduce((s, d) => s + d.amount, 0);
      const ikeLimit = IKE_LIMITS[year] || 0;
      const ikzeLimit = ikzeLimits[year] || 0;
      yearDeposits.sort((a, b) => b.date.localeCompare(a.date));
      groups.push({ year, totalDeposits, ikeLimit, ikzeLimit, deposits: yearDeposits });
    }

    groups.sort((a, b) => b.year - a.year);
    return groups;
  }, [deposits, ikzeLimits]);

  const grandTotal = useMemo(() => {
    return yearGroups.reduce((s, g) => s + g.totalDeposits, 0);
  }, [yearGroups]);

  const isAddValid = addForm.date && addForm.amount && parseFloat(addForm.amount) > 0;
  const isEditValid = editForm.date && editForm.amount && parseFloat(editForm.amount) > 0;

  // Compute total limit per year (IKE + IKZE)
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

  // Column count for colSpan calculations
  const limitColCount = (showIKE ? 1 : 0) + (showIKZE ? 1 : 0) + (showLimits ? 2 : 0); // limit cols + remaining + usage
  const totalCols = 2 + limitColCount + 1; // rok + wpłaty + limits + actions

  const cardTitle = showIKE && showIKZE
    ? 'Wpłaty roczne vs limity IKE/IKZE'
    : showIKE
    ? 'Wpłaty roczne vs limit IKE'
    : showIKZE
    ? 'Wpłaty roczne vs limit IKZE'
    : 'Wpłaty roczne';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Wpłaty vs Wartość portfela</h1>
        <Button
          size="sm"
          onClick={() => {
            if (!showAddForm) {
              setAddForm({ date: new Date().toISOString().slice(0, 10), amount: '' });
            } else {
              setAddForm(emptyForm);
            }
            setShowAddForm(!showAddForm);
            setEditingId(null);
          }}
        >
          <Plus className="h-4 w-4" />
          Dodaj wpłatę
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Historia wpłat a wycena portfela</CardTitle>
        </CardHeader>
        <CardContent>
          {cashFlowLoading ? (
            <div className="flex items-center justify-center h-80">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : cashFlowData?.cashFlow?.length ? (
            <ResponsiveContainer width="100%" height={400}>
              <AreaChart data={cashFlowData.cashFlow}>
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    formatPLN(value),
                    name === 'cumulativeDeposits' ? 'Wpłaty' : 'Wartość portfela',
                  ]}
                  labelFormatter={(label) => `Data: ${label}`}
                />
                <Area type="monotone" dataKey="portfolioValue" stroke="#22c55e" fill="#22c55e" fillOpacity={0.1} strokeWidth={2} name="portfolioValue" />
                <Area type="stepAfter" dataKey="cumulativeDeposits" stroke="#71717a" fill="#71717a" fillOpacity={0.05} strokeWidth={1} strokeDasharray="4 4" name="cumulativeDeposits" />
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
              (łącznie {formatPLN(grandTotal)})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {depositsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rok</TableHead>
                    <TableHead className="text-right">Wpłaty</TableHead>
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
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          value={addForm.amount}
                          onChange={e => setAddForm({ ...addForm, amount: e.target.value })}
                          className="h-8 w-[120px] text-right"
                        />
                      </TableCell>
                      <TableCell colSpan={limitColCount || 1} className="text-muted-foreground text-sm">
                        Nowa wpłata PLN
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => createMutation.mutate(addForm)}
                            disabled={!isAddValid || createMutation.isPending}
                            className="text-green-500 hover:text-green-600"
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
                        Brak wpłat. Kliknij &quot;Dodaj wpłatę&quot; aby dodać pierwszą.
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
                                <span className="text-xs text-muted-foreground ml-1">({group.deposits.length})</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-medium">{formatPLN(group.totalDeposits)}</TableCell>
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
                              <TableCell className={`text-right font-medium ${isFull ? 'text-green-500' : 'text-yellow-500'}`}>
                                {getYearLimit(group) > 0 ? formatPLN(remaining) : '—'}
                              </TableCell>
                            )}
                            {showLimits && (
                              <TableCell className="text-right">
                                {getYearLimit(group) > 0 && (
                                  <Badge
                                    variant={isFull ? 'default' : 'secondary'}
                                    className={`text-xs ${isFull ? 'bg-green-500/10 text-green-500' : 'bg-muted text-muted-foreground'}`}
                                  >
                                    {usagePct.toFixed(0)}%
                                  </Badge>
                                )}
                              </TableCell>
                            )}
                            <TableCell />
                          </TableRow>

                          {isExpanded && group.deposits.map((dep) =>
                            editingId === dep.id ? (
                              <TableRow key={dep.id} className="bg-muted/30">
                                <TableCell className="pl-9">
                                  <Input
                                    type="date"
                                    value={editForm.date}
                                    onChange={e => setEditForm({ ...editForm, date: e.target.value })}
                                    className="h-8 w-[140px]"
                                  />
                                </TableCell>
                                <TableCell>
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
                                      onClick={() => updateMutation.mutate({ id: dep.id, form: editForm })}
                                      disabled={!isEditValid || updateMutation.isPending}
                                      className="text-green-500 hover:text-green-600"
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
                              <TableRow key={dep.id} className="bg-muted/30">
                                <TableCell className="text-muted-foreground pl-9 text-sm">
                                  └ {formatDate(dep.date)}
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground">{formatPLN(dep.amount)}</TableCell>
                                <TableCell colSpan={limitColCount > 0 ? limitColCount - 1 : 0} />
                                <TableCell className="text-right">
                                  {dep.source === 'manual' && (
                                    <Badge variant="secondary" className="text-xs bg-blue-500/10 text-blue-500">
                                      ręczna
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {dep.source === 'manual' && (
                                    <div className="flex gap-1">
                                      <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        onClick={(e) => { e.stopPropagation(); startEdit(dep); }}
                                        className="text-muted-foreground hover:text-foreground"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </Button>
                                      <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        onClick={(e) => { e.stopPropagation(); handleDelete(dep); }}
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
