import { useEffect, useMemo, useState } from 'react';
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
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidateFx } from '@/lib/query-keys';
import { formatNumber } from '@/lib/formatters';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Dialog ręcznego dodawania wymiany walut. FX exchange jest parą operacji (negatywna na walucie "from"
 * + pozytywna na walucie "to"), dlatego backend nie wspiera edycji — tylko CREATE i DELETE.
 * Dla zmiany user musi usunąć i dodać nowy rekord.
 */
const CURRENCIES = ['PLN', 'USD', 'EUR', 'GBP'] as const;

interface AddFxExchangeDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AddFxExchangeDialog({ open, onClose }: AddFxExchangeDialogProps) {
  const qc = useQueryClient();

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [currencyFrom, setCurrencyFrom] = useState('PLN');
  const [currencyTo, setCurrencyTo] = useState('USD');
  const [amountFrom, setAmountFrom] = useState('');
  const [rate, setRate] = useState('');

  // Live FX rates — do pre-fill rate gdy para walut się zmienia.
  const { data: pricesData } = useQuery({
    queryKey: QUERY_KEYS.livePrices,
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });
  const fx = pricesData?.fx;

  const getLiveRate = (from: string, to: string): string => {
    if (!fx) return '';
    if (from === 'PLN' && to === 'USD' && fx.USDPLN) return fx.USDPLN.toFixed(4);
    if (from === 'PLN' && to === 'EUR' && fx.EURPLN) return fx.EURPLN.toFixed(4);
    if (from === 'PLN' && to === 'GBP' && fx.GBPPLN) return fx.GBPPLN.toFixed(4);
    if (from === 'USD' && to === 'PLN' && fx.USDPLN) return (1 / fx.USDPLN).toFixed(4);
    if (from === 'EUR' && to === 'PLN' && fx.EURPLN) return (1 / fx.EURPLN).toFixed(4);
    if (from === 'GBP' && to === 'PLN' && fx.GBPPLN) return (1 / fx.GBPPLN).toFixed(4);
    if (from === 'USD' && to === 'EUR' && fx.USDPLN && fx.EURPLN) return (fx.USDPLN / fx.EURPLN).toFixed(4);
    if (from === 'EUR' && to === 'USD' && fx.USDPLN && fx.EURPLN) return (fx.EURPLN / fx.USDPLN).toFixed(4);
    if (from === 'USD' && to === 'GBP' && fx.USDPLN && fx.GBPPLN) return (fx.USDPLN / fx.GBPPLN).toFixed(4);
    if (from === 'GBP' && to === 'USD' && fx.USDPLN && fx.GBPPLN) return (fx.GBPPLN / fx.USDPLN).toFixed(4);
    if (from === 'EUR' && to === 'GBP' && fx.EURPLN && fx.GBPPLN) return (fx.EURPLN / fx.GBPPLN).toFixed(4);
    if (from === 'GBP' && to === 'EUR' && fx.EURPLN && fx.GBPPLN) return (fx.GBPPLN / fx.EURPLN).toFixed(4);
    return '';
  };

  // Gdy dialog się otwiera lub zmienia para walut — prefiluj kurs.
  useEffect(() => {
    if (!open) return;
    setDate(today);
    setCurrencyFrom('PLN');
    setCurrencyTo('USD');
    setAmountFrom('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setRate(getLiveRate(currencyFrom, currencyTo));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currencyFrom, currencyTo, fx]);

  const handleCurrencyChange = (field: 'from' | 'to', value: string) => {
    if (field === 'from') {
      // Auto-swap gdy user wybierze tę samą walutę
      if (value === currencyTo) setCurrencyTo(currencyFrom);
      setCurrencyFrom(value);
    } else {
      if (value === currencyFrom) setCurrencyFrom(currencyTo);
      setCurrencyTo(value);
    }
  };

  const amountTo = useMemo(() => {
    const a = parseFloat(amountFrom);
    const r = parseFloat(rate);
    if (a > 0 && r > 0) return (a / r).toFixed(2);
    return null;
  }, [amountFrom, rate]);

  const createMut = useMutation({
    mutationFn: () =>
      api.createFxExchange({
        date,
        currencyFrom,
        currencyTo,
        amountFrom: parseFloat(amountFrom),
        rate: parseFloat(rate),
      }),
    onSuccess: () => {
      invalidateFx(qc);
      toast.success(`Dodano wymianę ${currencyFrom} → ${currencyTo}: ${amountFrom} @ ${rate}`);
      onClose();
    },
    onError: (e: Error) => toast.error(`Nie udało się dodać: ${e.message}`),
  });

  const valid =
    date &&
    currencyFrom !== currencyTo &&
    parseFloat(amountFrom) > 0 &&
    parseFloat(rate) > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !createMut.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dodaj wymianę walut</DialogTitle>
          <DialogDescription>
            Tworzymy parę operacji: ujemną na walucie źródłowej + dodatnią na walucie docelowej.
            FX exchange nie wchodzi do MWR/XIRR (to konwersja, nie wpłata).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Data *</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Para walut *</label>
            <div className="flex items-center gap-2">
              <Select value={currencyFrom} onValueChange={(v) => handleCurrencyChange('from', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground">→</span>
              <Select value={currencyTo} onValueChange={(v) => handleCurrencyChange('to', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Kwota ({currencyFrom}) *</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amountFrom}
                onChange={(e) => setAmountFrom(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Kurs *{fx && <span className="text-[10px] ml-1 opacity-60">(live: {getLiveRate(currencyFrom, currencyTo) || '—'})</span>}
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="0.0000"
              />
            </div>
          </div>

          {amountTo && (
            <div className="text-xs text-gain tabular-nums p-2 rounded-md bg-gain/5 border border-gain/20">
              Otrzymasz: <strong>+{formatNumber(parseFloat(amountTo))} {currencyTo}</strong>
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
