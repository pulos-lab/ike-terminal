import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatPLN,
  formatQuantity,
} from '@/lib/formatters';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

interface Position {
  ticker: string;
  paperName: string;
  isin: string;
  shares: number;
  avgBuyPrice: number;
  currentPrice: number | null;
  currentValue?: number;
  currentValuePln: number;
  profitLoss: number;
  profitLossPln?: number;
  profitLossPct: number;
  currency: string;
  weight: number;
  category?: 'stock' | 'etf' | 'cfd';
  dailyChangePct?: number;
  priceManual?: boolean;
}

interface SplitInfo {
  ratio: number;
  date: string;
}

interface Props {
  position: Position;
  baseCurrency: string;
  useNativeCcy: boolean;
  splitInfo?: SplitInfo;
  isExpanded: boolean;
  onToggle: () => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 items-baseline">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-right">{value}</span>
    </div>
  );
}

export function PortfolioPositionCardMobile({
  position,
  baseCurrency,
  useNativeCcy,
  splitInfo,
  isExpanded,
  onToggle,
}: Props) {
  const value = useNativeCcy
    ? formatCurrency(position.currentValue ?? 0, baseCurrency)
    : formatPLN(position.currentValuePln);

  const splitLabel = splitInfo
    ? splitInfo.ratio < 1
      ? `1:${Math.round(1 / splitInfo.ratio)}`
      : `${Math.round(splitInfo.ratio)}:1`
    : null;
  const isReverseSplit = splitInfo ? splitInfo.ratio < 1 : false;

  const costBasis = position.shares * position.avgBuyPrice;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div
        className="p-3 flex flex-col gap-1 cursor-pointer hover:bg-muted/40 active:bg-muted/60 transition-colors"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <span className="font-mono font-semibold text-sm truncate">{position.ticker}</span>
            <CategoryBadge category={position.category} />
            {splitInfo && splitLabel && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertTriangle
                    className="h-3.5 w-3.5 text-amber-500 shrink-0 cursor-help"
                    onClick={(e) => e.stopPropagation()}
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[260px]">
                  Spółka przeszła {isReverseSplit ? 'reverse split' : 'split'} {splitLabel} w dniu{' '}
                  {splitInfo.date}. Ilość i cena zostały automatycznie skorygowane.
                </TooltipContent>
              </Tooltip>
            )}
            {position.priceManual && (
              <span
                className="text-[10px] text-muted-foreground/70 shrink-0"
                title="Cena z ostatniej transakcji — instrument bez aktualnych notowań"
              >
                ⚠
              </span>
            )}
          </div>
          <span className="font-semibold text-sm tabular-nums shrink-0">{value}</span>
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] pl-5">
          <span className="text-muted-foreground tabular-nums truncate">
            Kurs:{' '}
            <span className="text-foreground/80">
              {position.currentPrice != null
                ? `${formatNumber(position.currentPrice)} ${position.currency}`
                : '—'}
            </span>
            {position.dailyChangePct != null && (
              <span className={`ml-1.5 ${plColor(position.dailyChangePct)}`}>
                {formatPercent(position.dailyChangePct)}
              </span>
            )}
          </span>
          <PLBadge value={position.profitLossPct} />
        </div>
      </div>

      {isExpanded && (
        <div
          className="bg-muted/20 border-t border-border px-3 py-2.5 flex flex-col gap-1 text-[11px]"
          onClick={(e) => e.stopPropagation()}
        >
          <Row label="Ilość" value={`${formatQuantity(position.shares)} szt.`} />
          <Row
            label="Śr. cena nabycia"
            value={`${formatNumber(position.avgBuyPrice)} ${position.currency}`}
          />
          <Row
            label="Wartość pierwotna"
            value={`${formatNumber(costBasis)} ${position.currency}`}
          />
          <Row label="Wartość bieżąca" value={value} />
          <Row label="Udział w portfelu" value={formatPercent(position.weight).replace('+', '')} />
          <div className="flex justify-between gap-3 items-baseline">
            <span className="text-muted-foreground">P/L</span>
            <span className={`tabular-nums text-right font-medium ${plColor(position.profitLossPct)}`}>
              {formatCurrency(position.profitLoss, position.currency)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
