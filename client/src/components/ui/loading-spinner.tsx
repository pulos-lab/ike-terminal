import { Loader2, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

interface EmptyStateProps {
  message: string;
  /** Opcjonalna ikona nad tekstem — wizualna kotwica pustego stanu. */
  icon?: LucideIcon;
  /** Opcjonalna akcja "co dalej" — np. otwarcie dialogu dodawania / importu. */
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ message, icon: Icon, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center text-center py-12 gap-3', className)}>
      {Icon && <Icon className="h-8 w-8 text-muted-foreground/50" aria-hidden />}
      <p className="text-muted-foreground">{message}</p>
      {action && (
        <Button variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
