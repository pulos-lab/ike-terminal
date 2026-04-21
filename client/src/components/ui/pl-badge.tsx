import { Badge } from '@/components/ui/badge';
import { formatPercent } from '@/lib/formatters';

/** Returns Tailwind color class for profit/loss text */
export function plColor(value: number): string {
  return value >= 0 ? 'text-gain' : 'text-loss';
}

interface PLBadgeProps {
  value: number;
  formatter?: (v: number) => string;
  /** Reduced opacity variant for expanded child rows */
  muted?: boolean;
}

export function PLBadge({ value, formatter = formatPercent, muted }: PLBadgeProps) {
  const isPositive = value >= 0;
  // Wariant `destructive` z Badge wstrzykuje `dark:bg-destructive/60`, którego
  // tailwind-merge nie usuwa razem z naszym `bg-loss/15` (różne warianty), przez
  // co w dark mode czerwony tekst lądował na intensywnie czerwonym tle. Używamy
  // neutralnego wariantu i nadpisujemy kolory w pełni własnymi klasami.
  const cls = muted
    ? isPositive
      ? 'bg-gain/10 text-gain/70'
      : 'bg-loss/15 text-loss/70'
    : isPositive
      ? 'bg-gain/10 text-gain hover:bg-gain/20'
      : 'bg-loss/15 text-loss hover:bg-loss/25';

  return (
    <Badge variant="secondary" className={`text-xs ${cls}`}>
      {formatter(value)}
    </Badge>
  );
}
