import { useEffect, useMemo, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldError } from '@/components/ui/field-error';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
import { invalidateDividends } from '@/lib/query-keys';
import { useFormValidation, type FieldErrors } from '@/lib/use-form-validation';
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
  description?: string;
  source?: string;
}

interface AddDividendDialogProps {
  open: boolean;
  onClose: () => void;
  defaultValues?: Partial<DividendDialogValues>;
  /** Wołane po udanym DODANIU (nie edycji) z id nowej operacji — resolve kwarantanny. */
  onCreated?: (id: number) => void;
}

const CURRENCY_OPTIONS = ['PLN', 'USD', 'EUR', 'CAD', 'GBP', 'CHF', 'NOK', 'SEK'];

export function AddDividendDialog({
  open,
  onClose,
  defaultValues,
  onCreated,
}: AddDividendDialogProps) {
  const qc = useQueryClient();
  const isEdit = defaultValues?.id !== undefined;

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(defaultValues?.date?.split('T')[0] ?? today);
  const [ticker, setTicker] = useState(defaultValues?.ticker ?? '');
  const [amount, setAmount] = useState(defaultValues?.amount ? String(defaultValues.amount) : '');
  const [currency, setCurrency] = useState(defaultValues?.currency ?? 'PLN');
  const [description, setDescription] = useState(defaultValues?.description ?? '');

  const formErrors = useMemo(() => {
    const e: FieldErrors<'date' | 'ticker' | 'amount'> = {};
    if (!date) e.date = 'Podaj datę';
    if (!ticker.trim()) e.ticker = 'Podaj ticker';
    if (!amount || parseFloat(amount) <= 0) e.amount = 'Kwota musi być większa od 0';
    return e;
  }, [date, ticker, amount]);
  const { submitGuard, fieldError, reset: resetValidation } = useFormValidation(formErrors);

  useEffect(() => {
    if (!open) return;
    setDate(defaultValues?.date?.split('T')[0] ?? today);
    setTicker(defaultValues?.ticker ?? '');
    setAmount(defaultValues?.amount ? String(defaultValues.amount) : '');
    setCurrency(defaultValues?.currency ?? 'PLN');
    setDescription(defaultValues?.description ?? '');
    resetValidation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultValues?.id]);

  const createMut = useMutation({
    mutationFn: () => api.createDividend({ date, ticker, amount: parseFloat(amount), currency }),
    onSuccess: (data) => {
      invalidateDividends(qc);
      toast.success(`Dodano dywidendę ${ticker} — ${amount} ${currency}`);
      onCreated?.(data.id);
      onClose();
    },
    onError: (e: Error) => errorToast('Nie udało się dodać', e),
  });

  const updateMut = useMutation({
    mutationFn: () => {
      if (!defaultValues?.id) throw new Error('Brak ID do edycji');
      return api.updateDividend(defaultValues.id, {
        date,
        ticker,
        amount: parseFloat(amount),
        currency,
        description: description.trim() ? description.trim() : undefined,
      });
    },
    onSuccess: () => {
      invalidateDividends(qc);
      toast.success('Zaktualizowano dywidendę.');
      onClose();
    },
    onError: (e: Error) => errorToast('Nie udało się zapisać', e),
  });

  const submitMut = isEdit ? updateMut : createMut;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitMut.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edytuj dywidendę' : 'Dodaj dywidendę'}</DialogTitle>
          <DialogDescription>
            Ręcznie wprowadzona dywidenda. Wlicza się do sumy dywidend i MWR/TWR jako zrealizowany
            zwrot.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Data *</label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-invalid={!!fieldError('date')}
              />
              <FieldError error={fieldError('date')} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Ticker *</label>
              <Input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                placeholder="np. AAPL"
                className="font-mono"
                aria-invalid={!!fieldError('ticker')}
              />
              <FieldError error={fieldError('ticker')} />
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
                aria-invalid={!!fieldError('amount')}
              />
              <FieldError error={fieldError('amount')} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Waluta</label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isEdit && (
            <div>
              <label className="text-xs text-muted-foreground">Opis</label>
              <textarea
                className="w-full min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Opis dywidendy"
              />
              {defaultValues?.source === 'auto-yahoo' && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Po zapisie zostanie oznaczone jako Ręczne.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitMut.isPending}>
            Anuluj
          </Button>
          <Button onClick={submitGuard(() => submitMut.mutate())} disabled={submitMut.isPending}>
            {submitMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isEdit ? 'Zapisz' : 'Dodaj'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
