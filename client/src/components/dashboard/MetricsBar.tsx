import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { plColor } from '@/components/ui/pl-badge';
import { formatCurrency, formatPercent, formatPLN } from '@/lib/formatters';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TrendingUp, TrendingDown, DollarSign, Target, ArrowLeftRight } from 'lucide-react';

export function MetricsBar() {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.metrics,
    queryFn: api.getMetrics,
  });

  if (!data) return (
    <div className="hidden md:flex border-b px-4 md:px-6 py-3 gap-6 text-sm animate-pulse">
      <div className="h-4 w-32 bg-muted rounded" />
      <div className="h-4 w-32 bg-muted rounded" />
      <div className="h-4 w-24 bg-muted rounded" />
    </div>
  );

  // Waluta portfela — PLN dla polskich/mixed, USD/EUR dla XTB single-currency.
  const ccy: string = data.baseCurrency || 'PLN';
  const fmt = (v: number) => formatCurrency(v, ccy);

  return (
    <div className="hidden md:flex border-b px-4 md:px-6 py-3 flex-wrap items-center gap-x-8 gap-y-1 text-sm">
      <div className="flex items-center gap-2">
        <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Wartość
        </span>
        <span className="font-semibold tabular-nums">{fmt(data.currentValue)}</span>
      </div>
      <div className="flex items-center gap-2">
        <Target className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Wpłaty
        </span>
        <span className="font-medium tabular-nums">{fmt(data.totalInvested)}</span>
      </div>
      <div className="flex items-center gap-2">
        {data.totalReturn >= 0 ? (
          <TrendingUp className="h-3.5 w-3.5 text-gain" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 text-loss" />
        )}
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Zysk
        </span>
        <span className={`font-semibold tabular-nums ${plColor(data.totalReturn)}`}>
          {fmt(data.totalReturn)} ({formatPercent(data.totalReturnPct)})
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          XIRR
        </span>
        <span className={`font-semibold tabular-nums ${plColor(data.xirr)}`}>
          {formatPercent(data.xirr)}
        </span>
      </div>
      {data.fxImpact && (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 cursor-help">
                <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Wpływ walut
                </span>
                <span className={`font-semibold tabular-nums ${plColor(data.fxImpact.fxImpactPct)}`}>
                  {formatPercent(data.fxImpact.fxImpactPct)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              <FxImpactTooltipBody fxImpact={data.fxImpact} />
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

interface FxImpactCurrencyEntry {
  currency: string;
  exposureNative: number;
  exposurePln: number;
  avgPlnPerCurrency: number;
  todayPlnPerCurrency: number;
  impactPln: number;
  impactPct: number;
  totalAcquiredNative: number;
}

interface FxImpactData {
  fxImpactPct: number;
  fxImpactPln: number;
  breakdown: FxImpactCurrencyEntry[];
}

function FxImpactTooltipBody({ fxImpact }: { fxImpact: FxImpactData }) {
  const positive = fxImpact.fxImpactPct >= 0;
  const absPct = Math.abs(fxImpact.fxImpactPct);
  const absPln = Math.abs(fxImpact.fxImpactPln);
  const isMulti = fxImpact.breakdown.length > 1;
  const singleCurrency = !isMulti ? fxImpact.breakdown[0].currency : null;

  const headline = isMulti
    ? `Wpływ walut (agregat): ${formatPercent(fxImpact.fxImpactPct)}`
    : `Wpływ walut (${singleCurrency}): ${formatPercent(fxImpact.fxImpactPct)}`;

  const interpretation = positive
    ? `Od czasu wpłat PLN osłabł w stosunku do walut obcych w portfelu. Gdybyś dziś sprzedał cały portfel i przewalutował na PLN, dostałbyś ~${formatPLN(absPln)} więcej (+${absPct.toFixed(1)}%) niż gdybyś zrobił to przy średnich kursach zakupu.`
    : `Od czasu wpłat PLN wzmocnił się w stosunku do walut obcych w portfelu. Gdybyś dziś sprzedał cały portfel i przewalutował na PLN, dostałbyś ~${formatPLN(absPln)} mniej (−${absPct.toFixed(1)}%) niż gdybyś zrobił to przy średnich kursach zakupu.`;

  return (
    <div className="text-xs space-y-2">
      <p className="font-semibold">{headline}</p>
      <p>{interpretation}</p>
      <div className="pt-1 border-t border-border">
        <p className="font-medium mb-1">Rozbicie per waluta:</p>
        <ul className="space-y-1.5">
          {fxImpact.breakdown.map((e) => (
            <li key={e.currency} className="text-muted-foreground">
              <div className="font-medium text-foreground">
                {e.currency}: {formatPercent(e.impactPct)} ({formatPLN(e.impactPln)})
              </div>
              <div className="text-[10px] pl-2">
                • Ekspozycja: {e.exposureNative.toFixed(2)} {e.currency} ({formatPLN(e.exposurePln)})
              </div>
              <div className="text-[10px] pl-2">
                • Średni kurs zakupu: {e.avgPlnPerCurrency.toFixed(3)} → dziś: {e.todayPlnPerCurrency.toFixed(3)}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground text-[10px] pt-1 border-t border-border">
        Metryka pokazuje zysk/stratę wynikającą wyłącznie ze zmian kursu walut
        między datami Twoich wpłat (lub wymian FX) a dniem dzisiejszym. Nie
        uwzględnia zwrotu z rynku.
      </p>
    </div>
  );
}
