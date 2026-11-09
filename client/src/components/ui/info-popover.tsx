import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

interface InfoPopoverProps {
  /** Element, który otwiera podpowiedź — renderowany wewnątrz przycisku. */
  trigger: React.ReactNode;
  /** Treść podpowiedzi. */
  children: React.ReactNode;
  /** Nazwa dla czytników ekranu, np. „Wpływ walut — szczegóły”. */
  label: string;
  triggerClassName?: string;
  contentClassName?: string;
}

/** Zwłoka przed zamknięciem po zjechaniu myszą — czas na przejście z przycisku na treść. */
const HOVER_CLOSE_DELAY_MS = 150;

/**
 * Podpowiedź z TREŚCIĄ (nie ozdobnik): otwiera się najechaniem myszą, a także
 * dotknięciem, kliknięciem i z klawiatury.
 *
 * `Tooltip` reaguje wyłącznie na hover/focus, więc na telefonie i tablecie
 * jego zawartość była nieosiągalna — a w pasku metryk siedzi tam cała
 * interpretacja wpływu walut i dźwigni. Wygląd celowo taki sam jak
 * `TooltipContent` (odwrócone kolory), żeby treść pisana pod tooltip nie
 * wymagała zmian.
 *
 * Mysz: najechanie otwiera, zjechanie zamyka; kliknięcie „przypina” (zamyka
 * klik poza lub Escape). Dotyk: tapnięcie przełącza.
 */
export function InfoPopover({
  trigger,
  children,
  label,
  triggerClassName,
  contentClassName,
}: InfoPopoverProps) {
  const [open, setOpen] = React.useState(false);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Otwarte hoverem (a nie kliknięciem) — tylko takie zamyka zjechanie myszą.
  const openedByHover = React.useRef(false);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  React.useEffect(() => cancelClose, []);

  const onPointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    cancelClose();
    if (!open) {
      openedByHover.current = true;
      setOpen(true);
    }
  };
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || !openedByHover.current) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        cancelClose();
        if (!next) openedByHover.current = false;
        setOpen(next);
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'cursor-help rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
            triggerClassName,
          )}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onClick={(e) => {
            // Już otwarte hoverem → kliknięcie przypina zamiast zamykać
            // (domyślne przełączenie Radixa zamknęłoby to, co mysz właśnie otworzyła).
            if (open && openedByHover.current) {
              openedByHover.current = false;
              e.preventDefault();
            }
          }}
        >
          {trigger}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-slot="info-popover-content"
          sideOffset={6}
          collisionPadding={8}
          // Fokus zostaje na przycisku — podpowiedź nie jest dialogiem.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          className={cn(
            'bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 z-50 max-h-(--radix-popover-content-available-height) w-fit max-w-[min(24rem,calc(100vw-1rem))] overflow-y-auto origin-(--radix-popover-content-transform-origin) rounded-md px-3 py-2 text-xs whitespace-normal outline-none',
            contentClassName,
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
