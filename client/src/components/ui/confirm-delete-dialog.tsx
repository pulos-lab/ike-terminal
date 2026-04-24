import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

/**
 * Wspólny modal potwierdzenia usunięcia — zastępuje `window.confirm` we wszystkich panelach.
 *
 * Używany przez: Dywidendy, Waluty, Depozyty, Korekty i koszty, Transakcje.
 * Zgodnie z decyzją projektową (plan unifikacji UI): jeden wzorzec dla wszystkich delete flow.
 *
 * Klawiaturowo:
 *  - Esc → zamyka (Shadcn default)
 *  - Enter na przycisku Usuń → potwierdza (default button ma focus-ring)
 *
 * Wzorzec treści description: konkretny rekord w zdaniu ("Usunąć dywidendę LPP 120,50 PLN
 * z 2024-06-14?") — user widzi co skasuje bez cofania oka do tabeli.
 */
export interface ConfirmDeleteDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  /** Default true — czerwony przycisk "Usuń". false → żółty default (np. soft-delete). */
  destructive?: boolean;
}

export function ConfirmDeleteDialog({
  open,
  onClose,
  onConfirm,
  title = 'Potwierdź usunięcie',
  description,
  confirmLabel = 'Usuń',
  cancelLabel = 'Anuluj',
  loading = false,
  destructive = true,
}: ConfirmDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !loading && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={loading}
            autoFocus
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
