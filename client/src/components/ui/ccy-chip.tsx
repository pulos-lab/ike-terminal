import { cn } from '@/lib/utils';

interface Props {
  ccy: string;
  className?: string;
}

export function CcyChip({ ccy, className }: Props) {
  return (
    <span
      className={cn(
        'inline-flex px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px] font-semibold tracking-wide',
        className,
      )}
    >
      {ccy}
    </span>
  );
}
