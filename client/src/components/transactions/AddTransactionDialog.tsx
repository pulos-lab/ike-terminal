import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TickerAutocomplete } from '@/components/shared/TickerAutocomplete';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
import { usePortfolio } from '@/lib/portfolio-context';
import { formatNumber } from '@/lib/formatters';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Dialog ręcznego dodawania transakcji (kupno / sprzedaż dowolnego tickera).
 *
 * Uwaga: sprzedaż konkretnej otwartej pozycji ma własny inline flow w `TradesPage`
 * ("Sprzedaj" button w rzędzie pozycji — context-aware, prefilled qty/price). Ten dialog
 * obsługuje generyczny add (K lub S) poza kontekstem istniejącej pozycji.
 *
 * 10 pól w układzie grid-cols-2 w `max-w-2xl`. Auto-calc prowizji po zmianie ticker/qty/price
 * (bazuje na ustawieniach portfela — commission rates per GPW/Foreign). Pre-fill kursu FX
 * z live rates (pricesData.fx).
 */
const CURRENCIES = ['auto', 'PLN', 'USD', 'EUR', 'GBP'] as const;

interface AddTransactionDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AddTransactionDialog({ open, onClose }: AddTransactionDialogProps) {
  const qc = useQueryClient();
  const { activeSettings } = usePortfolio();

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [ticker, setTicker] = useState('');
  const [side, setSide] = useState<'K' | 'S'>('K');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [commission, setCommission] = useState('0');
  const [commissionTouched, setCommissionTouched] = useState(false);
  const [currency, setCurrency] = useState<string>('auto');
  const [fxRate, setFxRate] = useState('');
  const [category, setCategory] = useState<'stock' | 'etf' | 'cfd'>('stock');

  const { data: pricesData } = useQuery({
    queryKey: QUERY_KEYS.livePrices,
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });

  // Reset state przy otwarciu dialogu
  useEffect(() => {
    if (!open) return;
    setDate(today);
    setTicker('');
    setSide('K');
    setQuantity('');
    setPrice('');
    setCommission('0');
    setCommissionTouched(false);
    setCurrency('auto');
    setFxRate('');
    setCategory('stock');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-calc prowizji na podstawie settings (chyba że user ręcznie zmienił)
  const calcCommission = (tk: string, qty: string, prc: string): string => {
    const q = parseFloat(qty);
    const p = parseFloat(prc);
    if (!q || !p || q <= 0 || p <= 0) return '0';
    const value = q * p;
    const isPolish = tk.endsWith('.WA') || tk.endsWith('.NC');
    const rate = isPolish ? (activeSettings?.commissionPl || 0) : (activeSettings?.commissionForeign || 0);
    const min = isPolish ? (activeSettings?.minCommissionPl || 0) : (activeSettings?.minCommissionForeign || 0);
    if (rate <= 0 && min <= 0) return '0';
    const comm = Math.max(value * rate / 100, min);
    return (Math.round(comm * 100) / 100).toString();
  };

  useEffect(() => {
    if (commissionTouched) return;
    if (!ticker || !quantity || !price) return;
    setCommission(calcCommission(ticker, quantity, price));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, quantity, price, commissionTouched]);

  // Pre-fill kursu FX przy zmianie waluty
  const getLiveFxRate = (cur: string): string => {
    const fx = pricesData?.fx;
    if (!fx) return '';
    if (cur === 'USD' && fx.USDPLN) return fx.USDPLN.toFixed(4);
    if (cur === 'EUR' && fx.EURPLN) return fx.EURPLN.toFixed(4);
    if (cur === 'GBP' && fx.GBPPLN) return fx.GBPPLN.toFixed(4);
    return '';
  };

  useEffect(() => {
    if (currency === 'auto' || currency === 'PLN') {
      setFxRate('');
      return;
    }
    setFxRate(getLiveFxRate(currency));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, pricesData]);

  const effectiveCurrency = currency !== 'auto' ? currency : (ticker.endsWith('.WA') || ticker.endsWith('.NC') ? 'PLN' : '');
  const showFxRate = effectiveCurrency && effectiveCurrency !== 'PLN';

  const createMut = useMutation({
    mutationFn: () =>
      api.createTransaction({
        date,
        ticker,
        side,
        quantity: parseFloat(quantity),
        price: parseFloat(price),
        commission: parseFloat(commission) || 0,
        currency: currency !== 'auto' ? currency : undefined,
        fxRate: fxRate ? parseFloat(fxRate) : undefined,
        category,
      }),
    onSuccess: () => {
      invalidatePortfolio(qc);
      toast.success(
        `Dodano ${side === 'K' ? 'kupno' : 'sprzedaż'} ${ticker}: ${quantity} @ ${price}`,
      );
      onClose();
    },
    onError: (e: Error) => toast.error(`Nie udało się dodać: ${e.message}`),
  });

  const valid =
    date &&
    ticker.trim() &&
    quantity &&
    parseFloat(quantity) > 0 &&
    price &&
    parseFloat(price) > 0;

  const plnPreview =
    showFxRate && fxRate && quantity && price
      ? parseFloat(quantity) * parseFloat(price) * parseFloat(fxRate)
      : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !createMut.isPending && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Dodaj transakcję</DialogTitle>
          <DialogDescription>
            Ręczne dodanie transakcji (kupno lub sprzedaż). Wlicza się do MWR/XIRR.
            Dla sprzedaży z otwartej pozycji użyj przycisku "Sprzedaj" w rzędzie pozycji.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Data *</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Ticker *</label>
            <TickerAutocomplete value={ticker} onChange={setTicker} placeholder="np. AAPL, CDR.WA" />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Typ *</label>
            <Select value={side} onValueChange={(v) => setSide(v as 'K' | 'S')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="K">Kupno (K)</SelectItem>
                <SelectItem value="S">Sprzedaż (S)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Kategoria</label>
            <Select value={category} onValueChange={(v) => setCategory(v as 'stock' | 'etf' | 'cfd')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="stock">Stock</SelectItem>
                <SelectItem value="etf">ETF</SelectItem>
                <SelectItem value="cfd">CFD</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Ilość *</label>
            <Input
              type="number"
              step="0.0001"
              min="0"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Cena *</label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">
              Prowizja {!commissionTouched && <span className="text-[10px] opacity-60">(auto)</span>}
            </label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={commission}
              onChange={(e) => {
                setCommission(e.target.value);
                setCommissionTouched(true);
              }}
              placeholder="0"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Waluta rozliczenia</label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map(c => (
                  <SelectItem key={c} value={c}>{c === 'auto' ? 'Auto (z tickera)' : c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {showFxRate && (
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground">
                Kurs {effectiveCurrency}/PLN *{fxRate && <span className="text-[10px] ml-1 opacity-60">(live: {getLiveFxRate(effectiveCurrency) || '—'})</span>}
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
                placeholder="0.0000"
              />
              {plnPreview && (
                <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                  Wartość w PLN: <strong>{formatNumber(plnPreview)} zł</strong>
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={createMut.isPending}>Anuluj</Button>
          <Button onClick={() => createMut.mutate()} disabled={!valid || createMut.isPending}>
            {createMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Dodaj
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
