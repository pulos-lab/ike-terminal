import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatNumber, formatDate, formatPLN } from '@/lib/formatters';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2, Coins, Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import type { DividendRecord } from 'shared';

interface DividendForm {
  date: string;
  ticker: string;
  amount: string;
  currency: string;
}

const emptyForm: DividendForm = { date: '', ticker: '', amount: '', currency: 'PLN' };

export function DividendsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['portfolio', 'dividends'],
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
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'dividends'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'metrics'] });
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
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'dividends'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'metrics'] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteDividend(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'dividends'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'metrics'] });
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dywidendy</h1>
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
                    <Tooltip formatter={(v: number) => formatPLN(v)} />
                    <Bar dataKey="amount" fill="#22c55e" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Historia dywidend
            {dividends.length > 0 && (
              <span className="text-muted-foreground font-normal ml-2">({dividends.length})</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
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
                      <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
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
                          <TableCell className="text-right font-medium text-green-500">{formatNumber(d.amount)}</TableCell>
                          <TableCell>{d.currency}</TableCell>
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
