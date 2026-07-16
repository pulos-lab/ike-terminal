import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateTransactionResult, OrphanedSell } from 'shared';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
import { QUERY_KEYS } from '@/lib/query-keys';
import { formatDate, formatQuantity } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';

/**
 * Kupno spin-off (cena 0) domykające sierocą sprzedaż: dzień przed pierwszą
 * sprzedażą, arytmetyka w UTC na samej części datowej (firstSellDate z importu
 * bywa z czasem, a endpoint wymaga YYYY-MM-DD). Współdzielone z ImportDialog.
 */
export function createSpinoffBuy(orphan: OrphanedSell): Promise<CreateTransactionResult> {
  const buyDate = new Date(orphan.firstSellDate.slice(0, 10) + 'T00:00:00Z');
  buyDate.setUTCDate(buyDate.getUTCDate() - 1);
  return api.createTransaction({
    date: buyDate.toISOString().slice(0, 10),
    ticker: orphan.ticker,
    side: 'K',
    quantity: orphan.missingQuantity,
    price: 0,
    commission: 0,
    currency: orphan.currency,
  });
}

/**
 * Sekcja "Sprzedaże bez kupna" w hubie Importu — te same wykrycia, które import
 * pokazuje w dialogu, ale liczone na żywo z bazy: pominięcie/zamknięcie dialogu
 * niczego nie gubi, pozycja czeka tu na decyzję. "Ignoruj" jest trwałe
 * (wpis w orphaned_sell_dismissals), z możliwością przywrócenia; dodanie kupna
 * spin-off usuwa wykrycie samoczynnie. Sekcja znika, gdy nie ma nic do pokazania.
 */
export function OrphanedSellsSection() {
  const queryClient = useQueryClient();
  const [showDismissed, setShowDismissed] = useState(false);

  const { data } = useQuery({
    queryKey: QUERY_KEYS.orphanedSells,
    queryFn: api.getOrphanedSells,
  });

  const invalidate = () => {
    // Dodanie kupna zmienia pozycje/metryki/historię — czyścimy wszystko,
    // tak jak dialog importu po udanym imporcie.
    queryClient.invalidateQueries();
  };

  const addSpinoff = useMutation({
    mutationFn: createSpinoffBuy,
    onSuccess: (result, orphan) => {
      if (result.requiresConfirmation) {
        // Walor jest dzieckiem zastosowanego spin-offu — pozycja mogła już
        // powstać automatycznie; nie dodajemy kupna po cichu.
        toast.warning(result.warning.message);
        return;
      }
      toast.success(
        `Dodano kupno spin-off: ${orphan.paperName} (${formatQuantity(orphan.missingQuantity)} szt. @ 0)`,
      );
      invalidate();
    },
    onError: (err, orphan) => errorToast(`Nie udało się dodać kupna dla ${orphan.paperName}`, err),
  });

  const dismiss = useMutation({
    mutationFn: (orphan: OrphanedSell) =>
      api.dismissOrphanedSell(orphan.isin, orphan.missingQuantity),
    onSuccess: (_, orphan) => {
      toast.success(`Zignorowano ${orphan.paperName} — możesz przywrócić w tej sekcji`);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.orphanedSells });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.importStatus });
    },
    onError: (err, orphan) => errorToast(`Nie udało się zignorować ${orphan.paperName}`, err),
  });

  const restore = useMutation({
    mutationFn: (orphan: OrphanedSell) => api.restoreOrphanedSell(orphan.isin),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.orphanedSells });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.importStatus });
    },
    onError: (err, orphan) => errorToast(`Nie udało się przywrócić ${orphan.paperName}`, err),
  });

  const pending = data?.pending ?? [];
  const dismissed = data?.dismissed ?? [];
  if (pending.length === 0 && dismissed.length === 0) return null;

  const busy = addSpinoff.isPending || dismiss.isPending;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Sprzedaże bez kupna</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Papiery, dla których import znalazł sprzedaż większą niż suma kupien — najczęściej
          spin-off (akcje otrzymane bez transakcji kupna). Dodaj kupno po cenie 0 albo zignoruj,
          jeśli to zamierzone.
        </p>
      </div>

      {pending.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/5 p-3 space-y-3">
          {pending.map((o) => (
            <div key={o.isin} className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
              <div className="space-y-1.5 min-w-0">
                <div className="text-sm">
                  <span className="font-medium">{o.paperName}</span>
                  <span className="text-muted-foreground"> ({o.ticker})</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Brak kupna dla {formatQuantity(o.missingQuantity)} szt. ({o.currency}) · Pierwsza
                  sprzedaż: {formatDate(o.firstSellDate)}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => addSpinoff.mutate(o)}
                  >
                    {addSpinoff.isPending && addSpinoff.variables?.isin === o.isin ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        Dodawanie…
                      </>
                    ) : (
                      'Dodaj kupno — spin-off (cena 0)'
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => dismiss.mutate(o)}
                  >
                    Ignoruj
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {dismissed.length > 0 && (
        <div className="text-sm">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors text-xs"
            onClick={() => setShowDismissed((v) => !v)}
          >
            {showDismissed ? 'Ukryj zignorowane' : `Pokaż zignorowane (${dismissed.length})`}
          </button>
          {showDismissed && (
            <div className="mt-2 space-y-2">
              {dismissed.map((o) => (
                <div key={o.isin} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {o.paperName} ({o.ticker}) — brak kupna dla {formatQuantity(o.missingQuantity)}{' '}
                    szt.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs px-2"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(o)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Przywróć
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
