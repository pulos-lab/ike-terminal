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
import { api } from '@/lib/api-client';
import { invalidatePortfolio } from '@/lib/query-keys';
import { usePortfolio } from '@/lib/portfolio-context';
import { Loader2, TrendingDown } from 'lucide-react';
import { toast } from 'sonner';
import type { Position } from 'shared';

/**
 * Mobile-friendly modal sprzedaży otwartej pozycji. Desktop ma własny inline flow
 * w rzędzie tabeli (TradesPage) — na mobile nie ma miejsca na inline form,
 * więc pokazujemy ten sam zestaw pól w Dialogu.
 */

interface Props {
  position: Position | null;
  onClose: () => void;
}

const today = () => new Date().toISOString().slice(0, 10);

export function SellPositionDialog({ position, onClose }: Props) {
  const queryClient = useQueryClient();
  const { activeSettings } = usePortfolio();

  const [date, setDate] = useState(today);
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [commission, setCommission] = useState('0');
  const [commissionTouched, setCommissionTouched] = useState(false);

  const calcCommission = (ticker: string, qty: string, prc: string): string => {
    const q = parseFloat(qty);
    const p = parseFloat(prc);
    if (!q || !p || q <= 0 || p <= 0) return '0';
    const value = q * p;
    const isPolish = ticker.endsWith('.WA') || ticker.endsWith('.NC');
    const rate = isPolish
      ? activeSettings?.commissionPl || 0
      : activeSettings?.commissionForeign || 0;
    const min = isPolish
      ? activeSettings?.minCommissionPl || 0
      : activeSettings?.minCommissionForeign || 0;
    if (rate <= 0 && min <= 0) return '0';
    const comm = Math.max((value * rate) / 100, min);
    return (Math.round(comm * 100) / 100).toString();
  };

  // Pre-fill po otwarciu (zmiana position z null → Position)
  useEffect(() => {
    if (!position) return;
    const qty = position.shares.toString();
    const prc = position.currentPrice?.toString() || '';
    setDate(today());
    setQuantity(qty);
    setPrice(prc);
    setCommission(calcCommission(position.ticker, qty, prc));
    setCommissionTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.ticker]);

  // Auto-recalc prowizji po zmianie ceny/ilości — chyba że user ręcznie nadpisał.
  useEffect(() => {
    if (!position) return;
    if (commissionTouched) return;
    if (!quantity || !price) return;
    const next = calcCommission(position.ticker, quantity, price);
    setCommission((prev) => (prev === next ? prev : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quantity, price, commissionTouched, position?.ticker]);

  const sellMutation = useMutation({
    mutationFn: () => {
      if (!position) throw new Error('No position');
      return api.createTransaction({
        date,
        ticker: position.ticker,
        side: 'S',
        quantity: parseFloat(quantity),
        price: parseFloat(price),
        commission: parseFloat(commission) || 0,
        category: position.category,
      });
    },
    onSuccess: () => {
      invalidatePortfolio(queryClient);
      toast.success(`Sprzedano ${quantity} szt ${position?.ticker} @ ${price}`);
      onClose();
    },
    onError: (err: Error) => toast.error(`Nie udało się sprzedać: ${err.message}`),
  });

  const isValid =
    !!date &&
    !!quantity &&
    parseFloat(quantity) > 0 &&
    !!price &&
    parseFloat(price) > 0 &&
    !!position &&
    parseFloat(quantity) <= position.shares;

  const open = position !== null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !sellMutation.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
            Sprzedaż {position?.ticker}
          </DialogTitle>
          <DialogDescription>
            {position
              ? `Posiadane: ${position.shares} szt · cena bieżąca: ${
                  position.currentPrice ?? '—'
                } ${position.currency}`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Ilość *</label>
            <Input
              type="number"
              step="0.0001"
              min="0"
              max={position?.shares}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="text-right"
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
              className="text-right"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Data *</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Prowizja{' '}
              {!commissionTouched && <span className="text-[10px] opacity-60">(auto)</span>}
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
              className="text-right"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={sellMutation.isPending}>
            Anuluj
          </Button>
          <Button
            onClick={() => sellMutation.mutate()}
            disabled={!isValid || sellMutation.isPending}
          >
            {sellMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Sprzedaj
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
