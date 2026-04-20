import { cn } from '@/lib/utils';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  showWord?: boolean;
  className?: string;
}

const markSize = {
  sm: 'text-base',
  md: 'text-lg',
  lg: 'text-xl',
};

const wordSize = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
};

export function Logo({ size = 'md', showWord = true, className }: LogoProps) {
  return (
    <div
      className={cn(
        'inline-flex items-baseline gap-0.5 select-none tracking-tight',
        className,
      )}
    >
      <span className={cn('font-mono font-bold', markSize[size])}>
        <span className="text-primary">[</span>
        <span className="text-foreground">T</span>
        <span className="text-primary">]</span>
      </span>
      {showWord && (
        <span
          className={cn(
            'ml-1.5 font-semibold text-foreground tracking-tight',
            wordSize[size],
          )}
        >
          terminal
        </span>
      )}
    </div>
  );
}
