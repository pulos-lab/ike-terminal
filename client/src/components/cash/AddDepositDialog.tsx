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
import { invalidateCashFlow } from '@/lib/query-keys';
import { formatCurrency } from '@/lib/formatters';
import { useFormValidation, type FieldErrors } from '@/lib/use-form-validation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Dialog dodawania / edycji wpłaty/wypłaty w panelu Depozyty.
 *
 * - `defaultValues.id` ustawione → tryb EDYCJI (PUT /deposits/:id), inaczej CREATE.
 * - Dla backward compat dla PUT endpointu: edycja zmienia tylko date + amount
 *   (type wymieniony w defaultValues ale immutable — user musi usunąć + dodać żeby
 *   zmienić typ; zgodnie z istniejącym backendem).
 */
export interface DepositDialogValues {
  id?: number;
  date: string;
  amount: number;
  type: 'deposit' | 'withdrawal';
}

interface AddDepositDialogProps {
  open: boolean;
  onClose: () => void;
  defaultValues?: Partial<DepositDialogValues>;
}

export function AddDepositDialog({ open, onClose, defaultValues }: AddDepositDialogProps) {
  const qc = useQueryClient();
  const isEdit = defaultValues?.id !== undefined;

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(defaultValues?.date?.split('T')[0] ?? today);
  const [amount, setAmount] = useState(
    defaultValues?.amount ? String(Math.abs(defaultValues.amount)) : '',
  );
  const [type, setType] = useState<'deposit' | 'withdrawal'>(defaultValues?.type ?? 'deposit');

  const formErrors = useMemo(() => {
    const e: FieldErrors<'date' | 'amount'> = {};
    if (!date) e.date = 'Podaj datę';
    if (!amount || parseFloat(amount) <= 0) e.amount = 'Kwota musi być większa od 0';
    return e;
  }, [date, amount]);
  const { submitGuard, fieldError, reset: resetValidation } = useFormValidation(formErrors);

  // Re-sync state gdy user wybierze inny wiersz do edycji
  useEffect(() => {
    if (!open) return;
    setDate(defaultValues?.date?.split('T')[0] ?? today);
    setAmount(defaultValues?.amount ? String(Math.abs(defaultValues.amount)) : '');
    setType(defaultValues?.type ?? 'deposit');
    resetValidation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultValues?.id]);

  const createMut = useMutation({
    mutationFn: () => api.createDeposit({ date, amount: parseFloat(amount) }, type),
    onSuccess: () => {
      invalidateCashFlow(qc);
      toast.success(
        `Dodano ${type === 'deposit' ? 'wpłatę' : 'wypłatę'}: ${formatCurrency(parseFloat(amount), 'PLN')}`,
      );
      onClose();
    },
    onError: (e: Error) => errorToast('Nie udało się dodać', e),
  });

  const updateMut = useMutation({
    mutationFn: () => {
      if (!defaultValues?.id) throw new Error('Brak ID do edycji');
      return api.updateDeposit(defaultValues.id, { date, amount: parseFloat(amount) });
    },
    onSuccess: () => {
      invalidateCashFlow(qc);
      toast.success('Zaktualizowano operację.');
      onClose();
    },
    onError: (e: Error) => errorToast('Nie udało się zapisać', e),
  });

  const submitMut = isEdit ? updateMut : createMut;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitMut.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edytuj operację' : 'Dodaj wpłatę / wypłatę'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Zmień datę lub kwotę. Typ (wpłata/wypłata) jest niezmienny — żeby go zmienić usuń i dodaj nowy rekord.'
              : 'Operacja zostanie dodana jako ręczna (source="manual"). Wlicza się do MWR/XIRR jako wpłata lub wypłata.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Typ *</label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as 'deposit' | 'withdrawal')}
              disabled={isEdit}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deposit">Wpłata</SelectItem>
                <SelectItem value="withdrawal">Wypłata</SelectItem>
              </SelectContent>
            </Select>
          </div>

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
              <label className="text-xs text-muted-foreground">Kwota (PLN) *</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="np. 10000"
                aria-invalid={!!fieldError('amount')}
              />
              <FieldError error={fieldError('amount')} />
            </div>
          </div>
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
