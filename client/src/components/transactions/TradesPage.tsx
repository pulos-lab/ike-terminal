import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { usePortfolio } from '@/lib/portfolio-context';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { TickerAutocomplete } from '@/components/shared/TickerAutocomplete';
import { formatNumber, formatCurrency, formatQuantity, formatDate } from '@/lib/formatters';
import { useToggleSet } from '@/hooks/useToggleSet';
import { Loader2, Plus, Check, X, TrendingDown, ChevronRight, ChevronDown } from 'lucide-react';
import { ClosedTradesPage } from './ClosedTradesPage';
import { TradesSummary } from './TradesSummary';
import { PositionCardMobile } from './PositionCardMobile';
import { TradesFeed } from './TradesFeed';

interface BuyLot {
  quantity: number;
  price: number;
  commission: number;
  date: string;
  currency: string;
}

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
  buyLots?: BuyLot[];
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
    queryKey: QUERY_KEYS.positions,
    queryFn: api.getPositions,
  });

  const { data: pricesData } = useQuery({
    queryKey: QUERY_KEYS.livePrices,
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });

  const { data: txData } = useQuery({
    queryKey: QUERY_KEYS.transactions,
    queryFn: () => api.getTransactions(),
  });
  const txCount = txData?.transactions?.length ?? 0;

  const { data: closedData } = useQuery({
    queryKey: QUERY_KEYS.closedTrades,
    queryFn: () => api.getClosedTrades(),
  });
  const closedCount = closedData?.trades?.length ?? 0;

  // Add transaction form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<TxForm>(emptyTxForm);
  const [error, setError] = useState<string | null>(null);

  // Sell form state
  const [sellingTicker, setSellingTicker] = useState<string | null>(null);
  const [sellForm, setSellForm] = useState<SellForm>({ date: '', quantity: '', price: '', commission: '0' });

  // Expand/collapse lot details
  const [expandedPositions, togglePosition] = useToggleSet<string>();

  // Tab switcher: all transactions / open positions / closed trades
  const [tab, setTab] = useState<'all' | 'open' | 'closed'>('open');

  // Closed tab date filter — lifted here so TradesSummary (tile values)
  // and ClosedTradesPage (table) stay in sync when user changes the year / custom range.
  const [closedDateRange, setClosedDateRange] = useState<string>('ALL');
  const [closedCustomFrom, setClosedCustomFrom] = useState('');
  const [closedCustomTo, setClosedCustomTo] = useState('');

  const invalidateAll = () => invalidatePortfolio(queryClient);

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
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={openAddForm}>
          <Plus className="h-4 w-4" />
          Dodaj transakcję
        </Button>
      </div>

      {/* Tab switcher — Wszystkie / Otwarte / Zamknięte */}
      <div className="flex items-center gap-1 border-b border-border overflow-x-auto overflow-y-hidden">
        <TabButton active={tab === 'all'} onClick={() => { const t0 = performance.now(); setTab('all'); requestAnimationFrame(() => requestAnimationFrame(() => console.log(`[perf] tab→all: ${(performance.now() - t0).toFixed(0)}ms`))); }} label="Wszystkie" count={txCount} />
        <TabButton active={tab === 'open'} onClick={() => { const t0 = performance.now(); setTab('open'); requestAnimationFrame(() => requestAnimationFrame(() => console.log(`[perf] tab→open: ${(performance.now() - t0).toFixed(0)}ms`))); }} label="Otwarte" count={positions.length} />
        <TabButton active={tab === 'closed'} onClick={() => { const t0 = performance.now(); setTab('closed'); requestAnimationFrame(() => requestAnimationFrame(() => console.log(`[perf] tab→closed: ${(performance.now() - t0).toFixed(0)}ms`))); }} label="Zamknięte" count={closedCount} />
      </div>

      <TradesSummary
        tab={tab}
        positions={positions}
        closedDateRange={closedDateRange}
        closedCustomFrom={closedCustomFrom}
        closedCustomTo={closedCustomTo}
      />

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
                  className="text-gain hover:text-gain/80"
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

      {/* Stack obu tabów (Wszystkie + Otwarte) w tej samej grid-area.
          Aktywny tab: position:relative → w flow, kontrybuuje do wysokości parent.
          Nieaktywny: position:absolute + visibility:hidden → out of flow, layout
          zachowany (nie re-computowany), paint pominięty. Efekt: przełączanie
          pomiędzy tabami to tylko toggle kilku CSS properties — bez relayoutu
          6000+ wierszy. Browser cachuje layout pomiędzy togglami. */}
      <div style={{ position: 'relative' }}>
        <div
          aria-hidden={tab !== 'all'}
          style={{
            position: tab === 'all' ? 'relative' : 'absolute',
            top: 0, left: 0, right: 0,
            visibility: tab === 'all' ? 'visible' : 'hidden',
            pointerEvents: tab === 'all' ? 'auto' : 'none',
          }}
        >
          <Card>
            <CardContent className="pt-4">
              <TradesFeed />
            </CardContent>
          </Card>
        </div>

      {/* Open positions — zamontowany ZAWSZE (overlap ze stack) */}
      <div
        aria-hidden={tab !== 'open'}
        style={{
          position: tab === 'open' ? 'relative' : 'absolute',
          top: 0, left: 0, right: 0,
          visibility: tab === 'open' ? 'visible' : 'hidden',
          pointerEvents: tab === 'open' ? 'auto' : 'none',
        }}
      >
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Otwarte pozycje</CardTitle>
        </CardHeader>
        <CardContent>
          {posLoading ? (
            <LoadingSpinner />
          ) : positions.length ? (
            <>
              {/* Mobile cards */}
              <div className="md:hidden flex flex-col gap-2">
                {positions.map((pos) => (
                  <PositionCardMobile
                    key={pos.ticker}
                    position={pos}
                    onSell={() => sellingTicker === pos.ticker ? setSellingTicker(null) : startSell(pos)}
                  />
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ticker</TableHead>
                    <TableHead className="text-right">Ilość</TableHead>
                    <TableHead>Data kupna</TableHead>
                    <TableHead className="text-right">Śr. cena kupna</TableHead>
                    <TableHead className="text-right">Prowizja</TableHead>
                    <TableHead className="text-right">Cena bieżąca</TableHead>
                    <TableHead className="text-right">Wartość (PLN)</TableHead>
                    <TableHead className="text-right">P/L</TableHead>
                    <TableHead className="text-right">P/L %</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positions.map((pos) => {
                    const isSelling = sellingTicker === pos.ticker;
                    const lots = pos.buyLots || [];
                    const isMultiLot = lots.length > 1;
                    const isExpanded = expandedPositions.has(pos.ticker);

                    // Buy date range
                    const buyDates = lots.map(l => l.date).sort();
                    const minBuyDate = buyDates[0] || '';
                    const maxBuyDate = buyDates[buyDates.length - 1] || '';
                    const sameBuyDate = minBuyDate.slice(0, 10) === maxBuyDate.slice(0, 10);

                    const totalCommission = lots.reduce((s, l) => s + l.commission, 0);

                    return (
                      <Fragment key={pos.ticker}>
                        <TableRow
                          className={isMultiLot ? 'cursor-pointer hover:bg-muted/50' : undefined}
                          onClick={isMultiLot ? () => togglePosition(pos.ticker) : undefined}
                          role={isMultiLot ? 'button' : undefined}
                          tabIndex={isMultiLot ? 0 : undefined}
                          onKeyDown={isMultiLot ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePosition(pos.ticker); } } : undefined}
                        >
                          <TableCell className="font-mono font-medium">
                            <div className="flex items-center gap-1">
                              {isMultiLot && (
                                isExpanded
                                  ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                                  : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                              )}
                              {pos.ticker}
                              <CategoryBadge category={pos.category} />
                              {isMultiLot && <span className="text-xs text-muted-foreground ml-1">({lots.length})</span>}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{formatQuantity(pos.shares)}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {minBuyDate
                              ? sameBuyDate
                                ? formatDate(minBuyDate)
                                : `${formatDate(minBuyDate)} – ${formatDate(maxBuyDate)}`
                              : '—'}
                          </TableCell>
                          <TableCell className="text-right">{formatNumber(pos.avgBuyPrice)}</TableCell>
                          <TableCell className="text-right text-muted-foreground text-xs">
                            {totalCommission > 0 ? formatNumber(totalCommission) : '—'}
                          </TableCell>
                          <TableCell className="text-right">
                            {pos.currentPrice != null ? formatNumber(pos.currentPrice) : '—'}
                            <span className="text-xs text-muted-foreground ml-1">{pos.currency}</span>
                          </TableCell>
                          <TableCell className="text-right">{formatNumber(pos.currentValuePln)}</TableCell>
                          <TableCell className={`text-right font-medium ${plColor(pos.profitLossPct)}`}>
                            {formatCurrency(pos.profitLoss, pos.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <PLBadge value={pos.profitLossPct} />
                          </TableCell>
                          <TableCell>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={(e) => { e.stopPropagation(); isSelling ? setSellingTicker(null) : startSell(pos); }}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <TrendingDown className="h-3 w-3 mr-1" />
                              Sprzedaj
                            </Button>
                          </TableCell>
                        </TableRow>

                        {isExpanded && lots.map((lot, j) => (
                          <TableRow key={`${pos.ticker}-lot-${j}`} className="bg-muted/30">
                            <TableCell className="font-mono text-muted-foreground pl-9 text-sm">
                              └ lot {j + 1}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">{formatQuantity(lot.quantity)}</TableCell>
                            <TableCell className="text-muted-foreground">{formatDate(lot.date)}</TableCell>
                            <TableCell className="text-right text-muted-foreground">{formatNumber(lot.price)}</TableCell>
                            <TableCell className="text-right text-muted-foreground text-xs">
                              {lot.commission > 0 ? formatNumber(lot.commission) : '—'}
                            </TableCell>
                            <TableCell />
                            <TableCell />
                            <TableCell />
                            <TableCell />
                            <TableCell />
                          </TableRow>
                        ))}

                        {isSelling && (
                          <TableRow className="bg-muted/30">
                            <TableCell colSpan={10} className="px-4 py-3">
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
                                    className="text-gain hover:text-gain/80"
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
            </>
          ) : (
            <EmptyState message="Brak otwartych pozycji." />
          )}
        </CardContent>
      </Card>
      </div>
      </div>

      {/* Closed trades */}
      {tab === 'closed' && (
        <ClosedTradesPage
          dateRange={closedDateRange}
          onDateRangeChange={setClosedDateRange}
          customFrom={closedCustomFrom}
          onCustomFromChange={setClosedCustomFrom}
          customTo={closedCustomTo}
          onCustomToChange={setClosedCustomTo}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? 'text-foreground'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        <span className={`text-[10px] font-semibold tabular-nums ${active ? 'text-primary' : 'text-muted-foreground/70'}`}>
          {count}
        </span>
      </span>
      {active && (
        <span className="absolute left-2 right-2 -bottom-[1px] h-0.5 rounded-full bg-primary" />
      )}
    </button>
  );
}
