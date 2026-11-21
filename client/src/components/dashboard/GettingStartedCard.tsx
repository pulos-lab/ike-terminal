import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FileUp, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { isDemoMode } from '@/lib/demo';
import { shouldShowGettingStarted } from '@/lib/onboarding';
import { QUERY_KEYS } from '@/lib/query-keys';

const STEPS = [
  {
    title: 'Pobierz historię od brokera',
    body: 'Eksport transakcji i operacji gotówkowych z serwisu brokera (CSV, XLSX lub wyciąg HTML). Im pełniejsza historia, tym dokładniejszy wynik.',
  },
  {
    title: 'Wgraj pliki — format rozpoznamy sami',
    body: 'XTB, Bossa, mBank, ING, DEGIRO, Interactive Brokers, Trading 212 działają od ręki. Inny broker? Kreator dopasuje kolumny.',
  },
  {
    title: 'Resztę policzymy za Ciebie',
    body: 'Ceny, kursy walut, dywidendy, splity i wydzielenia spółek aktualizują się automatycznie.',
  },
];

/**
 * Karta „Pierwsze kroki” dla pustego portfela.
 *
 * Nowy użytkownik lądował na dashboardzie z pustym wykresem i jednym zdaniem
 * „Brak danych” — bez wskazania, co zrobić. Karta znika sama po pierwszej
 * transakcji lub operacji (status importu, to samo zapytanie co badge w menu).
 */
export function GettingStartedCard() {
  const navigate = useNavigate();
  const { data: status } = useQuery({
    queryKey: QUERY_KEYS.importStatus,
    queryFn: api.getImportStatus,
  });

  if (!shouldShowGettingStarted(status, isDemoMode())) return null;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Zacznij od wgrania historii transakcji</CardTitle>
        <p className="text-sm text-muted-foreground">
          Ten portfel jest jeszcze pusty. Trzy kroki dzielą Cię od wykresu wyniku i listy pozycji.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="grid gap-3 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span
                aria-hidden
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary"
              >
                {i + 1}
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{step.title}</p>
                <p className="text-xs text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => navigate('/app/import')}>
            <FileUp className="h-4 w-4" aria-hidden />
            Importuj plik od brokera
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/app/trades')}>
            <PencilLine className="h-4 w-4" aria-hidden />
            Dodaj transakcję ręcznie
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
