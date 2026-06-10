import { TableHead } from '@/components/ui/table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SortDir } from '@/hooks/useSortableData';

interface SortableTableHeadProps {
  label: string;
  active: boolean;
  dir: SortDir;
  onToggle: () => void;
  /** 'right' dla kolumn liczbowych (wyrównanie jak text-right w komórkach). */
  align?: 'left' | 'right';
  className?: string;
}

/** Klikalny nagłówek kolumny z aria-sort i wskaźnikiem kierunku. */
export function SortableTableHead({
  label,
  active,
  dir,
  onToggle,
  align = 'left',
  className,
}: SortableTableHeadProps) {
  return (
    <TableHead
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground transition-colors',
          align === 'right' && 'w-full justify-end',
        )}
      >
        {label}
        {active ? (
          dir === 'asc' ? (
            <ArrowUp className="h-3 w-3" aria-hidden />
          ) : (
            <ArrowDown className="h-3 w-3" aria-hidden />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" aria-hidden />
        )}
      </button>
    </TableHead>
  );
}
