import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { SlidersHorizontal } from 'lucide-react';

/**
 * Wspólne klocki filtrowania list — jeden wygląd i zachowanie dla wszystkich
 * okien (Pozycje zamknięte, Korekty i koszty, docelowo Dywidendy/Waluty).
 *
 * Konwencja stanu zakresu dat (zgodna z liftowanym stanem w TradesPage):
 *   dateRange: 'ALL' | '<rok>' (np. '2025') | 'CUSTOM'  + customFrom/customTo (ISO yyyy-mm-dd).
 */

export interface DateRangeState {
  dateRange: string;
  customFrom: string;
  customTo: string;
}

/** Predykat daty dla aktualnego stanu filtra — do użycia w useMemo filtrującym listę. */
export function matchesDateRange(dateISO: string, s: DateRangeState): boolean {
  if (s.dateRange === 'ALL') return true;
  let from: string | undefined;
  let to: string | undefined;
  if (s.dateRange === 'CUSTOM') {
    from = s.customFrom || undefined;
    to = s.customTo || undefined;
  } else {
    from = `${s.dateRange}-01-01`;
    to = `${s.dateRange}-12-31`;
  }
  const d = dateISO.slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

interface YearRangeFilterProps {
  /** Lata dostępne w danych, malejąco; pokazujemy max 4 najnowsze. */
  years: number[];
  value: string;
  onChange: (v: string) => void;
  customFrom: string;
  onCustomFromChange: (v: string) => void;
  customTo: string;
  onCustomToChange: (v: string) => void;
  /** true = wariant do mobilnego Sheeta (zawijane przyciski, większe pola dotykowe). */
  wrap?: boolean;
}

/**
 * Segmentowany wybór okresu: Wszystko | <4 ostatnie lata> | Zakres (+ pola dat).
 * Wyciągnięte 1:1 z ClosedTradesPage — jedno źródło wyglądu dla całej aplikacji.
 */
export function YearRangeFilter({
  years,
  value,
  onChange,
  customFrom,
  onCustomFromChange,
  customTo,
  onCustomToChange,
  wrap = false,
}: YearRangeFilterProps) {
  const shownYears = years.slice(0, 4);

  if (wrap) {
    return (
      <>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant={value === 'ALL' ? 'secondary' : 'outline'}
            className="h-8 px-3 text-xs"
            onClick={() => onChange('ALL')}
          >
            Wszystko
          </Button>
          {shownYears.map((year) => (
            <Button
              key={year}
              size="sm"
              variant={value === String(year) ? 'secondary' : 'outline'}
              className="h-8 px-3 text-xs"
              onClick={() => onChange(String(year))}
            >
              {year}
            </Button>
          ))}
          <Button
            size="sm"
            variant={value === 'CUSTOM' ? 'secondary' : 'outline'}
            className="h-8 px-3 text-xs"
            onClick={() => onChange('CUSTOM')}
          >
            Zakres
          </Button>
        </div>
        {value === 'CUSTOM' && (
          <div className="flex items-center gap-2 mt-1">
            <Input
              type="date"
              value={customFrom}
              onChange={(e) => onCustomFromChange(e.target.value)}
              className="h-9 text-xs flex-1"
            />
            <span className="text-muted-foreground text-xs">—</span>
            <Input
              type="date"
              value={customTo}
              onChange={(e) => onCustomToChange(e.target.value)}
              className="h-9 text-xs flex-1"
            />
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center rounded-md border">
        <Button
          size="sm"
          variant={value === 'ALL' ? 'secondary' : 'ghost'}
          className="h-7 px-2.5 text-xs rounded-r-none"
          onClick={() => onChange('ALL')}
        >
          Wszystko
        </Button>
        {shownYears.map((year, i) => (
          <Button
            key={year}
            size="sm"
            variant={value === String(year) ? 'secondary' : 'ghost'}
            className={`h-7 px-2.5 text-xs rounded-none border-l ${i === shownYears.length - 1 && value !== 'CUSTOM' ? 'rounded-r-md' : ''}`}
            onClick={() => onChange(String(year))}
          >
            {year}
          </Button>
        ))}
        <Button
          size="sm"
          variant={value === 'CUSTOM' ? 'secondary' : 'ghost'}
          className="h-7 px-2.5 text-xs rounded-l-none border-l"
          onClick={() => onChange('CUSTOM')}
        >
          Zakres
        </Button>
      </div>

      {value === 'CUSTOM' && (
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            value={customFrom}
            onChange={(e) => onCustomFromChange(e.target.value)}
            className="h-7 text-xs w-[130px]"
          />
          <span className="text-muted-foreground text-xs">—</span>
          <Input
            type="date"
            value={customTo}
            onChange={(e) => onCustomToChange(e.target.value)}
            className="h-7 text-xs w-[130px]"
          />
        </div>
      )}
    </div>
  );
}

/** Etykieta sekcji filtra w mobilnym Sheecie (desktop nie pokazuje etykiet). */
export function FilterFieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
      {children}
    </span>
  );
}

interface FilterBarProps {
  /** Liczba aktywnych filtrów — badge na mobilnym przycisku „Filtry". */
  activeCount: number;
  /** Kontrolki filtrów; renderowane dwa razy: desktop-inline i w mobilnym Sheecie. */
  children: (ctx: { inSheet: boolean }) => ReactNode;
  /** „Wyczyść filtry" w Sheecie (desktop czyści per kontrolka / linią statusu strony). */
  onClear?: () => void;
}

/**
 * Responsywny pasek filtrów: desktop = rząd kontrolek w linii,
 * mobile = przycisk „Filtry" z licznikiem otwierający Sheet od dołu.
 * Wzorzec przeniesiony z ClosedTradesPage.
 */
export function FilterBar({ activeCount, children, onClear }: FilterBarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <>
      <div className="md:hidden flex justify-end">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 px-3 text-xs gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filtry
              {activeCount > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">
                  {activeCount}
                </span>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-xl max-h-[85vh] overflow-auto">
            <SheetHeader className="pb-2">
              <SheetTitle>Filtry</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col gap-4 px-4 pb-6">
              {children({ inSheet: true })}
              {onClear && activeCount > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-muted-foreground self-start"
                  onClick={onClear}
                >
                  Wyczyść filtry
                </Button>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <div className="hidden md:flex flex-wrap items-center gap-3">
        {children({ inSheet: false })}
      </div>
    </>
  );
}
