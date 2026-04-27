import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidateCorporateActions } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CcyChip } from '@/components/ui/ccy-chip';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip as UITooltip,
  TooltipContent as UITooltipContent,
  TooltipTrigger as UITooltipTrigger,
} from '@/components/ui/tooltip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { formatDate, formatCurrency, formatNumber } from '@/lib/formatters';
import {
  Check,
  AlertTriangle,
  Trash2,
  Info,
  Loader2,
  Briefcase,
  Landmark,
  Receipt,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';

// ─── TYPES ───────────────────────────────────────────────────────────────────

type Subkind = 'nominal_reduction' | 'redemption_adjustment' | 'unknown_tender' | 'unknown_warrant';

interface CorporateAction {
  id: number;
  date: string;
  operationType: 'capital_return' | 'corporate_action_pending';
  subkind?: Subkind;
  ticker?: string;
  amount: number;
  currency: string;
  description: string;
  source: string;
  status: 'resolved' | 'pending';
}

/**
 * Operacja w sekcji "Pozostałe przepływy".
 *
 * UWAGA: pole `category='trade_fee'` obejmuje TYLKO swap/rollover/tax IFTT dla
 * instrumentów **non-CFD** (stock/ETF) — emitowane przez parser XTB gdy category
 * symbolu != 'cfd' (xtb-transactions.ts:769). Dla pozycji CFD swap i rollover
 * są zapisywane bezpośrednio na transakcji (Transaction.swap/rollover pola)
 * i widoczne w zakładce Transakcje/Closed trades — NIE duplikują się tutaj.
 */
interface AdditionalCost {
  id: number;
  date: string;
  category: 'fee' | 'trade_fee' | 'commission_refund' | 'other';
  subkind?: string;
  ticker?: string;
  amount: number;
  currency: string;
  description: string;
  source: string;
}

// ─── SUBKIND META (corporate actions) ────────────────────────────────────────

const SUBKIND_META: Record<
  Subkind,
  { label: string; variant: 'success' | 'info' | 'warning'; tooltip: string }
> = {
  nominal_reduction: {
    label: 'Zwrot kapitału',
    variant: 'success',
    tooltip:
      'Obniżenie wartości nominalnej akcji — emitent zwraca część kapitału akcjonariuszom bez ' +
      'zmiany liczby posiadanych akcji. Liczy się do MWR/TWR jako zrealizowany zwrot z trzymania pozycji.',
  },
  redemption_adjustment: {
    label: 'Wyrównanie wykupu',
    variant: 'info',
    tooltip:
      'Korekta/dopłata po wcześniejszym wykupie papieru wartościowego (Wykup PW - wyrównanie). ' +
      'Cash wpływa na konto, pozycja bez zmian.',
  },
  unknown_tender: {
    label: 'Nieznane wezwanie',
    variant: 'warning',
    tooltip:
      'Wezwanie skupu (Rozliczenie oferty) z tickerem spoza tender-offers-map. Nie wiemy ile akcji ' +
      'zostało sprzedanych i po jakiej cenie. Domknij ręcznie lub dopisz wezwanie do mapy i zaimportuj ponownie.',
  },
  unknown_warrant: {
    label: 'Nieznane wyrównanie PW',
    variant: 'warning',
    tooltip:
      'Wyrównanie wykupu PW bez dopasowania do wcześniejszej transakcji. Wcześniej wpadało w "other" ' +
      '(ukryte). Domknij ręcznie wskazując ticker, qty i cenę.',
  },
};

function SubkindBadge({ subkind }: { subkind?: Subkind }) {
  if (!subkind) return <Badge variant="outline">—</Badge>;
  const meta = SUBKIND_META[subkind];
  // Semantic colors projektu: gain/loss z tailwind (P&L), amber-500/blue-500 jak w TradesFeed.
  const colorClass =
    meta.variant === 'success'
      ? 'bg-gain/10 text-gain border-gain/30'
      : meta.variant === 'info'
        ? 'bg-blue-500/10 text-blue-500 border-blue-500/30'
        : 'bg-amber-500/10 text-amber-500 border-amber-500/30';
  return (
    <UITooltip delayDuration={150}>
      <UITooltipTrigger asChild>
        <Badge variant="outline" className={`${colorClass} cursor-help`}>
          {meta.variant === 'warning' && <AlertTriangle className="h-3 w-3 mr-1" />}
          {meta.variant === 'success' && <Check className="h-3 w-3 mr-1" />}
          {meta.label}
        </Badge>
      </UITooltipTrigger>
      <UITooltipContent className="max-w-xs">{meta.tooltip}</UITooltipContent>
    </UITooltip>
  );
}

// ─── COST CATEGORY META (additional costs — dolna sekcja) ────────────────────

/**
 * Virtual category — dla UI dzielimy `other` z subkind='interest' jako osobną kategorię
 * "Odsetki" (zielona). W DB to dalej operation_type='other', tylko subkind rozróżnia.
 */
type CostVirtualCategory = 'fee' | 'commission_refund' | 'trade_fee' | 'interest' | 'other';

function virtualCategory(c: {
  category: AdditionalCost['category'];
  subkind?: string;
}): CostVirtualCategory {
  if (c.category === 'other' && c.subkind === 'interest') return 'interest';
  return c.category;
}

const COST_CATEGORY_META: Record<
  CostVirtualCategory,
  { label: string; color: string; tooltip: string }
> = {
  fee: {
    label: 'Opłata',
    color: 'bg-loss/15 text-loss border-loss/30',
    tooltip:
      'Opłaty brokerskie i giełdowe (prowizje za wnioski, blokady na oferty skupu, exchange fees).',
  },
  commission_refund: {
    label: 'Zwrot prowizji',
    color: 'bg-gain/10 text-gain border-gain/30',
    tooltip:
      'Zwrot prowizji — broker oddaje prowizję z anulowanego/niespełnionego zlecenia. Dodatnia kwota oznacza wpływ na konto.',
  },
  trade_fee: {
    label: 'Podatek tx / swap',
    color: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
    tooltip:
      'Tax IFTT (włoski podatek od transakcji na akcjach/ETF) oraz rzadkie swap/rollover poza CFD. ' +
      'Swap i rollover dla CFD są wliczone bezpośrednio w prowizję transakcji (pola Transaction.swap/rollover) ' +
      'i widoczne w zakładce Transakcje oraz w szczegółach Closed trades — NIE tutaj.',
  },
  interest: {
    label: 'Odsetki',
    color: 'bg-gain/10 text-gain border-gain/30',
    tooltip:
      'Odsetki od wolnych środków na rachunku brokerskim (np. XTB Free funds interest) lub od lokaty overnight. ' +
      'Dodatni cashflow, ale nie dywidenda spółki — nie wlicza się do totalDividends. Wchodzi do salda gotówki.',
  },
  other: {
    label: 'Inne',
    color: 'bg-muted text-muted-foreground border-border',
    tooltip:
      'Niesklasyfikowane operacje (np. rights issue, różne). Wchodzą do salda gotówki, ale nie do MWR jako wpłaty.',
  },
};

function CostCategoryBadge({ category }: { category: CostVirtualCategory }) {
  const meta = COST_CATEGORY_META[category];
  return (
    <UITooltip delayDuration={150}>
      <UITooltipTrigger asChild>
        <Badge variant="outline" className={`${meta.color} cursor-help`}>
          {meta.label}
        </Badge>
      </UITooltipTrigger>
      <UITooltipContent className="max-w-xs">{meta.tooltip}</UITooltipContent>
    </UITooltip>
  );
}

// ─── RESOLVE DIALOG (dla pending corporate actions) ──────────────────────────

function ResolveDialog({
  action,
  onClose,
  onSuccess,
}: {
  action: CorporateAction | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [ticker, setTicker] = useState(action?.ticker ?? '');
  const [isin, setIsin] = useState('');

  const resolveMut = useMutation({
    mutationFn: () => {
      if (!action) throw new Error('no action');
      return api.resolveCorporateAction(action.id, {
        quantity: Number(quantity),
        price: Number(price),
        ticker: ticker || undefined,
        isin: isin || undefined,
      });
    },
    onSuccess: (data) => {
      toast.success(
        data.transactionsInserted > 0
          ? `Domknięto sprzedażą syntetyczną (qty=${quantity}, cena=${price}).`
          : 'Synthetic SELL nie został wstawiony (możliwy duplikat).',
      );
      onSuccess();
      onClose();
    },
    onError: (e: Error) => toast.error(`Nie udało się domknąć: ${e.message}`),
  });

  if (!action) return null;

  const suggestedPrice =
    quantity && Number(quantity) > 0 ? (Math.abs(action.amount) / Number(quantity)).toFixed(2) : '';

  return (
    <Dialog open={!!action} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Domknij zdarzenie: {action.description}</DialogTitle>
          <DialogDescription>
            Tworzymy syntetyczną sprzedaż (side='S') z tą datą i kwotą jako wpływem. Po domknięciu
            pozycja zostanie pomniejszona o wskazaną liczbę akcji, a wpływ cash stanie się widoczny
            w metrykach jak zwykły zysk ze sprzedaży.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Data</div>
              <div className="font-medium">{formatDate(action.date)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Kwota brutto</div>
              <div className="font-medium">{formatCurrency(action.amount, action.currency)}</div>
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Ticker</label>
            <Input
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="np. MOSTALZAB"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">
              ISIN (opcjonalny — pobrany z historii jeśli pusty)
            </label>
            <Input
              value={isin}
              onChange={(e) => setIsin(e.target.value)}
              placeholder="np. PLMSTLZ00019"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Liczba akcji *</label>
              <Input
                type="number"
                step="1"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="np. 333"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Cena za akcję *{suggestedPrice && ` (sugerowana: ${suggestedPrice})`}
              </label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="np. 11.50"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Anuluj
          </Button>
          <Button
            onClick={() => resolveMut.mutate()}
            disabled={!quantity || !price || resolveMut.isPending}
          >
            {resolveMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Domknij sprzedażą
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ADD COST DIALOG (ręczne dodanie operacji w "Pozostałych przepływach") ───

/** Kategorie wybieralne w dialogu dodawania — mapują na (operation_type, subkind).
 *  "Odsetki" to UI-level split z `other` po subkind='interest'. */
const ADD_CATEGORIES: Array<{
  value: string;
  label: string;
  category: 'fee' | 'trade_fee' | 'commission_refund' | 'other';
  subkind?: 'interest';
  hint: string;
  defaultSign: 'negative' | 'positive';
}> = [
  {
    value: 'fee',
    label: 'Opłata',
    category: 'fee',
    hint: 'Opłata brokerska/giełdowa (wpisz dodatnio — znak zostanie dobrany automatycznie).',
    defaultSign: 'negative',
  },
  {
    value: 'commission_refund',
    label: 'Zwrot prowizji',
    category: 'commission_refund',
    hint: 'Zwrot prowizji od brokera (np. z anulowanego zlecenia).',
    defaultSign: 'positive',
  },
  {
    value: 'trade_fee',
    label: 'Podatek transakcyjny / swap',
    category: 'trade_fee',
    hint: 'Podatek od transakcji (Tax IFTT) lub swap/rollover dla non-CFD.',
    defaultSign: 'negative',
  },
  {
    value: 'interest',
    label: 'Odsetki',
    category: 'other',
    subkind: 'interest',
    hint: 'Odsetki od wolnych środków na rachunku (np. XTB Free funds interest).',
    defaultSign: 'positive',
  },
  {
    value: 'other',
    label: 'Inne',
    category: 'other',
    hint: 'Operacja niesklasyfikowana — rights issue, różne.',
    defaultSign: 'negative',
  },
];

function AddCostDialog({
  open,
  onClose,
  onSuccess,
  defaultCurrency,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  defaultCurrency: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [categoryValue, setCategoryValue] = useState<string>('fee');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [description, setDescription] = useState('');

  const selected = ADD_CATEGORIES.find((c) => c.value === categoryValue) ?? ADD_CATEGORIES[0];

  const createMut = useMutation({
    mutationFn: () => {
      // Automatyczny znak — user wpisuje kwotę dodatnią, silnik ustawia znak per kategoria.
      // Jeśli user wpisał jawnie znak, szanujemy go (nadpisuje default).
      const raw = Number(amount);
      const abs = Math.abs(raw);
      const signedAmount = raw < 0 ? raw : selected.defaultSign === 'negative' ? -abs : abs;
      return api.createAdditionalCost({
        date,
        category: selected.category,
        subkind: selected.subkind,
        amount: signedAmount,
        currency: currency.toUpperCase(),
        description: description.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast.success(`Dodano operację: ${selected.label}`);
      onSuccess();
      onClose();
      // reset
      setAmount('');
      setDescription('');
      setCategoryValue('fee');
    },
    onError: (e: Error) => toast.error(`Nie udało się dodać: ${e.message}`),
  });

  const previewAmount =
    amount && !isNaN(Number(amount))
      ? (() => {
          const raw = Number(amount);
          const abs = Math.abs(raw);
          return raw < 0 ? raw : selected.defaultSign === 'negative' ? -abs : abs;
        })()
      : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dodaj operację — Pozostałe przepływy</DialogTitle>
          <DialogDescription>
            Operacja zostanie dodana jako ręczna (source='manual'). Wpływa na saldo gotówki
            portfela. Nie jest liczona jako wpłata w MWR/XIRR.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Kategoria *</label>
            <Select value={categoryValue} onValueChange={setCategoryValue}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ADD_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground mt-1">{selected.hint}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Data *</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Waluta</label>
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                placeholder="PLN"
                maxLength={3}
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">
              Kwota * (znak dobrany automatycznie:{' '}
              {selected.defaultSign === 'negative' ? 'ujemna = koszt' : 'dodatnia = wpływ'})
            </label>
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="np. 15.76"
            />
            {previewAmount !== null && (
              <p
                className={`text-[11px] mt-1 tabular-nums ${previewAmount < 0 ? 'text-loss' : 'text-gain'}`}
              >
                Zostanie zapisane jako: {formatCurrency(previewAmount, currency || 'PLN')}
              </p>
            )}
          </div>

          <div>
            <label className="text-xs text-muted-foreground">
              Opis (opcjonalnie — domyślnie "{selected.label}")
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={selected.label}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Anuluj
          </Button>
          <Button
            onClick={() => createMut.mutate()}
            disabled={!amount || !date || !currency || createMut.isPending}
          >
            {createMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Dodaj
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── SUMMARY CARD (zunifikowany wzorzec — spójny z Dashboard) ────────────────

function SummaryCard({
  label,
  value,
  currency = 'PLN',
  subtext,
  accent,
  icon,
}: {
  label: string;
  value: number;
  /** ISO 4217 code (PLN, USD...) lub '' dla surowej liczby (np. count). */
  currency?: string;
  subtext?: string;
  accent?: 'positive' | 'negative' | 'warning';
  icon?: React.ReactNode;
}) {
  const valueColor =
    accent === 'positive'
      ? 'text-gain'
      : accent === 'negative'
        ? 'text-loss'
        : accent === 'warning'
          ? 'text-amber-500'
          : '';
  // Empty currency = count/raw number (np. "Niedomknięte" pokazuje ilość). Intl.NumberFormat
  // wymaga validnego ISO kodu, więc fallback na toLocaleString dla raw liczb.
  const formatted = currency ? formatCurrency(value, currency) : value.toLocaleString('pl-PL');
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-semibold ${valueColor}`}>{formatted}</div>
        {subtext && <div className="text-xs text-muted-foreground mt-0.5">{subtext}</div>}
      </CardContent>
    </Card>
  );
}

// ─── MAIN PAGE ───────────────────────────────────────────────────────────────

export function CorrectionsAndCostsPage() {
  const qc = useQueryClient();
  const [resolving, setResolving] = useState<CorporateAction | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deletingCA, setDeletingCA] = useState<CorporateAction | null>(null);
  const [deletingCost, setDeletingCost] = useState<AdditionalCost | null>(null);

  const {
    data: corpData,
    isLoading: corpLoading,
    error: corpError,
  } = useQuery({
    queryKey: QUERY_KEYS.corporateActions,
    queryFn: () => api.getCorporateActions(),
  });

  const {
    data: costsData,
    isLoading: costsLoading,
    error: costsError,
  } = useQuery({
    queryKey: QUERY_KEYS.additionalCosts,
    queryFn: () => api.getAdditionalCosts(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteCorporateAction(id),
    onSuccess: () => {
      invalidateCorporateActions(qc);
      toast.success('Usunięto zdarzenie korporacyjne.');
    },
    onError: (e: Error) => toast.error(`Nie udało się usunąć: ${e.message}`),
  });

  const deleteCostMut = useMutation({
    mutationFn: (id: number) => api.deleteAdditionalCost(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.additionalCosts });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.metrics });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.history });
      toast.success('Usunięto operację.');
    },
    onError: (e: Error) => toast.error(`Nie udało się usunąć: ${e.message}`),
  });

  const actions = corpData?.actions ?? [];
  const pendingCount = corpData?.totals.pendingCount ?? 0;
  const totalCapitalReturn = corpData?.totals.capitalReturn ?? 0;
  // Waluta bazowa portfela. Oba endpointy zwracają tę samą wartość (detectBaseCurrency),
  // ale costsData jest bardziej stabilne (zawsze są jakieś operacje). Fallback PLN.
  const baseCurrency = costsData?.baseCurrency ?? corpData?.baseCurrency ?? 'PLN';

  const { resolved, pending } = useMemo(() => {
    const r: CorporateAction[] = [];
    const p: CorporateAction[] = [];
    for (const a of actions) {
      if (a.status === 'resolved') r.push(a);
      else p.push(a);
    }
    return { resolved: r, pending: p };
  }, [actions]);

  const costs = costsData?.operations ?? [];
  const costTotals = costsData?.totals ?? {
    fees: 0,
    commissionRefunds: 0,
    tradeFees: 0,
    other: 0,
    grandTotal: 0,
  };

  const isLoading = corpLoading || costsLoading;
  const error = corpError ?? costsError;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-destructive">
          Błąd ładowania panelu: {(error as Error).message}
        </CardContent>
      </Card>
    );
  }

  // UWAGA: nie renderuj empty state jako wczesny return — user musi zawsze mieć dostęp
  // do "Dodaj operację" w sekcji dolnej, nawet gdy nie ma żadnych danych z importu.
  // Sekcje mają własne empty-state messages (lokalne "Brak...").

  return (
    <div className="space-y-4">
      {/* Top-level summary (spójne z Dashboard / Portfel) — 3 merytoryczne kafle.
          Liczba pending-ów pokazana jako warning badge w tytule sekcji górnej. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard
          label="Zwrot kapitału"
          value={totalCapitalReturn}
          currency={baseCurrency}
          accent="positive"
          subtext={`${resolved.length} operacji · liczy się do MWR/TWR`}
          icon={<Check className="h-3 w-3 text-gain" />}
        />
        <SummaryCard
          label="Koszty"
          value={costTotals.fees + costTotals.tradeFees}
          currency={baseCurrency}
          accent={costTotals.fees + costTotals.tradeFees < 0 ? 'negative' : undefined}
          subtext="Opłaty brokerskie + tax IFTT"
          icon={<Receipt className="h-3 w-3 text-loss" />}
        />
        <SummaryCard
          label="Zwroty prowizji"
          value={costTotals.commissionRefunds}
          currency={baseCurrency}
          accent="positive"
          subtext={`${costs.filter((c) => c.category === 'commission_refund').length} operacji`}
          icon={<Check className="h-3 w-3 text-gain" />}
        />
      </div>

      {/* ─── SEKCJA GÓRNA: Zdarzenia korporacyjne ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Landmark className="h-4 w-4 text-primary" />
            Zdarzenia korporacyjne
            {pendingCount > 0 && (
              <Badge
                variant="outline"
                className="bg-amber-500/10 text-amber-500 border-amber-500/30"
              >
                <AlertTriangle className="h-3 w-3 mr-1" />
                {pendingCount} do domknięcia
              </Badge>
            )}
            <UITooltip delayDuration={150}>
              <UITooltipTrigger asChild>
                <Info className="h-3 w-3 text-muted-foreground cursor-help" />
              </UITooltipTrigger>
              <UITooltipContent className="max-w-sm">
                Zwroty kapitału (np. obniżenie nominału), korekty wykupu, wezwania skupu. Cash
                wpływa na konto, pozycja akcyjna bez zmian. MWR/TWR liczy te wartości jako
                zrealizowany zwrot z trzymania pozycji.
              </UITooltipContent>
            </UITooltip>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Pending (conditional — tylko gdy są) */}
          {pending.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2 text-sm font-medium text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                Wymagają domknięcia ({pending.length})
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Data</TableHead>
                    <TableHead className="w-36">Typ</TableHead>
                    <TableHead className="w-24">Ticker</TableHead>
                    <TableHead>Opis</TableHead>
                    <TableHead className="text-right w-32">Kwota</TableHead>
                    <TableHead className="w-16">Źródło</TableHead>
                    <TableHead className="text-right w-48">Akcje</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap text-sm tabular-nums">
                        {formatDate(a.date)}
                      </TableCell>
                      <TableCell>
                        <SubkindBadge subkind={a.subkind} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{a.ticker ?? '—'}</TableCell>
                      <TableCell className="text-sm">{a.description}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatCurrency(a.amount, a.currency)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {a.source}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="default" onClick={() => setResolving(a)}>
                          <Briefcase className="h-3 w-3 mr-1" />
                          Domknij
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-1 text-destructive hover:text-destructive"
                          onClick={() => setDeletingCA(a)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Resolved (capital_return) */}
          <div>
            <div className="flex items-center gap-2 mb-2 text-sm font-medium text-gain">
              <Check className="h-3.5 w-3.5" />
              Zwroty kapitałowe ({resolved.length})
            </div>
            {resolved.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-6">
                Brak zrealizowanych zwrotów kapitału w tym portfelu.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Data</TableHead>
                    <TableHead className="w-36">Typ</TableHead>
                    <TableHead className="w-24">Ticker</TableHead>
                    <TableHead>Opis</TableHead>
                    <TableHead className="text-right w-32">Kwota</TableHead>
                    <TableHead className="w-16">Źródło</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resolved.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap text-sm tabular-nums">
                        {formatDate(a.date)}
                      </TableCell>
                      <TableCell>
                        <SubkindBadge subkind={a.subkind} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{a.ticker ?? '—'}</TableCell>
                      <TableCell className="text-sm">{a.description}</TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums ${
                          a.amount < 0 ? 'text-loss' : a.amount > 0 ? 'text-gain' : ''
                        }`}
                      >
                        {formatCurrency(a.amount, a.currency)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {a.source}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {a.source === 'manual' && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive"
                            onClick={() => setDeletingCA(a)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ─── SEKCJA DOLNA: Pozostałe przepływy ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-primary" />
              Pozostałe przepływy
              <UITooltip delayDuration={150}>
                <UITooltipTrigger asChild>
                  <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                </UITooltipTrigger>
                <UITooltipContent className="max-w-sm">
                  Opłaty brokerskie i giełdowe, zwroty prowizji, podatek transakcyjny (Tax IFTT),
                  odsetki od wolnych środków, niestandardowe operacje (rights issue). Wchodzą do
                  salda gotówki ale NIE są liczone jako wpłaty w MWR/XIRR.
                  <br />
                  <br />
                  <strong>Uwaga:</strong> swap i rollover dla pozycji CFD są zapisane bezpośrednio
                  na transakcji (pola Transaction.swap/rollover) i widoczne w zakładce Transakcje
                  oraz w szczegółach Closed trades, nie tutaj.
                </UITooltipContent>
              </UITooltip>
            </span>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              Dodaj operację
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Mini summary per virtualCategory (pokazuje tylko niezerowe).
              Odsetki (other + subkind='interest') są osobnym kaflem zielonym,
              a "Inne" zbiera resztę `other` bez tego subkindu. */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {(() => {
              // Podziel `other` na 'interest' vs reszta.
              const interestOps = costs.filter(
                (c) => c.category === 'other' && c.subkind === 'interest',
              );
              const otherRestOps = costs.filter(
                (c) => c.category === 'other' && c.subkind !== 'interest',
              );
              const interestTotal = interestOps.reduce((s, o) => s + o.amount, 0);
              const otherRestTotal = otherRestOps.reduce((s, o) => s + o.amount, 0);
              return [
                {
                  virtualCat: 'fee' as const,
                  label: 'Opłaty',
                  total: costTotals.fees,
                  count: costs.filter((c) => c.category === 'fee').length,
                },
                {
                  virtualCat: 'commission_refund' as const,
                  label: 'Zwroty prowizji',
                  total: costTotals.commissionRefunds,
                  count: costs.filter((c) => c.category === 'commission_refund').length,
                },
                {
                  virtualCat: 'trade_fee' as const,
                  label: 'Podatek tx / swap',
                  total: costTotals.tradeFees,
                  count: costs.filter((c) => c.category === 'trade_fee').length,
                },
                {
                  virtualCat: 'interest' as const,
                  label: 'Odsetki',
                  total: interestTotal,
                  count: interestOps.length,
                },
                {
                  virtualCat: 'other' as const,
                  label: 'Inne',
                  total: otherRestTotal,
                  count: otherRestOps.length,
                },
              ];
            })().map((tile) => {
              if (tile.count === 0) return null;
              return (
                <div
                  key={tile.virtualCat}
                  className="rounded-lg bg-muted/30 border border-border px-3 py-2"
                >
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-0.5">
                    {tile.label}
                  </p>
                  <p
                    className={`text-sm font-bold tabular-nums tracking-tight ${
                      tile.total < 0 ? 'text-loss' : tile.total > 0 ? 'text-gain' : ''
                    }`}
                  >
                    {formatCurrency(tile.total, baseCurrency)}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{tile.count} operacji</p>
                </div>
              );
            })}
          </div>

          {/* Historia */}
          {costs.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-6">
              Brak operacji kosztowych w tym portfelu.
            </p>
          ) : (
            <div className="max-h-[600px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Data</TableHead>
                    <TableHead className="w-32">Kategoria</TableHead>
                    <TableHead>Opis</TableHead>
                    <TableHead className="text-right w-32">Kwota</TableHead>
                    <TableHead className="w-16">Waluta</TableHead>
                    <TableHead className="w-16">Źródło</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {costs.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap text-sm tabular-nums">
                        {formatDate(c.date)}
                      </TableCell>
                      <TableCell>
                        <CostCategoryBadge category={virtualCategory(c)} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.description}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums ${
                          c.amount < 0 ? 'text-loss' : c.amount > 0 ? 'text-gain' : ''
                        }`}
                      >
                        {formatNumber(c.amount)}
                      </TableCell>
                      <TableCell>
                        <CcyChip ccy={c.currency} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {c.source}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {c.source === 'manual' && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive"
                            onClick={() => setDeletingCost(c)}
                            disabled={deleteCostMut.isPending}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ResolveDialog
        action={resolving}
        onClose={() => setResolving(null)}
        onSuccess={() => invalidateCorporateActions(qc)}
      />

      <AddCostDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: QUERY_KEYS.additionalCosts });
          qc.invalidateQueries({ queryKey: QUERY_KEYS.metrics });
          qc.invalidateQueries({ queryKey: QUERY_KEYS.history });
        }}
        defaultCurrency={baseCurrency}
      />

      <ConfirmDeleteDialog
        open={!!deletingCA}
        onClose={() => setDeletingCA(null)}
        onConfirm={() => {
          if (deletingCA) {
            deleteMut.mutate(deletingCA.id);
            setDeletingCA(null);
          }
        }}
        description={
          deletingCA
            ? deletingCA.status === 'pending'
              ? `Usunąć pending ${deletingCA.ticker ?? ''} (${formatCurrency(deletingCA.amount, deletingCA.currency)}) z ${formatDate(deletingCA.date)}? Cash z tego zdarzenia zniknie z historii.`
              : `Usunąć zdarzenie zwrotu kapitału ${deletingCA.ticker ?? ''} (${formatCurrency(deletingCA.amount, deletingCA.currency)}) z ${formatDate(deletingCA.date)}?`
            : ''
        }
        loading={deleteMut.isPending}
      />

      <ConfirmDeleteDialog
        open={!!deletingCost}
        onClose={() => setDeletingCost(null)}
        onConfirm={() => {
          if (deletingCost) {
            deleteCostMut.mutate(deletingCost.id);
            setDeletingCost(null);
          }
        }}
        description={
          deletingCost
            ? `Usunąć operację "${deletingCost.description}" (${formatCurrency(deletingCost.amount, deletingCost.currency)}) z ${formatDate(deletingCost.date)}?`
            : ''
        }
        loading={deleteCostMut.isPending}
      />
    </div>
  );
}
