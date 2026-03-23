import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatNumber, formatDate } from '@/lib/formatters';
import { Loader2, Plus, Trash2, Check, X } from 'lucide-react';
import type { FxExchangeRecord } from 'shared';

const CURRENCIES = ['PLN', 'USD', 'EUR', 'GBP'] as const;

interface FxForm {
  date: string;
  currencyFrom: string;
  currencyTo: string;
  amountFrom: string;
  rate: string;
}

const emptyForm: FxForm = {
  date: new Date().toISOString().slice(0, 10),
  currencyFrom: 'PLN',
  currencyTo: 'USD',
  amountFrom: '',
  rate: '',
};

export function CurrencyExchangePage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['portfolio', 'fx-history'],
    queryFn: api.getFxHistory,
  });

  const { data: pricesData } = useQuery({
    queryKey: ['prices', 'live'],
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });

  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<FxForm>(emptyForm);

  const fx = pricesData?.fx;
  const usdEur = fx?.USDPLN && fx?.EURPLN ? fx.USDPLN / fx.EURPLN : null;

  // Pre-fill rate from live FX data when currency pair changes
  const getLiveRate = (from: string, to: string): string => {
    if (!fx) return '';
    // Direct rates available: USDPLN, EURPLN, GBPPLN
    if (from === 'PLN' && to === 'USD' && fx.USDPLN) return fx.USDPLN.toFixed(4);
    if (from === 'PLN' && to === 'EUR' && fx.EURPLN) return fx.EURPLN.toFixed(4);
    if (from === 'PLN' && to === 'GBP' && fx.GBPPLN) return fx.GBPPLN.toFixed(4);
    if (from === 'USD' && to === 'PLN' && fx.USDPLN) return (1 / fx.USDPLN).toFixed(4);
    if (from === 'EUR' && to === 'PLN' && fx.EURPLN) return (1 / fx.EURPLN).toFixed(4);
    if (from === 'GBP' && to === 'PLN' && fx.GBPPLN) return (1 / fx.GBPPLN).toFixed(4);
    // Cross rates
    if (from === 'USD' && to === 'EUR' && fx.USDPLN && fx.EURPLN) return (fx.USDPLN / fx.EURPLN).toFixed(4);
    if (from === 'EUR' && to === 'USD' && fx.USDPLN && fx.EURPLN) return (fx.EURPLN / fx.USDPLN).toFixed(4);
    if (from === 'USD' && to === 'GBP' && fx.USDPLN && fx.GBPPLN) return (fx.USDPLN / fx.GBPPLN).toFixed(4);
    if (from === 'GBP' && to === 'USD' && fx.USDPLN && fx.GBPPLN) return (fx.GBPPLN / fx.USDPLN).toFixed(4);
    if (from === 'EUR' && to === 'GBP' && fx.EURPLN && fx.GBPPLN) return (fx.EURPLN / fx.GBPPLN).toFixed(4);
    if (from === 'GBP' && to === 'EUR' && fx.EURPLN && fx.GBPPLN) return (fx.GBPPLN / fx.EURPLN).toFixed(4);
    return '';
  };

  const computedAmountTo = useMemo(() => {
    const amount = parseFloat(addForm.amountFrom);
    const rate = parseFloat(addForm.rate);
    if (amount > 0 && rate > 0) return (amount / rate).toFixed(2);
    return '—';
  }, [addForm.amountFrom, addForm.rate]);

  const createMutation = useMutation({
    mutationFn: (form: FxForm) =>
      api.createFxExchange({
        date: form.date,
        currencyFrom: form.currencyFrom,
        currencyTo: form.currencyTo,
        amountFrom: parseFloat(form.amountFrom),
        rate: parseFloat(form.rate),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'fx-history'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'positions'] });
      setAddForm(emptyForm);
      setShowAddForm(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ fromId, toId }: { fromId: number; toId: number }) =>
      api.deleteFxExchange(fromId, toId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'fx-history'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'positions'] });
    },
  });

  const handleCurrencyChange = (field: 'currencyFrom' | 'currencyTo', value: string) => {
    const updated = { ...addForm, [field]: value };
    // Auto-swap if same currency selected
    if (updated.currencyFrom === updated.currencyTo) {
      if (field === 'currencyFrom') updated.currencyTo = addForm.currencyFrom;
      else updated.currencyFrom = addForm.currencyTo;
    }
    updated.rate = getLiveRate(updated.currencyFrom, updated.currencyTo);
    setAddForm(updated);
  };

  const isFormValid =
    addForm.date &&
    addForm.currencyFrom !== addForm.currencyTo &&
    parseFloat(addForm.amountFrom) > 0 &&
    parseFloat(addForm.rate) > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Waluty</h1>
        {!showAddForm && (
          <Button size="sm" onClick={() => {
            const form = { ...emptyForm, date: new Date().toISOString().slice(0, 10) };
            form.rate = getLiveRate(form.currencyFrom, form.currencyTo);
            setAddForm(form);
            setShowAddForm(true);
          }}>
            <Plus className="h-4 w-4 mr-1" /> Dodaj wymianę
          </Button>
        )}
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
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
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
                  {showAddForm && (
                    <TableRow className="bg-muted/50">
                      <TableCell>
                        <Input
                          type="date"
                          value={addForm.date}
                          onChange={(e) => setAddForm({ ...addForm, date: e.target.value })}
                          className="w-[140px]"
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Select value={addForm.currencyFrom} onValueChange={(v) => handleCurrencyChange('currencyFrom', v)}>
                            <SelectTrigger className="w-[80px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <span className="text-muted-foreground">→</span>
                          <Select value={addForm.currencyTo} onValueChange={(v) => handleCurrencyChange('currencyTo', v)}>
                            <SelectTrigger className="w-[80px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.0001"
                          placeholder="Kurs"
                          value={addForm.rate}
                          onChange={(e) => setAddForm({ ...addForm, rate: e.target.value })}
                          className="w-[100px] text-right"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="Kwota"
                          value={addForm.amountFrom}
                          onChange={(e) => setAddForm({ ...addForm, amountFrom: e.target.value })}
                          className="w-[110px] text-right"
                        />
                      </TableCell>
                      <TableCell className="text-right text-green-500 font-mono">
                        {computedAmountTo !== '—' ? `+${computedAmountTo}` : '—'} {addForm.currencyTo}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={!isFormValid || createMutation.isPending}
                            onClick={() => createMutation.mutate(addForm)}
                          >
                            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => { setShowAddForm(false); setAddForm(emptyForm); }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  {data?.exchanges?.length ? (
                    data.exchanges.map((ex: FxExchangeRecord, i: number) => (
                      <TableRow key={i}>
                        <TableCell>{formatDate(ex.date)}</TableCell>
                        <TableCell className="font-mono">{ex.pair}</TableCell>
                        <TableCell className="text-right font-medium">{formatNumber(ex.rate, 4)}</TableCell>
                        <TableCell className="text-right text-red-400">
                          -{formatNumber(ex.amountFrom)} {ex.currencyFrom}
                        </TableCell>
                        <TableCell className="text-right text-green-500">
                          +{formatNumber(ex.amountTo)} {ex.currencyTo}
                        </TableCell>
                        <TableCell>
                          {ex.source === 'manual' && ex.fromOperationId && ex.toOperationId && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-red-500"
                              disabled={deleteMutation.isPending}
                              onClick={() => deleteMutation.mutate({ fromId: ex.fromOperationId!, toId: ex.toOperationId! })}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : !showAddForm ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                        Brak danych.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
