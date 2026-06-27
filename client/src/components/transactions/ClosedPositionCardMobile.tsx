import { Button } from '@/components/ui/button';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { formatCurrency, formatDate, formatNumber, formatQuantity } from '@/lib/formatters';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import type { TradeGroup } from '@/lib/closed-trades-grouping';

interface Props {
  group: TradeGroup;
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 items-baseline">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-right">{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mt-2 first:mt-0">
      {children}
    </div>
  );
}

export function ClosedPositionCardMobile({
  group,
  isExpanded,
  onToggle,
  onDelete,
  isDeleting,
}: Props) {
  const isMulti = group.trades.length > 1;
  const isManual = group.everyManual;
  const sameBuyDate = group.minBuyDate.slice(0, 10) === group.maxBuyDate.slice(0, 10);
  const sameBuyPrice = group.minBuyPrice === group.maxBuyPrice;
  const sameSellDate = group.minSellDate.slice(0, 10) === group.sellDate.slice(0, 10);
  const sameSellPrice = group.minSellPrice === group.maxSellPrice;
  const anyShort = group.trades.some((t) => t.isShort);
  const allShort = group.trades.every((t) => t.isShort);
  const shortCount = group.trades.filter((t) => t.isShort).length;
  const category = group.trades[0]?.category;

  const buyDateLabel = sameBuyDate
    ? formatDate(group.minBuyDate)
    : `${formatDate(group.minBuyDate)} – ${formatDate(group.maxBuyDate)}`;
  const buyPriceLabel = sameBuyPrice
    ? formatNumber(group.minBuyPrice)
    : `${formatNumber(group.minBuyPrice)}–${formatNumber(group.maxBuyPrice)}`;
  const sellDateLabel = sameSellDate
    ? formatDate(group.sellDate)
    : `${formatDate(group.minSellDate)} – ${formatDate(group.sellDate)}`;
  const sellPriceLabel = sameSellPrice
    ? formatNumber(group.sellPrice)
    : `${formatNumber(group.minSellPrice)}–${formatNumber(group.maxSellPrice)}`;

  // Wartości obliczane z lotów (multi-lot ma różne ceny zakupu/sprzedaży na nogę)
  const costBasis = group.trades.reduce((s, t) => s + t.quantity * t.buyPrice, 0);
  const grossRevenue = group.trades.reduce((s, t) => s + t.quantity * t.sellPrice, 0);

  const commission = group.trades.reduce((s, t) => s + t.buyCommission + t.sellCommission, 0);
  const fees = group.trades.flatMap((t) => t.fees ?? []);

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
            <span className="font-mono font-semibold text-sm truncate">{group.ticker}</span>
            <CategoryBadge category={category} />
            {anyShort && (
              <span className="text-[10px] font-semibold bg-violet-500/15 text-violet-400 px-1 py-0.5 rounded shrink-0">
                {allShort ? 'SHORT' : `${shortCount}S`}
              </span>
            )}
            {isMulti && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                ({group.trades.length})
              </span>
            )}
          </div>
          <span
            className={`font-semibold text-sm tabular-nums shrink-0 ${plColor(group.weightedProfitLossPct)}`}
          >
            {formatCurrency(group.totalProfitLoss, group.currency)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] pl-5">
          <span className="text-muted-foreground tabular-nums truncate">
            {formatDate(group.sellDate)} · {group.avgHoldingDays}d
          </span>
          <PLBadge value={group.weightedProfitLossPct} />
        </div>
      </div>

      {isExpanded && (
        <div
          className="bg-muted/20 border-t border-border px-3 py-2.5 flex flex-col gap-1 text-[11px]"
          onClick={(e) => e.stopPropagation()}
        >
          <SectionTitle>Transakcja</SectionTitle>
          <Row label="Ilość" value={`${formatQuantity(group.totalQuantity)} szt.`} />
          <Row label="Cena kupna" value={`${buyPriceLabel} ${group.currency}`} />
          <Row label="Cena sprzedaży" value={`${sellPriceLabel} ${group.currency}`} />
          {group.totalCost > 0 && (
            <Row
              label="Prowizja"
              value={
                fees.length > 0 ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help underline decoration-dotted">
                          {formatNumber(group.totalCost)} {group.currency}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-left">
                        <div className="space-y-0.5">
                          {commission > 0 && (
                            <div className="flex justify-between gap-4">
                              <span className="text-muted-foreground">prowizja:</span>
                              <span>{formatNumber(commission)}</span>
                            </div>
                          )}
                          {fees.map((fee, i) => (
                            <div key={i} className="flex justify-between gap-4">
                              <span className="text-muted-foreground">{fee.type}:</span>
                              <span>{formatNumber(fee.amount)}</span>
                            </div>
                          ))}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  `${formatNumber(group.totalCost)} ${group.currency}`
                )
              }
            />
          )}

          <SectionTitle>Czas</SectionTitle>
          <Row label="Data kupna" value={buyDateLabel} />
          <Row label="Data sprzedaży" value={sellDateLabel} />
          <Row label="Czas posiadania" value={`${group.avgHoldingDays}d`} />

          <SectionTitle>Wartości</SectionTitle>
          <Row label="Wartość kupna" value={`${formatNumber(costBasis)} ${group.currency}`} />
          <Row
            label="Wartość sprzedaży"
            value={`${formatNumber(grossRevenue)} ${group.currency}`}
          />
          <div className="flex justify-between gap-3 items-baseline">
            <span className="text-muted-foreground">Zysk netto</span>
            <span
              className={`tabular-nums text-right font-medium ${plColor(group.weightedProfitLossPct)}`}
            >
              {formatCurrency(group.totalProfitLoss, group.currency)}
            </span>
          </div>

          {isMulti && (
            <>
              <SectionTitle>Loty ({group.trades.length})</SectionTitle>
              <div className="flex flex-col gap-1">
                {group.trades.map((trade, j) => (
                  <div
                    key={j}
                    className="flex items-center justify-between gap-2 text-muted-foreground"
                  >
                    <span className="font-mono tabular-nums truncate">
                      └ {formatQuantity(trade.quantity)} szt. · {formatNumber(trade.buyPrice)} →{' '}
                      {formatNumber(trade.sellPrice)} · {trade.holdingDays}d
                      {trade.isShort && (
                        <span className="ml-1 text-[10px] font-semibold bg-violet-500/15 text-violet-400 px-1 py-0.5 rounded">
                          S
                        </span>
                      )}
                    </span>
                    <PLBadge value={trade.profitLossPct} muted />
                  </div>
                ))}
              </div>
            </>
          )}

          {isManual && (
            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={onDelete}
                disabled={isDeleting}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Usuń
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
