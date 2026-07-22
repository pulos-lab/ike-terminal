import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical, ArrowRight, X } from 'lucide-react';
import { exitDemo } from '@/lib/demo';

/**
 * Pasek nad aplikacją w trybie demo: informacja + konwersja. Renderowany
 * w AppShell tylko gdy isDemoMode() — nie ma własnego stanu widoczności,
 * bo wyjście z demo to zmiana aktywnego portfela (exitDemo), nie "zamknięcie".
 */
export function DemoBanner() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const handleExit = () => {
    exitDemo(queryClient);
    navigate('/', { replace: true });
  };

  return (
    <div className="flex items-center justify-between gap-2 bg-amber-500/10 border-b border-amber-500/30 px-3 py-1.5 text-xs sm:text-sm">
      <div className="flex items-center gap-2 min-w-0 text-amber-600 dark:text-amber-400">
        <FlaskConical className="h-4 w-4 flex-shrink-0" />
        <span className="truncate">
          Przeglądasz <span className="font-semibold">wersję demo</span> na przykładowych danych
        </span>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={() => navigate('/login?register=1')}
          className="flex items-center gap-1 rounded-md bg-amber-500 hover:bg-amber-600 text-stone-950 font-semibold px-2.5 py-1 transition-colors"
        >
          Załóż darmowe konto
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={handleExit}
          aria-label="Wyjdź z demo"
          title="Wyjdź z demo"
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
