import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/error-toast';
import { cn } from '@/lib/utils';

interface QueryErrorStateProps {
  /** Błąd z react-query — tłumaczony tym samym słownikiem co toasty. */
  error: unknown;
  /** `refetch` zapytania, które się nie powiodło. */
  onRetry: () => void;
  /** Co się nie wczytało — np. „Nie udało się wczytać pozycji". */
  title?: string;
  /** Trwa ponowna próba — blokuje przycisk i kręci ikoną. */
  retrying?: boolean;
  className?: string;
}

/**
 * Stan błędu zapytania z akcją „Spróbuj ponownie".
 *
 * Osobny od `EmptyState` celowo: nieudane żądanie wpadało wcześniej w gałąź
 * „brak danych” i użytkownik z pełnym portfelem czytał „Zaimportuj historię
 * transakcji” przy chwilowej awarii sieci. Pokazujemy go WYŁĄCZNIE, gdy nie ma
 * żadnych danych do wyświetlenia (`isError && !data`) — przy nieudanym
 * odświeżeniu w tle stare dane są lepsze niż pusta karta.
 */
export function QueryErrorState({
  error,
  onRetry,
  title = 'Nie udało się wczytać danych',
  retrying = false,
  className,
}: QueryErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center text-center py-12 gap-3', className)}
    >
      <AlertTriangle className="h-8 w-8 text-loss/70" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{describeError(error)}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        <RefreshCw className={cn('h-3.5 w-3.5', retrying && 'animate-spin')} aria-hidden />
        Spróbuj ponownie
      </Button>
    </div>
  );
}
