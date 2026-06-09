import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Rozwijana karta mobilna — wspólny prymityw dla list na małych ekranach
 * (dywidendy, depozyty, wymiany walut, korekty i koszty). Ujednolica
 * powtarzany wzorzec: chevron + klikalny nagłówek z obsługą klawiatury
 * (role="button", Enter/Spacja) + sekcja rozwijana ze stopPropagation,
 * żeby akcje wewnątrz (Edytuj/Usuń) nie zwijały karty.
 */
interface ExpandableCardProps {
  expanded: boolean;
  onToggle: () => void;
  /** Lewa część głównego wiersza nagłówka (obok chevronu), np. ticker + badge. */
  headerLeft: ReactNode;
  /** Prawa część głównego wiersza nagłówka, np. kwota. */
  headerRight?: ReactNode;
  /** Dodatkowe wiersze nagłówka pod głównym — użyj ExpandableCardSubRow. */
  subHeader?: ReactNode;
  /** Zawartość sekcji rozwijanej. */
  children: ReactNode;
  className?: string;
  /** Dodatkowe klasy sekcji rozwijanej (np. gap-1 zamiast domyślnego gap-2). */
  expandedClassName?: string;
}

export function ExpandableCard({
  expanded,
  onToggle,
  headerLeft,
  headerRight,
  subHeader,
  children,
  className,
  expandedClassName,
}: ExpandableCardProps) {
  return (
    <div className={cn('rounded-xl border border-border bg-card overflow-hidden', className)}>
      <div
        className="p-3 flex flex-col gap-1 cursor-pointer hover:bg-muted/40 active:bg-muted/60 transition-colors"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            {headerLeft}
          </div>
          {headerRight}
        </div>
        {subHeader}
      </div>
      {expanded && (
        <div
          className={cn(
            'bg-muted/20 border-t border-border px-3 py-2.5 flex flex-col gap-2 text-[11px]',
            expandedClassName,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Dodatkowy wiersz nagłówka (pod głównym) — wcięty pod chevron (pl-5). */
export function ExpandableCardSubRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2 text-[11px] pl-5', className)}>
      {children}
    </div>
  );
}
