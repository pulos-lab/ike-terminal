import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { usePortfolio } from '@/lib/portfolio-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TickerAutocomplete } from '@/components/shared/TickerAutocomplete';
import { formatNumber, formatPercent, formatCurrency, formatQuantity } from '@/lib/formatters';
import { Loader2, Plus, Check, X, TrendingDown } from 'lucide-react';
import { ClosedTradesPage } from './ClosedTradesPage';

interface Position {
  paperName: string;
  isin: string;
  ticker: string;
  shares: number;
  avgBuyPrice: number;
  currentPrice: number | null;
  currentValuePln: number;
  profitLoss: number;
  profitLossPln: number;
  profitLossPct: number;
  currency: string;
  weight: number;
  category?: 'stock' | 'etf' | 'cfd';
}

interface TxForm {
  date: string;
  ticker: string;
  side: 'K' | 'S';
  quantity: string;
  price: string;
  commission: string;
  currency: string; // 'auto' | 'PLN' | 'USD' | 'EUR' | 'GBP'
  fxRate: string;
  category: 'stock' | 'etf' | 'cfd';
}

interface SellForm {
  date: string;
  quantity: string;
  price: string;
  commission: string;
}

const CURRENCIES = ['auto', 'PLN', 'USD', 'EUR', 'GBP'] as const;
const emptyTxForm: TxForm = { date: '', ticker: '', side: 'K', quantity: '', price: '', commission: '0', currency: 'auto', fxRate: '', category: 'stock' };
const today = () => new Date().toISOString().slice(0, 10);

export function TradesPage() {
  const queryClient = useQueryClient();
  const { activeSettings } = usePortfolio();

  const { data: posData, isLoading: posLoading } = useQuery({
    queryKey: ['portfolio', 'positions'],
    queryFn: api.getPositions,
  });

  const { data: pricesData } = useQuery({
    queryKey: ['prices', 'live'],
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });

  // Add transaction form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<TxForm>(emptyTxForm);
  const [error, setError] = useState<string | null>(null);

  // Sell form state
  const [sellingTicker, setSellingTicker] = useState<string | null>(null);
  const [sellForm, setSellForm] = useState<SellForm>({ date: '', quantity: '', price: '', commission: '0' });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['portfolio', 'positions'] });
    queryClient.invalidateQueries({ queryKey: ['portfolio', 'transactions'] });
    queryClient.invalidateQueries({ queryKey: ['portfolio', 'closed-trades'] });
    queryClient.invalidateQueries({ queryKey: ['portfolio', 'metrics'] });
    queryClient.invalidateQueries({ queryKey: ['portfolio', 'history'] });
  };

  // Auto-calculate commission based on portfolio settings
  const calcCommission = (ticker: string, quantity: string, price: string): string => {
    const qty = parseFloat(quantity);
    const prc = parseFloat(price);
    if (!qty || !prc || qty <= 0 || prc <= 0) return '0';
    const value = qty * prc;
    const isPolish = ticker.endsWith('.WA') || ticker.endsWith('.NC');
    const rate = isPolish ? (activeSettings?.commissionPl || 0) : (activeSettings?.commissionForeign || 0);
    const min = isPolish ? (activeSettings?.minCommissionPl || 0) : (activeSettings?.minCommissionForeign || 0);
    if (rate <= 0 && min <= 0) return '0';
    const commission = Math.max(value * rate / 100, min);
    return (Math.round(commission * 100) / 100).toString();
  };

  // Determine effective currency for display
  const effectiveCurrency = addForm.currency !== 'auto' ? addForm.currency : (addForm.ticker.endsWith('.WA') || addForm.ticker.endsWith('.NC') ? 'PLN' : '');
  const showFxRate = effectiveCurrency && effectiveCurrency !== 'PLN';

  // Get live FX rate for pre-fill
  const getLiveFxRate = (currency: string): string => {
    const fx = pricesData?.fx;
    if (!fx) return '';
    if (currency === 'USD' && fx.USDPLN) return fx.USDPLN.toFixed(4);
    if (currency === 'EUR' && fx.EURPLN) return fx.EURPLN.toFixed(4);
    if (currency === 'GBP' && fx.GBPPLN) return fx.GBPPLN.toFixed(4);
    return '';
  };

  // Auto-fill commission when ticker/quantity/price changes
  const updateFormWithCommission = (form: TxForm, changedField?: string): TxForm => {
    const updated = { ...form };
    // Auto-calc commission unless user manually edited it
    if (changedField !== 'commission' && updated.ticker && updated.quantity && updated.price) {
      updated.commission = calcCommission(updated.ticker, updated.quantity, updated.price);
    }
    // Pre-fill FX rate when currency changes
    if (changedField === 'currency' && updated.currency !== 'auto' && updated.currency !== 'PLN') {
      updated.fxRate = getLiveFxRate(updated.currency);
    }
    return updated;
  };

  const createMutation = useMutation({
    mutationFn: (form: TxForm) =>
      api.createTransaction({
        date: form.date,
        ticker: form.ticker,
        side: form.side,
        quantity: parseFloat(form.quantity),
        price: parseFloat(form.price),
        commission: parseFloat(form.commission) || 0,
        currency: form.currency !== 'auto' ? form.currency : undefined,
        fxRate: form.fxRate ? parseFloat(form.fxRate) : undefined,
        category: form.category,
      }),
    onSuccess: () => {
      invalidateAll();
      setAddForm(emptyTxForm);
      setShowAddForm(false);
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const sellMutation = useMutation({
    mutationFn: ({ ticker, form, category }: { ticker: string; form: SellForm; category?: 'stock' | 'etf' | 'cfd' }) =>
      api.createTransaction({
        date: form.date,
        ticker,
        side: 'S',
        quantity: parseFloat(form.quantity),
        price: parseFloat(form.price),
        commission: parseFloat(form.commission) || 0,
        category,
      }),
    onSuccess: () => {
      invalidateAll();
      setSellingTicker(null);
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  function startSell(pos: Position) {
    setSellingTicker(pos.ticker);
    const qty = pos.shares.toString();
    const price = pos.currentPrice?.toString() || '';
    const commission = calcCommission(pos.ticker, qty, price);
    setSellForm({
      date: today(),
      quantity: qty,
      price,
      commission,
    });
    setShowAddForm(false);
    setError(null);
  }

  function openAddForm() {
    setShowAddForm(!showAddForm);
    setSellingTicker(null);
    setAddForm({ ...emptyTxForm, date: today() });
    setError(null);
  }

  // Helper to update add form field and recalculate commission
  const setField = (field: keyof TxForm, value: string) => {
    const updated = { ...addForm, [field]: value };
    setAddForm(updateFormWithCommission(updated, field));
  };

  const isAddValid = addForm.date && addForm.ticker && addForm.quantity && parseFloat(addForm.quantity) > 0 && addForm.price && parseFloat(addForm.price) > 0;
  const isSellValid = sellForm.date && sellForm.quantity && parseFloat(sellForm.quantity) > 0 && sellForm.price && parseFloat(sellForm.price) > 0;

  const positions: Position[] = posData?.positions || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Transakcje</h1>
        <Button size="sm" onClick={openAddForm}>
          <Plus className="h-4 w-4" />
          Dodaj transakcję
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Add transaction form */}
      {showAddForm && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Nowa transakcja</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">Data</label>
                <Input
                  type="date"
                  value={addForm.date}
                  onChange={e => setField('date', e.target.value)}
                  className="h-8 w-[140px]"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">Ticker</label>
                <TickerAutocomplete
                  value={addForm.ticker}
                  onChange={(val) => setField('ticker', val)}
                  className="w-[160px]"
                  placeholder="Ticker"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">K/S</label>
                <Select value={addForm.side} onValueChange={(v: 'K' | 'S') => setField('side', v)}>
                  <SelectTrigger className="h-8 w-[65px]" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="K">K</SelectItem>
                    <SelectItem value="S">S</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">Ilość</label>
                <Input
                  type="number"
                  min="0"
                  placeholder="0"
                  value={addForm.quantity}
                  onChange={e => setField('quantity', e.target.value)}
                  className="h-8 w-[80px] text-right"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">Cena</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={addForm.price}
                  onChange={e => setField('price', e.target.value)}
                  className="h-8 w-[100px] text-right"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">Rozliczenie</label>
                <Select value={addForm.currency} onValueChange={(v) => setField('currency', v)}>
                  <SelectTrigger className="h-8 w-[80px]" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map(c => <SelectItem key={c} value={c}>{c === 'auto' ? 'Auto' : c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">Prowizja</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0"
                  value={addForm.commission}
                  onChange={e => setField('commission', e.target.value)}
                  className="h-8 w-[80px] text-right"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">Kategoria</label>
                <Select value={addForm.category} onValueChange={(v: 'stock' | 'etf' | 'cfd') => setField('category', v)}>
                  <SelectTrigger className="h-8 w-[80px]" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stock">Stock</SelectItem>
                    <SelectItem value="etf">ETF</SelectItem>
                    <SelectItem value="cfd">CFD</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {showFxRate && (
                <div className="flex flex-col gap-2">
                  <label className="text-xs text-muted-foreground">Kurs {effectiveCurrency}/PLN</label>
                  <Input
                    type="number"
                    step="0.0001"
                    min="0"
                    placeholder="0.0000"
                    value={addForm.fxRate}
                    onChange={e => setField('fxRate', e.target.value)}
                    className="h-8 w-[100px] text-right"
                  />
                </div>
              )}
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
                  onClick={() => { setShowAddForm(false); setError(null); }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
            {showFxRate && addForm.fxRate && addForm.quantity && addForm.price && (
              <div className="mt-2 text-xs text-muted-foreground">
                Wartość w PLN: {formatNumber(parseFloat(addForm.quantity) * parseFloat(addForm.price) * parseFloat(addForm.fxRate))} zł
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Open positions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Otwarte pozycje</CardTitle>
        </CardHeader>
        <CardContent>
          {posLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : positions.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ticker</TableHead>
                    <TableHead className="text-right">Ilość</TableHead>
                    <TableHead className="text-right">Śr. cena kupna</TableHead>
                    <TableHead className="text-right">Cena bieżąca</TableHead>
                    <TableHead className="text-right">Wartość (PLN)</TableHead>
                    <TableHead className="text-right">P/L</TableHead>
                    <TableHead className="text-right">P/L %</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positions.map((pos) => {
                    const isPositive = pos.profitLossPct >= 0;
                    const isSelling = sellingTicker === pos.ticker;
                    return (
                      <Fragment key={pos.ticker}>
                        <TableRow>
                          <TableCell className="font-mono font-medium">
                            {pos.ticker}
                            {pos.category === 'cfd' && <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0">CFD</Badge>}
                            {pos.category === 'etf' && <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0">ETF</Badge>}
                          </TableCell>
                          <TableCell className="text-right">{formatQuantity(pos.shares)}</TableCell>
                          <TableCell className="text-right">{formatNumber(pos.avgBuyPrice)}</TableCell>
                          <TableCell className="text-right">
                            {pos.currentPrice != null ? formatNumber(pos.currentPrice) : '—'}
                            <span className="text-xs text-muted-foreground ml-1">{pos.currency}</span>
                          </TableCell>
                          <TableCell className="text-right">{formatNumber(pos.currentValuePln)}</TableCell>
                          <TableCell className={`text-right font-medium ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
                            {formatCurrency(pos.profitLoss, pos.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge
                              variant={isPositive ? 'default' : 'destructive'}
                              className={`text-xs ${isPositive ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}
                            >
                              {formatPercent(pos.profitLossPct)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => isSelling ? setSellingTicker(null) : startSell(pos)}
                              className="text-muted-foreground hover:text-red-500"
                            >
                              <TrendingDown className="h-3 w-3 mr-1" />
                              Sprzedaj
                            </Button>
                          </TableCell>
                        </TableRow>

                        {isSelling && (
                          <TableRow className="bg-muted/30">
                            <TableCell colSpan={8} className="px-4 py-3">
                              <div className="flex items-center gap-2 mb-3">
                                <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-sm font-medium">Sprzedaż {pos.ticker}</span>
                              </div>
                              <div className="flex flex-wrap items-end gap-4">
                                <div className="flex flex-col gap-2">
                                  <label className="text-xs text-muted-foreground">Ilość</label>
                                  <Input
                                    type="number"
                                    min="1"
                                    max={pos.shares}
                                    value={sellForm.quantity}
                                    onChange={e => setSellForm({ ...sellForm, quantity: e.target.value })}
                                    className="h-8 w-[90px] text-right"
                                  />
                                </div>
                                <div className="flex flex-col gap-2">
                                  <label className="text-xs text-muted-foreground">Cena</label>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={sellForm.price}
                                    onChange={e => setSellForm({ ...sellForm, price: e.target.value })}
                                    className="h-8 w-[110px] text-right"
                                  />
                                </div>
                                <div className="flex flex-col gap-2">
                                  <label className="text-xs text-muted-foreground">Data</label>
                                  <Input
                                    type="date"
                                    value={sellForm.date}
                                    onChange={e => setSellForm({ ...sellForm, date: e.target.value })}
                                    className="h-8 w-[140px]"
                                  />
                                </div>
                                <div className="flex flex-col gap-2">
                                  <label className="text-xs text-muted-foreground">Prowizja</label>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={sellForm.commission}
                                    onChange={e => setSellForm({ ...sellForm, commission: e.target.value })}
                                    className="h-8 w-[90px] text-right"
                                  />
                                </div>
                                <div className="flex gap-1 pb-0.5">
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => sellMutation.mutate({ ticker: pos.ticker, form: sellForm, category: pos.category })}
                                    disabled={!isSellValid || sellMutation.isPending}
                                    className="text-green-500 hover:text-green-600"
                                  >
                                    {sellMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                  </Button>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => { setSellingTicker(null); setError(null); }}
                                  >
                                    <X className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">Brak otwartych pozycji.</div>
          )}
        </CardContent>
      </Card>

      {/* Closed trades */}
      <ClosedTradesPage />
    </div>
  );
}
