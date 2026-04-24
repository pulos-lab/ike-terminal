import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { invalidateDividends } from '@/lib/query-keys';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Dialog dodawania / edycji dywidendy.
 *
 * Ten sam komponent obsługuje CREATE (bez defaultValues.id) i UPDATE (z id).
 * Field layout: grid-cols-2 dla ticker+date, jedna linia dla amount+currency.
 */
export interface DividendDialogValues {
  id?: number;
  date: string;
  ticker: string;
  amount: number;
  currency: string;
}

interface AddDividendDialogProps {
  open: boolean;
  onClose: () => void;
  defaultValues?: Partial<DividendDialogValues>;
}

const CURRENCY_OPTIONS = ['PLN', 'USD', 'EUR', 'CAD', 'GBP', 'CHF', 'NOK', 'SEK'];

export function AddDividendDialog({ open, onClose, defaultValues }: AddDividendDialogProps) {
  const qc = useQueryClient();
  const isEdit = defaultValues?.id !== undefined;

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(defaultValues?.date?.split('T')[0] ?? today);
  const [ticker, setTicker] = useState(defaultValues?.ticker ?? '');
  const [amount, setAmount] = useState(defaultValues?.amount ? String(defaultValues.amount) : '');
  const [currency, setCurrency] = useState(defaultValues?.currency ?? 'PLN');

  useEffect(() => {
    if (!open) return;
    setDate(defaultValues?.date?.split('T')[0] ?? today);
    setTicker(defaultValues?.ticker ?? '');
    setAmount(defaultValues?.amount ? String(defaultValues.amount) : '');
    setCurrency(defaultValues?.currency ?? 'PLN');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultValues?.id]);

  const createMut = useMutation({
    mutationFn: () =>
      api.createDividend({ date, ticker, amount: parseFloat(amount), currency }),
    onSuccess: () => {
      invalidateDividends(qc);
      toast.success(`Dodano dywidendę ${ticker} — ${amount} ${currency}`);
      onClose();
    },
    onError: (e: Error) => toast.error(`Nie udało się dodać: ${e.message}`),
  });

  const updateMut = useMutation({
    mutationFn: () => {
      if (!defaultValues?.id) throw new Error('Brak ID do edycji');
      return api.updateDividend(defaultValues.id, {
        date,
        ticker,
        amount: parseFloat(amount),
        currency,
      });
    },
    onSuccess: () => {
      invalidateDividends(qc);
      toast.success('Zaktualizowano dywidendę.');
      onClose();
    },
    onError: (e: Error) => toast.error(`Nie udało się zapisać: ${e.message}`),
  });

  const submitMut = isEdit ? updateMut : createMut;
  const valid = date && ticker.trim() && amount && parseFloat(amount) > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitMut.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edytuj dywidendę' : 'Dodaj dywidendę'}</DialogTitle>
          <DialogDescription>
            Ręcznie wprowadzona dywidenda. Wlicza się do sumy dywidend i MWR/TWR jako zrealizowany zwrot.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Data *</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Ticker *</label>
              <Input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                placeholder="np. AAPL"
                className="font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-[1fr_100px] gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Kwota *</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Waluta</label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitMut.isPending}>
            Anuluj
          </Button>
          <Button onClick={() => submitMut.mutate()} disabled={!valid || submitMut.isPending}>
            {submitMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isEdit ? 'Zapisz' : 'Dodaj'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
