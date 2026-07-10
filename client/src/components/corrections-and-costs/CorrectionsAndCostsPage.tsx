import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
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
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
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
import { ExpandableCard, ExpandableCardSubRow } from '@/components/ui/expandable-card';
import { useToggleSet } from '@/hooks/useToggleSet';
import {
  FilterBar,
  FilterFieldLabel,
  YearRangeFilter,
  matchesDateRange,
} from '@/components/shared/filters';

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
type CostVirtualCategory =
  | 'fee'
  | 'commission_refund'
  | 'trade_fee'
  | 'interest'
  | 'other'
  | 'margin_interest'
  | 'borrow_fee'
  | 'market_data'
  | 'fx_commission'
  | 'sales_tax'
  | 'lending_income';

/** Subkindy kosztów nadawane przez parser IBKR — mapują 1:1 na wirtualne kategorie kafli. */
const FEE_SUBKINDS = new Set([
  'margin_interest',
  'borrow_fee',
  'market_data',
  'fx_commission',
  'sales_tax',
  'lending_income',
]);

/**
 * Fallback po opisie dla danych zaimportowanych zanim parser zaczął nadawać subkindy
 * (opisy generuje nasz mapper IBKR, więc wzorce są stabilne; market data rozpoznajemy
 * po nazwach subskrypcji giełdowych).
 */
function feeGroupFromDescription(d: string): CostVirtualCategory | null {
  if (/Odsetki od kredytu \(margin\)/i.test(d)) return 'margin_interest';
  if (/Opłata za pożyczenie akcji/i.test(d)) return 'borrow_fee';
  if (/SYEP|pożyczania akcji/i.test(d)) return 'lending_income';
  if (/Prowizja przewalutowania/i.test(d)) return 'fx_commission';
  if (/Sales Tax|Podatek VAT od opłat/i.test(d)) return 'sales_tax';
  if (/Level [I|1]|Level II|Snapshot|OPRA|Market Data|NASDAQ|NYSE|CBOT|BUNDLE/i.test(d))
    return 'market_data';
  return null;
}

function virtualCategory(c: {
  category: AdditionalCost['category'];
  subkind?: string;
  description?: string;
}): CostVirtualCategory {
  if (c.subkind && FEE_SUBKINDS.has(c.subkind)) return c.subkind as CostVirtualCategory;
  // Fallback po opisie PRZED gałęzią interest — dane zaimportowane przed wprowadzeniem
  // subkindów mają np. SYEP jako other+interest, a powinny trafić do "Pożyczanie akcji".
  if ((c.category === 'fee' || c.category === 'other') && c.description) {
    const fromDesc = feeGroupFromDescription(c.description);
    if (fromDesc) return fromDesc;
  }
  if (c.category === 'other' && c.subkind === 'interest') return 'interest';
  return c.category;
}

const COST_CATEGORY_META: Record<
  CostVirtualCategory,
  { label: string; dot: string; tooltip: string }
> = {
  fee: {
    label: 'Opłata',
    dot: 'bg-loss',
    tooltip:
      'Opłaty brokerskie i giełdowe (prowizje za wnioski, blokady na oferty skupu, exchange fees).',
  },
  commission_refund: {
    label: 'Zwrot prowizji',
    dot: 'bg-gain',
    tooltip:
      'Zwrot prowizji — broker oddaje prowizję z anulowanego/niespełnionego zlecenia. Dodatnia kwota oznacza wpływ na konto.',
  },
  trade_fee: {
    label: 'Podatek tx / swap',
    dot: 'bg-amber-500',
    tooltip:
      'Tax IFTT (włoski podatek od transakcji na akcjach/ETF) oraz rzadkie swap/rollover poza CFD. ' +
      'Swap i rollover dla CFD są wliczone bezpośrednio w prowizję transakcji (pola Transaction.swap/rollover) ' +
      'i widoczne w zakładce Transakcje oraz w szczegółach Closed trades — NIE tutaj.',
  },
  interest: {
    label: 'Odsetki',
    dot: 'bg-gain',
    tooltip:
      'Odsetki od wolnych środków na rachunku brokerskim (np. XTB Free funds interest) lub od lokaty overnight. ' +
      'Dodatni cashflow, ale nie dywidenda spółki — nie wlicza się do totalDividends. Wchodzi do salda gotówki.',
  },
  other: {
    label: 'Inne',
    dot: 'bg-muted-foreground/50',
    tooltip:
      'Niesklasyfikowane operacje (np. rights issue, różne). Wchodzą do salda gotówki, ale nie do MWR jako wpłaty.',
  },
  margin_interest: {
    label: 'Odsetki margin',
    dot: 'bg-loss',
    tooltip:
      'Odsetki od kredytu brokerskiego (margin loan) — koszt utrzymywania ujemnego salda gotówki. ' +
      'Naliczane miesięcznie per waluta debetu.',
  },
  borrow_fee: {
    label: 'Pożyczenie akcji (short)',
    dot: 'bg-loss',
    tooltip:
      'Koszt pożyczenia akcji pod krótką pozycję (stock borrow fees). Naliczany za okres utrzymywania shorta.',
  },
  market_data: {
    label: 'Dane rynkowe',
    dot: 'bg-amber-500',
    tooltip:
      'Subskrypcje danych giełdowych live (NYSE Level I, NASDAQ, OPRA, snapshoty). Opłaty miesięczne brokera.',
  },
  fx_commission: {
    label: 'Prowizje FX',
    dot: 'bg-amber-500',
    tooltip:
      'Prowizje za przewalutowania (np. IdealFX w IBKR). Same przewalutowania są w zakładce Waluty — ' +
      'tutaj tylko ich koszt.',
  },
  sales_tax: {
    label: 'VAT od opłat',
    dot: 'bg-amber-500',
    tooltip:
      'Podatek VAT naliczany od prowizji i opłat brokera. W wyciągu IBKR dostępny wyłącznie jako ' +
      'suma roczna (Cash Report), stąd jedna operacja na rok per waluta.',
  },
  lending_income: {
    label: 'Pożyczanie akcji (SYEP)',
    dot: 'bg-gain',
    tooltip:
      'Program pożyczania własnych akcji (Stock Yield Enhancement Program) — przychód za użyczenie ' +
      'papierów brokerowi (dodatni) lub powiązane opłaty (ujemne).',
  },
};

/** Grupa kosztowa do kafli: sumy per waluta + licznik operacji. */
interface CostGroup {
  cat: CostVirtualCategory;
  count: number;
  /** currency → suma kwot (ze znakiem). */
  byCurrency: Map<string, number>;
  /** Waga do sortowania/wyboru głównych kafli: suma |kwot| bez rozróżniania walut. */
  weight: number;
}

function groupCosts(costs: AdditionalCost[]): CostGroup[] {
  const groups = new Map<CostVirtualCategory, CostGroup>();
  for (const c of costs) {
    const cat = virtualCategory(c);
    let g = groups.get(cat);
    if (!g) {
      g = { cat, count: 0, byCurrency: new Map(), weight: 0 };
      groups.set(cat, g);
    }
    g.count++;
    g.byCurrency.set(c.currency, (g.byCurrency.get(c.currency) ?? 0) + c.amount);
    g.weight += Math.abs(c.amount);
  }
  return [...groups.values()].sort((a, b) => b.weight - a.weight);
}

/**
 * Cicha etykieta kategorii: kropka koloru + tekst zamiast pełnokolorowej pigułki —
 * kolor niesie znaczenie (koszt/wpływ/podatek), ale nie krzyczy z każdego wiersza.
 */
function CostCategoryBadge({ category }: { category: CostVirtualCategory }) {
  const meta = COST_CATEGORY_META[category];
  return (
    <UITooltip delayDuration={150}>
      <UITooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-help whitespace-nowrap">
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${meta.dot}`} />
          {meta.label}
        </span>
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
  // UWAGA: initializery useState odpalają się raz na mount — rodzic MUSI
  // renderować ten dialog z key={action.id}, żeby zmiana akcji zresetowała
  // formularz (inaczej ticker się nie prefilluje, a wartości qty/price/isin
  // przenoszą się między różnymi akcjami).
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
    onError: (e: Error) => errorToast('Nie udało się domknąć', e),
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
    onError: (e: Error) => errorToast('Nie udało się dodać', e),
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

// ─── MAIN PAGE ───────────────────────────────────────────────────────────────

export function CorrectionsAndCostsPage() {
  const qc = useQueryClient();
  const [resolving, setResolving] = useState<CorporateAction | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deletingCA, setDeletingCA] = useState<CorporateAction | null>(null);
  const [deletingCost, setDeletingCost] = useState<AdditionalCost | null>(null);
  const [expandedCA, toggleCA] = useToggleSet<number>();
  const [expandedCost, toggleCost] = useToggleSet<number>();
  // Filtry strony — spójne z Pozycjami zamkniętymi: rok/zakres obejmuje OBE sekcje
  // (zdarzenia korporacyjne + przepływy), kategoria tylko historię przepływów.
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [dateRange, setDateRange] = useState<string>('ALL');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

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
    onError: (e: Error) => errorToast('Nie udało się usunąć', e),
  });

  const deleteCostMut = useMutation({
    mutationFn: (id: number) => api.deleteAdditionalCost(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.additionalCosts });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.metrics });
      qc.invalidateQueries({ queryKey: QUERY_KEYS.history });
      toast.success('Usunięto operację.');
    },
    onError: (e: Error) => errorToast('Nie udało się usunąć', e),
  });

  const actions = corpData?.actions ?? [];
  // Waluta bazowa portfela. Oba endpointy zwracają tę samą wartość (detectBaseCurrency),
  // ale costsData jest bardziej stabilne (zawsze są jakieś operacje). Fallback PLN.
  const baseCurrency = costsData?.baseCurrency ?? corpData?.baseCurrency ?? 'PLN';

  const costs = costsData?.operations ?? [];

  // Lata z OBU sekcji — filtr roku obejmuje całą stronę.
  const availableYears = useMemo(() => {
    const set = new Set<number>();
    for (const a of actions) set.add(new Date(a.date).getFullYear());
    for (const c of costs) set.add(new Date(c.date).getFullYear());
    return Array.from(set).sort((a, b) => b - a);
  }, [actions, costs]);

  // Kategorie do Selecta — z całości danych (nie znikają po zawężeniu roku).
  const availableCategories = useMemo(() => {
    const set = new Set<CostVirtualCategory>();
    for (const c of costs) set.add(virtualCategory(c));
    return Array.from(set).sort();
  }, [costs]);

  const { resolved, pending } = useMemo(() => {
    const r: CorporateAction[] = [];
    const p: CorporateAction[] = [];
    for (const a of actions) {
      if (!matchesDateRange(a.date, { dateRange, customFrom, customTo })) continue;
      if (a.status === 'resolved') r.push(a);
      else p.push(a);
    }
    return { resolved: r, pending: p };
  }, [actions, dateRange, customFrom, customTo]);

  const filteredCosts = useMemo(
    () =>
      costs.filter(
        (c) =>
          matchesDateRange(c.date, { dateRange, customFrom, customTo }) &&
          (categoryFilter === 'ALL' || virtualCategory(c) === categoryFilter),
      ),
    [costs, categoryFilter, dateRange, customFrom, customTo],
  );

  // Chipy podsumowania liczone z PRZEFILTROWANYCH danych — zawężenie roku od razu
  // pokazuje sumy kosztów za ten okres (np. do rozliczenia podatkowego).
  const costGroups = useMemo(() => groupCosts(filteredCosts), [filteredCosts]);

  const activeFilterCount = (categoryFilter !== 'ALL' ? 1 : 0) + (dateRange !== 'ALL' ? 1 : 0);
  const clearFilters = () => {
    setCategoryFilter('ALL');
    setDateRange('ALL');
    setCustomFrom('');
    setCustomTo('');
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
      {/* ─── Pasek filtrów strony (wzorzec z Pozycji zamkniętych) ───
          Rok/zakres filtruje obie sekcje, kategoria tylko Pozostałe przepływy. */}
      {(actions.length > 0 || costs.length > 0) && (
        <FilterBar activeCount={activeFilterCount} onClear={clearFilters}>
          {({ inSheet }) => (
            <>
              {availableCategories.length > 1 && (
                <div className={inSheet ? 'flex flex-col gap-1.5' : undefined}>
                  {inSheet && <FilterFieldLabel>Kategoria kosztu</FilterFieldLabel>}
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className={inSheet ? 'h-9 text-xs' : 'h-7 w-[190px] text-xs'}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">Wszystkie kategorie</SelectItem>
                      {availableCategories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {COST_CATEGORY_META[c].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className={inSheet ? 'flex flex-col gap-1.5' : 'ml-auto'}>
                {inSheet && <FilterFieldLabel>Okres</FilterFieldLabel>}
                <YearRangeFilter
                  wrap={inSheet}
                  years={availableYears}
                  value={dateRange}
                  onChange={setDateRange}
                  customFrom={customFrom}
                  onCustomFromChange={setCustomFrom}
                  customTo={customTo}
                  onCustomToChange={setCustomTo}
                />
              </div>
            </>
          )}
        </FilterBar>
      )}

      {/* ─── SEKCJA GÓRNA: Zdarzenia korporacyjne ───
          Bez żadnych zdarzeń (typowe dla brokerów bez polskich CA, np. IBKR) sekcja
          zwija się do jednej linijki — pełna karta z pustym stanem przytłaczała. */}
      {actions.length === 0 ? (
        <Card>
          <CardContent className="py-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Landmark className="h-4 w-4 shrink-0" />
            <span>
              Zdarzenia korporacyjne: brak — zwroty kapitału i wezwania skupu pojawią się tu po
              imporcie historii z takimi operacjami.
            </span>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Landmark className="h-4 w-4 text-primary" />
              Zdarzenia korporacyjne
              {pending.length > 0 && (
                <Badge
                  variant="outline"
                  className="bg-amber-500/10 text-amber-500 border-amber-500/30"
                >
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  {pending.length} do domknięcia
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
                <div className="md:hidden flex flex-col gap-2 mb-3">
                  {pending.map((a) => {
                    const isExpanded = expandedCA.has(a.id);
                    return (
                      <ExpandableCard
                        key={a.id}
                        expanded={isExpanded}
                        onToggle={() => toggleCA(a.id)}
                        headerLeft={
                          <>
                            <span className="font-mono font-semibold text-sm truncate">
                              {a.ticker ?? '—'}
                            </span>
                            <SubkindBadge subkind={a.subkind} />
                          </>
                        }
                        headerRight={
                          <span className="font-mono font-semibold text-sm tabular-nums shrink-0">
                            {formatCurrency(a.amount, a.currency)}
                          </span>
                        }
                        subHeader={
                          <ExpandableCardSubRow>
                            <span className="text-muted-foreground tabular-nums">
                              {formatDate(a.date)}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {a.source}
                            </Badge>
                          </ExpandableCardSubRow>
                        }
                      >
                        <div className="text-muted-foreground">{a.description}</div>
                        <div className="flex justify-end gap-1.5 pt-1">
                          <Button
                            size="sm"
                            variant="default"
                            className="h-7 px-2 text-xs"
                            onClick={() => setResolving(a)}
                          >
                            <Briefcase className="h-3 w-3 mr-1" />
                            Domknij
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                            onClick={() => setDeletingCA(a)}
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Usuń
                          </Button>
                        </div>
                      </ExpandableCard>
                    );
                  })}
                </div>
                <div className="hidden md:block">
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
              </div>
            )}

            {/* Resolved (capital_return) */}
            <div>
              <div className="flex items-center gap-2 mb-2 text-sm font-medium text-gain">
                <Check className="h-3.5 w-3.5" />
                Zwroty kapitałowe ({resolved.length})
              </div>
              {resolved.length === 0 ? (
                <EmptyState
                  className="py-6"
                  message={
                    dateRange !== 'ALL'
                      ? 'Brak zwrotów kapitału w wybranym okresie.'
                      : 'Brak zrealizowanych zwrotów kapitału. Pojawią się tu po imporcie historii z taką operacją.'
                  }
                />
              ) : (
                <>
                  <div className="md:hidden flex flex-col gap-2">
                    {resolved.map((a) => {
                      const isExpanded = expandedCA.has(a.id);
                      const amountColor =
                        a.amount < 0 ? 'text-loss' : a.amount > 0 ? 'text-gain' : '';
                      return (
                        <ExpandableCard
                          key={a.id}
                          expanded={isExpanded}
                          onToggle={() => toggleCA(a.id)}
                          headerLeft={
                            <>
                              <span className="font-mono font-semibold text-sm truncate">
                                {a.ticker ?? '—'}
                              </span>
                              <SubkindBadge subkind={a.subkind} />
                            </>
                          }
                          headerRight={
                            <span
                              className={`font-mono font-semibold text-sm tabular-nums shrink-0 ${amountColor}`}
                            >
                              {formatCurrency(a.amount, a.currency)}
                            </span>
                          }
                          subHeader={
                            <ExpandableCardSubRow>
                              <span className="text-muted-foreground tabular-nums">
                                {formatDate(a.date)}
                              </span>
                              <Badge variant="outline" className="text-[10px]">
                                {a.source}
                              </Badge>
                            </ExpandableCardSubRow>
                          }
                        >
                          <div className="text-muted-foreground">{a.description}</div>
                          {a.source === 'manual' && (
                            <div className="flex justify-end pt-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                                onClick={() => setDeletingCA(a)}
                              >
                                <Trash2 className="h-3 w-3 mr-1" />
                                Usuń
                              </Button>
                            </div>
                          )}
                        </ExpandableCard>
                      );
                    })}
                  </div>
                  <div className="hidden md:block">
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
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

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
          {/* Ciche chipy podsumowania — liczone z danych PO filtrach (rok + kategoria),
              posortowane po wadze. Kwoty per waluta — sumowanie USD+PLN w jednej
              liczbie byłoby mylące. Filtrowanie robi pasek na górze strony. */}
          {costGroups.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {costGroups.map((g) => {
                const meta = COST_CATEGORY_META[g.cat];
                return (
                  <span
                    key={g.cat}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground"
                  >
                    {meta.label}
                    {[...g.byCurrency.entries()]
                      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                      .map(([cur, total]) => (
                        <span
                          key={cur}
                          className={`font-semibold tabular-nums ${
                            total < 0 ? 'text-loss/90' : total > 0 ? 'text-gain/90' : ''
                          }`}
                        >
                          {formatCurrency(total, cur)}
                        </span>
                      ))}
                    · {g.count}
                  </span>
                );
              })}
            </div>
          )}

          {activeFilterCount > 0 && costs.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {filteredCosts.length} z {costs.length} operacji
              </span>
              <Button size="xs" variant="ghost" onClick={clearFilters}>
                Wyczyść filtry
              </Button>
            </div>
          )}

          {/* Historia */}
          {costs.length === 0 ? (
            <EmptyState
              className="py-6"
              message="Brak operacji kosztowych. Zaimportuj historię transakcji lub dodaj ręcznie."
            />
          ) : filteredCosts.length === 0 ? (
            <EmptyState
              className="py-6"
              message="Brak operacji dla wybranych filtrów."
              action={{ label: 'Wyczyść filtry', onClick: clearFilters }}
            />
          ) : (
            <>
              <div className="md:hidden flex flex-col gap-2">
                {filteredCosts.map((c) => {
                  const isExpanded = expandedCost.has(c.id);
                  const amountColor = c.amount < 0 ? 'text-loss' : c.amount > 0 ? 'text-gain' : '';
                  const vCat = virtualCategory(c);
                  return (
                    <ExpandableCard
                      key={c.id}
                      expanded={isExpanded}
                      onToggle={() => toggleCost(c.id)}
                      headerLeft={
                        <>
                          <CostCategoryBadge category={vCat} />
                          {c.ticker && (
                            <span className="font-mono text-[11px] text-muted-foreground truncate">
                              {c.ticker}
                            </span>
                          )}
                        </>
                      }
                      headerRight={
                        <span
                          className={`flex items-center gap-1 font-mono font-semibold text-sm tabular-nums shrink-0 ${amountColor}`}
                        >
                          {formatNumber(c.amount)}
                          <CcyChip ccy={c.currency} />
                        </span>
                      }
                      subHeader={
                        <ExpandableCardSubRow>
                          <span className="text-muted-foreground tabular-nums">
                            {formatDate(c.date)}
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {c.source}
                          </Badge>
                        </ExpandableCardSubRow>
                      }
                    >
                      <div className="text-muted-foreground">{c.description}</div>
                      {c.source === 'manual' && (
                        <div className="flex justify-end pt-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                            onClick={() => setDeletingCost(c)}
                            disabled={deleteCostMut.isPending}
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Usuń
                          </Button>
                        </div>
                      )}
                    </ExpandableCard>
                  );
                })}
              </div>
              <div className="hidden md:block max-h-[600px] overflow-auto">
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
                    {filteredCosts.map((c) => (
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
            </>
          )}
        </CardContent>
      </Card>

      <ResolveDialog
        key={resolving?.id ?? 'none'}
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
