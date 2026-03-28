import { Badge } from '@/components/ui/badge';
import { formatPercent } from '@/lib/formatters';

/** Returns Tailwind color class for profit/loss text */
export function plColor(value: number): string {
  return value >= 0 ? 'text-green-500' : 'text-red-500';
}

interface PLBadgeProps {
  value: number;
  formatter?: (v: number) => string;
  /** Reduced opacity variant for expanded child rows */
  muted?: boolean;
}

export function PLBadge({ value, formatter = formatPercent, muted }: PLBadgeProps) {
  const isPositive = value >= 0;
  const cls = muted
    ? isPositive
      ? 'bg-green-500/10 text-green-500/70'
      : 'bg-red-500/15 text-red-400/70'
    : isPositive
      ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20'
      : 'bg-red-500/15 text-red-400 hover:bg-red-500/25';

  return (
    <Badge
      variant={isPositive ? 'default' : 'destructive'}
      className={`text-xs ${cls}`}
    >
      {formatter(value)}
    </Badge>
  );
}
