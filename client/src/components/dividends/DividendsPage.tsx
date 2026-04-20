import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidateDividends } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { CcyChip } from '@/components/ui/ccy-chip';
import { formatNumber, formatDate, formatPLN } from '@/lib/formatters';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2, Coins, Plus, Pencil, Trash2, Check, X, RefreshCw, Calendar, Clock } from 'lucide-react';
import type { DividendRecord, UpcomingDividend } from 'shared';

interface DividendForm {
  date: string;
  ticker: string;
  amount: string;
  currency: string;
}

const emptyForm: DividendForm = { date: '', ticker: '', amount: '', currency: 'PLN' };

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
                  <TableCell>{d.shares}</TableCell>
                  <TableCell className="text-right font-medium text-green-500 tabular-nums">
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

  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<DividendForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<DividendForm>(emptyForm);

  const createMutation = useMutation({
    mutationFn: (form: DividendForm) =>
      api.createDividend({
        date: form.date,
        ticker: form.ticker,
        amount: parseFloat(form.amount),
        currency: form.currency,
      }),
    onSuccess: () => {
      invalidateDividends(queryClient);
      setAddForm(emptyForm);
      setShowAddForm(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, form }: { id: number; form: DividendForm }) =>
      api.updateDividend(id, {
        date: form.date,
        ticker: form.ticker,
        amount: parseFloat(form.amount),
        currency: form.currency,
      }),
    onSuccess: () => {
      invalidateDividends(queryClient);
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteDividend(id),
    onSuccess: () => invalidateDividends(queryClient),
  });

  const scanMutation = useMutation({
    mutationFn: () => api.scanDividends(),
    onSuccess: (result) => {
      invalidateDividends(queryClient);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.upcomingDividends });
      if (result.newDividends > 0) {
        alert(`Znaleziono ${result.newDividends} nowych dywidend (przeskanowano ${result.scanned} tickerów)`);
      } else {
        alert(`Brak nowych dywidend (przeskanowano ${result.scanned} tickerów)`);
      }
    },
  });

  function startEdit(d: DividendRecord) {
    setEditingId(d.id);
    setEditForm({
      date: d.date.split('T')[0],
      ticker: d.ticker,
      amount: d.amount.toString(),
      currency: d.currency,
    });
  }

  function handleDelete(d: DividendRecord) {
    if (window.confirm(`Czy na pewno chcesz usunac dywidende ${d.ticker} z ${formatDate(d.date)}?`)) {
      deleteMutation.mutate(d.id);
    }
  }

  const isAddValid = addForm.date && addForm.ticker && addForm.amount && parseFloat(addForm.amount) > 0;
  const isEditValid = editForm.date && editForm.ticker && editForm.amount && parseFloat(editForm.amount) > 0;

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
        <Button
          size="sm"
          onClick={() => { setShowAddForm(!showAddForm); setEditingId(null); }}
        >
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
              <div className="text-2xl font-bold text-green-500">{formatPLN(data.totalPln)}</div>
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
                    <Tooltip formatter={(v: number | undefined) => formatPLN(v ?? 0)} />
                    <Bar dataKey="amount" fill="#f59e0b" radius={[4, 4, 0, 0]} />
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
                          placeholder="np. AAPL"
                          value={addForm.ticker}
                          onChange={e => setAddForm({ ...addForm, ticker: e.target.value.toUpperCase() })}
                          className="h-8 w-[100px] font-mono"
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {addForm.ticker ? `Wyplata dywidendy ${addForm.ticker}` : ''}
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          value={addForm.amount}
                          onChange={e => setAddForm({ ...addForm, amount: e.target.value })}
                          className="h-8 w-[100px] text-right"
                        />
                      </TableCell>
                      <TableCell>
                        <Select value={addForm.currency} onValueChange={v => setAddForm({ ...addForm, currency: v })}>
                          <SelectTrigger className="h-8 w-[80px]" size="sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="PLN">PLN</SelectItem>
                            <SelectItem value="USD">USD</SelectItem>
                            <SelectItem value="EUR">EUR</SelectItem>
                            <SelectItem value="CAD">CAD</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <SourceBadge source="manual" />
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
                  {dividends.length === 0 && !showAddForm ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                        Brak danych. Kliknij &quot;Dodaj dywidende&quot; aby dodac pierwsza.
                      </TableCell>
                    </TableRow>
                  ) : (
                    dividends.map((d: DividendRecord) =>
                      editingId === d.id ? (
                        <TableRow key={d.id} className="bg-muted/30">
                          <TableCell>
                            <Input
                              type="date"
                              value={editForm.date}
                              onChange={e => setEditForm({ ...editForm, date: e.target.value })}
                              className="h-8 w-[140px]"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={editForm.ticker}
                              onChange={e => setEditForm({ ...editForm, ticker: e.target.value.toUpperCase() })}
                              className="h-8 w-[100px] font-mono"
                            />
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {editForm.ticker ? `Wyplata dywidendy ${editForm.ticker}` : ''}
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              value={editForm.amount}
                              onChange={e => setEditForm({ ...editForm, amount: e.target.value })}
                              className="h-8 w-[100px] text-right"
                            />
                          </TableCell>
                          <TableCell>
                            <Select value={editForm.currency} onValueChange={v => setEditForm({ ...editForm, currency: v })}>
                              <SelectTrigger className="h-8 w-[80px]" size="sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="PLN">PLN</SelectItem>
                                <SelectItem value="USD">USD</SelectItem>
                                <SelectItem value="EUR">EUR</SelectItem>
                                <SelectItem value="CAD">CAD</SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <SourceBadge source={d.source} />
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => updateMutation.mutate({ id: d.id, form: editForm })}
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
                        <TableRow key={d.id}>
                          <TableCell>{formatDate(d.date)}</TableCell>
                          <TableCell className="font-mono font-medium">{d.ticker}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{d.description}</TableCell>
                          <TableCell className="text-right font-medium text-green-500 tabular-nums">{formatNumber(d.amount)}</TableCell>
                          <TableCell><CcyChip ccy={d.currency} /></TableCell>
                          <TableCell>
                            <SourceBadge source={d.source} />
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => startEdit(d)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => handleDelete(d)}
                                disabled={deleteMutation.isPending}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    )
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
