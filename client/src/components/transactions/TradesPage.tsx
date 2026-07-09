import { useState, useEffect, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { usePortfolio } from '@/lib/portfolio-context';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
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
import { Input } from '@/components/ui/input';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { FieldError } from '@/components/ui/field-error';
import { errorToast } from '@/lib/error-toast';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { formatNumber, formatCurrency, formatQuantity, formatDate } from '@/lib/formatters';
import { useToggleSet } from '@/hooks/useToggleSet';
import { Loader2, Plus, Check, X, TrendingDown, ChevronRight, ChevronDown } from 'lucide-react';
import { ClosedTradesPage } from './ClosedTradesPage';
import { TradesSummary } from './TradesSummary';
import { PositionCardMobile } from './PositionCardMobile';
import { TradesFeed } from './TradesFeed';
import { AddTransactionDialog } from './AddTransactionDialog';
import { SellPositionDialog } from './SellPositionDialog';
import { toast } from 'sonner';
import type { Position, InstrumentCategory } from 'shared';
import { displayOptionTicker } from 'shared';
import { TickerLabel } from '@/components/ui/ticker-label';

interface SellForm {
  date: string;
  quantity: string;
  price: string;
  commission: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export function TradesPage() {
  const queryClient = useQueryClient();
  const { activeSettings } = usePortfolio();

  const { data: posData, isLoading: posLoading } = useQuery({
    queryKey: QUERY_KEYS.positions,
    queryFn: api.getPositions,
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

  // Add transaction dialog state (unified Modal pattern — jak w pozostałych panelach)
  const [addOpen, setAddOpen] = useState(false);

  // Sell form — kontekstowa akcja z pozycji (inline w rzędzie, NIE modal).
  // Justyfikacja: user klika "Sprzedaj" w rzędzie otwartej pozycji i oczekuje natychmiastowej
  // prefillowanej formy (qty=shares, price=currentPrice). Modal byłby tu UX regresą.
  const [sellingTicker, setSellingTicker] = useState<string | null>(null);
  const [sellForm, setSellForm] = useState<SellForm>({
    date: '',
    quantity: '',
    price: '',
    commission: '0',
  });
  // Czy user ręcznie tknął prowizję — wyłącza auto-recalc po zmianie ceny/ilości.
  const [sellCommissionTouched, setSellCommissionTouched] = useState(false);

  // Mobile sell flow — modal Dialog zamiast inline form (na małym ekranie inline jest niepraktyczny).
  // Trzymane osobno od `sellingTicker`, żeby desktopowy inline flow działał niezależnie.
  const [mobileSellPosition, setMobileSellPosition] = useState<Position | null>(null);

  // Expand/collapse lot details
  const [expandedPositions, togglePosition] = useToggleSet<string>();

  // Tab switcher: all transactions / open positions / closed trades
  const [tab, setTab] = useState<'all' | 'open' | 'closed'>('open');

  // Closed tab date filter — lifted here so TradesSummary (tile values)
  // and ClosedTradesPage (table) stay in sync when user changes the year / custom range.
  const [closedDateRange, setClosedDateRange] = useState<string>('ALL');
  const [closedCustomFrom, setClosedCustomFrom] = useState('');
  const [closedCustomTo, setClosedCustomTo] = useState('');

  // Calc prowizji — używane do pre-fill dla kontekstowej sprzedaży z pozycji.
  const calcCommission = (ticker: string, quantity: string, price: string): string => {
    const qty = parseFloat(quantity);
    const prc = parseFloat(price);
    if (!qty || !prc || qty <= 0 || prc <= 0) return '0';
    const value = qty * prc;
    const isPolish = ticker.endsWith('.WA') || ticker.endsWith('.NC');
    const rate = isPolish
      ? activeSettings?.commissionPl || 0
      : activeSettings?.commissionForeign || 0;
    const min = isPolish
      ? activeSettings?.minCommissionPl || 0
      : activeSettings?.minCommissionForeign || 0;
    if (rate <= 0 && min <= 0) return '0';
    const commission = Math.max((value * rate) / 100, min);
    return (Math.round(commission * 100) / 100).toString();
  };

  const sellMutation = useMutation({
    mutationFn: ({
      ticker,
      form,
      category,
    }: {
      ticker: string;
      form: SellForm;
      category?: InstrumentCategory;
    }) =>
      api.createTransaction({
        date: form.date,
        ticker,
        side: 'S',
        quantity: parseFloat(form.quantity),
        price: parseFloat(form.price),
        commission: parseFloat(form.commission) || 0,
        category,
      }),
    onSuccess: (_data, vars) => {
      invalidatePortfolio(queryClient);
      toast.success(
        `Sprzedano ${vars.form.quantity} szt ${displayOptionTicker(vars.ticker)} @ ${vars.form.price}`,
      );
      setSellingTicker(null);
    },
    onError: (err: Error) => errorToast('Nie udało się sprzedać', err),
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
    setSellCommissionTouched(false);
  }

  // Auto-recalc prowizji po zmianie ceny/ilości (analogicznie do AddTransactionDialog).
  // Jeśli user ręcznie nadpisał prowizję — przestajemy nadpisywać jego wartość.
  useEffect(() => {
    if (!sellingTicker) return;
    if (sellCommissionTouched) return;
    if (!sellForm.quantity || !sellForm.price) return;
    const next = calcCommission(sellingTicker, sellForm.quantity, sellForm.price);
    setSellForm((prev) => (prev.commission === next ? prev : { ...prev, commission: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellingTicker, sellForm.quantity, sellForm.price, sellCommissionTouched]);

  const positions: Position[] = posData?.positions || [];

  // Pozycja, dla której otwarty jest inline sell form — ilość nie może przekroczyć
  // posiadanych akcji (backend i tak by odrzucił/oversold, ale walidujemy od razu w UI).
  const sellingPos = sellingTicker ? positions.find((p) => p.ticker === sellingTicker) : undefined;

  // Jedyny nieoczywisty powód blokady — przekroczenie posiadanej ilości. Pokazujemy
  // go od razu (bez gate'owania submitem), bo formularz startuje prefillowany/poprawny.
  const sellQtyError =
    sellingPos && parseFloat(sellForm.quantity) > sellingPos.shares
      ? `Maksymalnie ${formatQuantity(sellingPos.shares)} szt.`
      : undefined;

  const isSellValid =
    sellForm.date &&
    sellForm.quantity &&
    parseFloat(sellForm.quantity) > 0 &&
    !sellQtyError &&
    sellForm.price &&
    parseFloat(sellForm.price) > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Dodaj transakcję
        </Button>
      </div>

      {/* Tab switcher — Wszystkie / Otwarte / Zamknięte */}
      <div className="flex items-center gap-1 border-b border-border overflow-x-auto overflow-y-hidden">
        <TabButton
          active={tab === 'all'}
          onClick={() => setTab('all')}
          label="Wszystkie"
          count={txCount}
        />
        <TabButton
          active={tab === 'open'}
          onClick={() => setTab('open')}
          label="Otwarte"
          count={positions.length}
        />
        <TabButton
          active={tab === 'closed'}
          onClick={() => setTab('closed')}
          label="Zamknięte"
          count={closedCount}
        />
      </div>

      <TradesSummary
        tab={tab}
        positions={positions}
        closedDateRange={closedDateRange}
        closedCustomFrom={closedCustomFrom}
        closedCustomTo={closedCustomTo}
      />

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
            top: 0,
            left: 0,
            right: 0,
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
            top: 0,
            left: 0,
            right: 0,
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
                        isExpanded={expandedPositions.has(pos.ticker)}
                        onToggle={() => togglePosition(pos.ticker)}
                        onSell={() => setMobileSellPosition(pos)}
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
                          const buyDates = lots.map((l) => l.date).sort();
                          const minBuyDate = buyDates[0] || '';
                          const maxBuyDate = buyDates[buyDates.length - 1] || '';
                          const sameBuyDate = minBuyDate.slice(0, 10) === maxBuyDate.slice(0, 10);

                          const totalCommission = lots.reduce((s, l) => s + l.commission, 0);

                          return (
                            <Fragment key={pos.ticker}>
                              <TableRow
                                className={
                                  isMultiLot ? 'cursor-pointer hover:bg-muted/50' : undefined
                                }
                                onClick={isMultiLot ? () => togglePosition(pos.ticker) : undefined}
                                role={isMultiLot ? 'button' : undefined}
                                tabIndex={isMultiLot ? 0 : undefined}
                                onKeyDown={
                                  isMultiLot
                                    ? (e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          e.preventDefault();
                                          togglePosition(pos.ticker);
                                        }
                                      }
                                    : undefined
                                }
                              >
                                <TableCell className="font-mono font-medium">
                                  <div className="flex items-center gap-1">
                                    {isMultiLot &&
                                      (isExpanded ? (
                                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                                      ) : (
                                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                                      ))}
                                    <TickerLabel ticker={pos.ticker} />
                                    <CategoryBadge category={pos.category} />
                                    {isMultiLot && (
                                      <span className="text-xs text-muted-foreground ml-1">
                                        ({lots.length})
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatQuantity(pos.shares)}
                                </TableCell>
                                <TableCell className="text-muted-foreground text-sm">
                                  {minBuyDate
                                    ? sameBuyDate
                                      ? formatDate(minBuyDate)
                                      : `${formatDate(minBuyDate)} – ${formatDate(maxBuyDate)}`
                                    : '—'}
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatNumber(pos.avgBuyPrice)}
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground text-xs">
                                  {totalCommission > 0 ? formatNumber(totalCommission) : '—'}
                                </TableCell>
                                <TableCell className="text-right">
                                  {pos.currentPrice != null ? formatNumber(pos.currentPrice) : '—'}
                                  <span className="text-xs text-muted-foreground ml-1">
                                    {pos.currency}
                                  </span>
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatNumber(pos.currentValuePln)}
                                </TableCell>
                                <TableCell
                                  className={`text-right font-medium ${plColor(pos.profitLossPct)}`}
                                >
                                  {formatCurrency(pos.profitLoss, pos.currency)}
                                </TableCell>
                                <TableCell className="text-right">
                                  <PLBadge value={pos.profitLossPct} />
                                </TableCell>
                                <TableCell>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      isSelling ? setSellingTicker(null) : startSell(pos);
                                    }}
                                    className="text-muted-foreground hover:text-destructive"
                                  >
                                    <TrendingDown className="h-3 w-3 mr-1" />
                                    Sprzedaj
                                  </Button>
                                </TableCell>
                              </TableRow>

                              {isExpanded &&
                                lots.map((lot, j) => (
                                  <TableRow key={`${pos.ticker}-lot-${j}`} className="bg-muted/30">
                                    <TableCell className="font-mono text-muted-foreground pl-9 text-sm">
                                      └ lot {j + 1}
                                    </TableCell>
                                    <TableCell className="text-right text-muted-foreground">
                                      {formatQuantity(lot.quantity)}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                      {formatDate(lot.date)}
                                    </TableCell>
                                    <TableCell className="text-right text-muted-foreground">
                                      {formatNumber(lot.price)}
                                    </TableCell>
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
                                      <span className="text-sm font-medium">
                                        Sprzedaż {displayOptionTicker(pos.ticker)}
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap items-end gap-4">
                                      <div className="flex flex-col gap-2">
                                        <label className="text-xs text-muted-foreground">
                                          Ilość
                                        </label>
                                        <Input
                                          type="number"
                                          step="0.0001"
                                          min="0.0001"
                                          max={pos.shares}
                                          value={sellForm.quantity}
                                          onChange={(e) =>
                                            setSellForm({ ...sellForm, quantity: e.target.value })
                                          }
                                          className="h-8 w-[90px] text-right"
                                          aria-invalid={!!sellQtyError}
                                        />
                                        <FieldError error={sellQtyError} />
                                      </div>
                                      <div className="flex flex-col gap-2">
                                        <label className="text-xs text-muted-foreground">
                                          Cena
                                        </label>
                                        <Input
                                          type="number"
                                          step="0.01"
                                          min="0"
                                          value={sellForm.price}
                                          onChange={(e) =>
                                            setSellForm({ ...sellForm, price: e.target.value })
                                          }
                                          className="h-8 w-[110px] text-right"
                                        />
                                      </div>
                                      <div className="flex flex-col gap-2">
                                        <label className="text-xs text-muted-foreground">
                                          Data
                                        </label>
                                        <Input
                                          type="date"
                                          value={sellForm.date}
                                          onChange={(e) =>
                                            setSellForm({ ...sellForm, date: e.target.value })
                                          }
                                          className="h-8 w-[140px]"
                                        />
                                      </div>
                                      <div className="flex flex-col gap-2">
                                        <label className="text-xs text-muted-foreground">
                                          Prowizja{' '}
                                          {!sellCommissionTouched && (
                                            <span className="text-[10px] opacity-60">(auto)</span>
                                          )}
                                        </label>
                                        <Input
                                          type="number"
                                          step="0.01"
                                          min="0"
                                          value={sellForm.commission}
                                          onChange={(e) => {
                                            setSellForm({
                                              ...sellForm,
                                              commission: e.target.value,
                                            });
                                            setSellCommissionTouched(true);
                                          }}
                                          className="h-8 w-[90px] text-right"
                                        />
                                      </div>
                                      <div className="flex gap-1 pb-0.5">
                                        <Button
                                          size="icon-xs"
                                          variant="ghost"
                                          onClick={() =>
                                            sellMutation.mutate({
                                              ticker: pos.ticker,
                                              form: sellForm,
                                              category: pos.category,
                                            })
                                          }
                                          disabled={!isSellValid || sellMutation.isPending}
                                          className="text-gain hover:text-gain/80"
                                        >
                                          {sellMutation.isPending ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                          ) : (
                                            <Check className="h-3 w-3" />
                                          )}
                                        </Button>
                                        <Button
                                          size="icon-xs"
                                          variant="ghost"
                                          onClick={() => setSellingTicker(null)}
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

      <AddTransactionDialog open={addOpen} onClose={() => setAddOpen(false)} />

      <SellPositionDialog
        position={mobileSellPosition}
        onClose={() => setMobileSellPosition(null)}
      />
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
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        <span
          className={`text-[10px] font-semibold tabular-nums ${active ? 'text-primary' : 'text-muted-foreground/70'}`}
        >
          {count}
        </span>
      </span>
      {active && (
        <span className="absolute left-2 right-2 -bottom-[1px] h-0.5 rounded-full bg-primary" />
      )}
    </button>
  );
}
