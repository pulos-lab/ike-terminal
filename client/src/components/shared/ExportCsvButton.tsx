import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePortfolio } from '@/lib/portfolio-context';
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from '@/lib/csv-export';
import { cn } from '@/lib/utils';

interface ExportCsvButtonProps<T> {
  /** Wiersze DOKŁADNIE takie, jakie widzi użytkownik (po filtrach i wyszukiwaniu). */
  rows: readonly T[];
  columns: readonly CsvColumn<T>[];
  /** Pierwszy człon nazwy pliku, np. `transakcje`. */
  kind: string;
  /** Sam przycisk-ikona (ciasne nagłówki kart). */
  iconOnly?: boolean;
  className?: string;
}

/**
 * „Eksport CSV” dla tabeli. Plik powstaje w przeglądarce z już wczytanych
 * danych — bez dodatkowego żądania do serwera, więc działa też w trybie demo.
 */
export function ExportCsvButton<T>({
  rows,
  columns,
  kind,
  iconOnly = false,
  className,
}: ExportCsvButtonProps<T>) {
  const { activeName } = usePortfolio();
  const label = 'Eksport CSV';
  return (
    <Button
      type="button"
      variant="outline"
      size={iconOnly ? 'icon' : 'sm'}
      className={cn(iconOnly && 'h-8 w-8', className)}
      disabled={rows.length === 0}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      onClick={() => downloadCsv(csvFilename(kind, activeName, new Date()), toCsv(rows, columns))}
    >
      <Download className="h-4 w-4" aria-hidden />
      {!iconOnly && label}
    </Button>
  );
}
