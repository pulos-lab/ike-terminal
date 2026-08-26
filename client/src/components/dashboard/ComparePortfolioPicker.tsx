import { GitCompare } from 'lucide-react';
import type { Portfolio } from 'shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Górny limit porównywanych portfeli (aktywny + inne) — tyle, ile slotów
 *  ma paleta serii (amber aktywnego + --chart-2..5). */
export const MAX_COMPARED = 5;

interface Props {
  portfolios: Portfolio[];
  activeId: string;
  /** Zaznaczone INNE portfele; kolejność zaznaczenia = kolory palety. */
  selectedOtherIds: string[];
  onChange: (ids: string[]) => void;
  /** Przełącznik serii „Łącznie" (portfele policzone jak jeden rachunek) —
   *  widoczny tylko przy aktywnym porównaniu. */
  showCombined: boolean;
  onShowCombinedChange: (show: boolean) => void;
  /** Powód niedostępności „Łącznie" (np. różne waluty bazowe) — ustawiony
   *  wyłącza przełącznik i pokazuje opis. */
  combinedDisabledReason?: string | null;
}

export function ComparePortfolioPicker({
  portfolios,
  activeId,
  selectedOtherIds,
  onChange,
  showCombined,
  onShowCombinedChange,
  combinedDisabledReason,
}: Props) {
  const active = portfolios.find((p) => p.id === activeId);
  const others = portfolios.filter((p) => p.id !== activeId);
  const atLimit = 1 + selectedOtherIds.length >= MAX_COMPARED;
  const comparing = selectedOtherIds.length > 0;

  function toggle(id: string, checked: boolean) {
    if (checked) {
      if (atLimit || selectedOtherIds.includes(id)) return;
      onChange([...selectedOtherIds, id]);
    } else {
      onChange(selectedOtherIds.filter((s) => s !== id));
    }
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              className={cn(
                'relative shrink-0',
                comparing ? 'text-primary' : 'text-muted-foreground',
              )}
              aria-label="Porównaj portfele"
            >
              <GitCompare className="h-4 w-4" />
              {comparing && (
                <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground">
                  {1 + selectedOtherIds.length}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent className="text-xs">Porównaj portfele</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Porównaj z aktywnym portfelem
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked disabled>
          <span className="truncate">{active?.name ?? activeId}</span>
          <span className="ml-auto pl-2 text-[11px] text-muted-foreground">(aktywny)</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {others.map((p) => {
          const checked = selectedOtherIds.includes(p.id);
          return (
            <DropdownMenuCheckboxItem
              key={p.id}
              checked={checked}
              disabled={!checked && atLimit}
              // preventDefault: menu zostaje otwarte — zaznaczanie kilku pozycji
              // bez ponownego rozwijania po każdym kliknięciu.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(c) => toggle(p.id, c === true)}
            >
              <span className="truncate">{p.name}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
        {atLimit && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
              Maksymalnie {MAX_COMPARED} portfeli naraz
            </p>
          </>
        )}
        {comparing && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={showCombined && !combinedDisabledReason}
              disabled={!!combinedDisabledReason}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(c) => onShowCombinedChange(c === true)}
            >
              <span className="truncate">Linia „Łącznie" (jak jeden rachunek)</span>
            </DropdownMenuCheckboxItem>
            {combinedDisabledReason && (
              <p className="px-2 pb-1.5 text-[11px] text-muted-foreground">
                {combinedDisabledReason}
              </p>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
