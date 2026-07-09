import { Button } from '@/components/ui/button';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import {
  formatNumber,
  formatCurrency,
  formatQuantity,
  formatDate,
  formatPLN,
} from '@/lib/formatters';
import { ChevronDown, ChevronRight, TrendingDown } from 'lucide-react';
import type { Position } from 'shared';
import { TickerLabel } from '@/components/ui/ticker-label';

interface Props {
  position: Position;
  onSell: () => void;
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

export function PositionCardMobile({ position, onSell, isExpanded, onToggle }: Props) {
  const lots = position.buyLots || [];
  const buyDates = lots.map((l) => l.date).sort();
  const minBuyDate = buyDates[0] || '';
  const maxBuyDate = buyDates[buyDates.length - 1] || '';
  const sameBuyDate = minBuyDate.slice(0, 10) === maxBuyDate.slice(0, 10);
  const dateLabel = minBuyDate
    ? sameBuyDate
      ? formatDate(minBuyDate)
      : `${formatDate(minBuyDate)} – ${formatDate(maxBuyDate)}`
    : '—';

  const isMulti = lots.length > 1;
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
            <TickerLabel
              ticker={position.ticker}
              className="font-mono font-semibold text-sm truncate"
            />
            <CategoryBadge category={position.category} />
            {isMulti && (
              <span className="text-[10px] text-muted-foreground shrink-0">({lots.length})</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-semibold text-sm tabular-nums">
              {formatPLN(position.currentValuePln)}
            </span>
            <Button
              size="icon"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onSell();
              }}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Sprzedaj"
            >
              <TrendingDown className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] pl-5">
          <span className="text-muted-foreground tabular-nums truncate">{dateLabel}</span>
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
            label="Śr. cena"
            value={`${formatNumber(position.avgBuyPrice)} ${position.currency}`}
          />
          <Row
            label="Wartość pierwotna"
            value={`${formatNumber(costBasis)} ${position.currency}`}
          />
          <Row label="Wartość bieżąca" value={formatPLN(position.currentValuePln)} />
          <div className="flex justify-between gap-3 items-baseline">
            <span className="text-muted-foreground">P/L</span>
            <span
              className={`tabular-nums text-right font-medium ${plColor(position.profitLossPct)}`}
            >
              {formatCurrency(position.profitLoss, position.currency)}
            </span>
          </div>
          <Row label="Data zakupu" value={dateLabel} />

          {isMulti && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mt-2">
                Loty ({lots.length})
              </div>
              <div className="flex flex-col gap-1">
                {lots.map((lot, j) => (
                  <div
                    key={j}
                    className="flex items-center justify-between gap-2 text-muted-foreground"
                  >
                    <span className="font-mono tabular-nums truncate">
                      └ {formatQuantity(lot.quantity)} szt. · {formatNumber(lot.price)} ·{' '}
                      {formatDate(lot.date)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
