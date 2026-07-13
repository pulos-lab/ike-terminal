import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
import { formatCurrency } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';

// Dialog ręcznego dodania operacji w "Pozostałych przepływach" — wydzielony
// z CorrectionsAndCostsPage, bo reużywa go też skrzynka "Do wyjaśnienia"
// (klasyfikacja pominiętego wiersza importu jako opłata/odsetki/inne).

/** Kategorie wybieralne w dialogu dodawania — mapują na (operation_type, subkind).
 *  "Odsetki" to UI-level split z `other` po subkind='interest'. */
export const ADD_CATEGORIES: Array<{
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

export function AddCostDialog({
  open,
  onClose,
  onSuccess,
  defaultCurrency,
  defaultValues,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  defaultCurrency: string;
  /** Prefill pól przy otwarciu — np. ze skrzynki "Do wyjaśnienia". */
  defaultValues?: { date?: string; amount?: number; currency?: string; description?: string };
  /** Wołane po udanym zapisie z id nowej operacji — resolve kwarantanny. */
  onCreated?: (id: number) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [categoryValue, setCategoryValue] = useState<string>('fee');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [description, setDescription] = useState('');

  // Reset + prefill przy otwarciu (wcześniej dialog trzymał stan między otwarciami).
  useEffect(() => {
    if (!open) return;
    setCategoryValue('fee');
    setDate(defaultValues?.date ?? today);
    setAmount(defaultValues?.amount !== undefined ? String(defaultValues.amount) : '');
    setCurrency(defaultValues?.currency ?? defaultCurrency);
    setDescription(defaultValues?.description ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    onSuccess: (data) => {
      toast.success(`Dodano operację: ${selected.label}`);
      onSuccess();
      onCreated?.(data.id);
      onClose();
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
