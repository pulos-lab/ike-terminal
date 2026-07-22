import { useMemo } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPercent, formatNumber } from '@/lib/formatters';
import {
  computeMetrics,
  pickBest,
  FALLBACK_RISK_FREE_PCT,
  type PerformanceMetrics,
  type BetterDirection,
} from '@/lib/performance-metrics';
import type { CompareSeries } from '@/lib/compare-series';
import { cn } from '@/lib/utils';

interface ChartDataPoint {
  date: string;
  portfolioValue: number;
  returnPct: number;
  twrPct: number;
  benchmarkValue: number;
  benchmarkReturnPct: number;
  benchmarkTwrPct: number;
  investedCumulative: number;
  cumulativeDepositsPln: number;
  cumulativeWithdrawalsPln: number;
}

interface Props {
  data: ChartDataPoint[];
  benchmarkLabel: string;
  showBenchmark?: boolean;
  /** Roczna stopa wolna od ryzyka w % (z /history); fallback do 5% gdy brak. */
  riskFreeRatePct?: number;
  /** Tryb porównania (dashboard): aktywny portfel pierwszy; length ≥ 2 włącza
   *  kafle wielowartościowe — wiersz per portfel w każdym kaflu. */
  compareSeries?: CompareSeries[];
}

/** Definicja kafla w trybie porównania — lustro kafli trybu pojedynczego. */
interface CompareTile {
  key: string;
  label: (benchmarkLabel: string) => string;
  tooltip?: string;
  value: (m: PerformanceMetrics) => number | null;
  format: (v: number) => string;
  /** 'none' = brak wyróżniania (beta ~1 jest neutralna, nie ma „lepiej"). */
  better: BetterDirection | 'none';
  /** Wartość barwiona gain/loss po znaku (zwroty). */
  colorized?: boolean;
  needsBenchmark?: boolean;
  showRfSubtext?: boolean;
}

const COMPARE_TILES: CompareTile[] = [
  {
    key: 'totalReturn',
    label: () => 'Stopa zwrotu',
    value: (m) => m.totalReturn,
    format: (v) => formatPercent(v),
    better: 'high',
    colorized: true,
  },
  {
    key: 'benchmarkReturn',
    label: (b) => `vs ${b || 'benchmark'}`,
    tooltip:
      'Każda wartość to osobna symulacja DCA benchmarku dla wpłat/wypłat danego portfela — dlatego mogą się różnić mimo wspólnego indeksu.',
    value: (m) => m.benchmarkReturn,
    format: (v) => formatPercent(v),
    better: 'high',
    colorized: true,
    needsBenchmark: true,
  },
  {
    key: 'cagr',
    label: () => 'CAGR',
    tooltip:
      'Skumulowana roczna stopa wzrostu. Pokazuje, o ile % rocznie rósł portfel przy założeniu równomiernego wzrostu przez cały okres.',
    value: (m) => m.cagr,
    format: (v) => formatPercent(v),
    better: 'high',
    colorized: true,
  },
  {
    key: 'volatility',
    label: () => 'Volatility',
    tooltip:
      'Zmienność — odchylenie standardowe rocznych zwrotów. Im wyższa, tym większe wahania wartości portfela i ryzyko.',
    value: (m) => m.volatility,
    format: (v) => `${v.toFixed(2)}%`,
    better: 'low',
  },
  {
    key: 'sharpe',
    label: () => 'Sharpe Ratio',
    tooltip:
      'Zwrot ponad stopę wolną od ryzyka na jednostkę zmienności. Wartość >1 dobra, >2 bardzo dobra. Stopa wolna od ryzyka z rentowności rocznych obligacji skarbowych USA (przybliżenie dla PLN).',
    value: (m) => m.sharpeRatio,
    format: (v) => formatNumber(v),
    better: 'high',
    showRfSubtext: true,
  },
  {
    key: 'sortino',
    label: () => 'Sortino Ratio',
    tooltip:
      'Jak Sharpe, ale uwzględnia wyłącznie zmienność ujemnych odchyleń (downside deviation) — dokładniej odzwierciedla realne ryzyko straty.',
    value: (m) => m.sortinoRatio,
    format: (v) => formatNumber(v),
    better: 'high',
  },
  {
    key: 'maxDrawdown',
    label: () => 'Max Drawdown',
    tooltip: 'Największe procentowe obsunięcie od szczytu (liczone na indeksie TWR).',
    // Wartość ujemna (jak wyświetlana) — dzięki temu kolor po znaku i wybór
    // najlepszego („mniej ujemne = płytsze obsunięcie") liczą to samo co widać.
    value: (m) => -m.maxDrawdown,
    format: (v) => formatPercent(v),
    better: 'high',
    colorized: true,
  },
  {
    key: 'maxDdDuration',
    label: () => 'Max DD Duration',
    tooltip: 'Najdłuższy czas przebywania poniżej wcześniejszego szczytu.',
    value: (m) => m.maxDrawdownDuration,
    format: (v) => `${v} dni`,
    better: 'low',
  },
  {
    key: 'calmar',
    label: () => 'Calmar Ratio',
    tooltip:
      'Roczny zwrot podzielony przez maksymalne obsunięcie (Max Drawdown). Mierzy zysk w stosunku do najgorszego scenariusza straty.',
    value: (m) => m.calmarRatio,
    format: (v) => formatNumber(v),
    better: 'high',
  },
  {
    key: 'bestDay',
    label: () => 'Najlepszy dzień',
    value: (m) => m.bestDay,
    format: (v) => formatPercent(v),
    better: 'high',
    colorized: true,
  },
  {
    // Mniej ujemny najgorszy dzień = lepszy, więc kierunek 'high'.
    key: 'worstDay',
    label: () => 'Najgorszy dzień',
    value: (m) => m.worstDay,
    format: (v) => formatPercent(v),
    better: 'high',
    colorized: true,
  },
  {
    key: 'winRate',
    label: () => 'Win Rate',
    tooltip: 'Odsetek dni z dodatnim zwrotem.',
    value: (m) => m.winRate,
    format: (v) => `${formatNumber(v, 1)}%`,
    better: 'high',
  },
  {
    key: 'beta',
    label: (b) => `Beta vs ${b || 'benchmark'}`,
    tooltip:
      'Wrażliwość portfela na ruchy benchmarku (regresja dziennych zwrotów TWR). Beta 1 = portfel faluje jak indeks; 1.3 = ruchy o ~30% mocniejsze w obie strony; <1 = spokojniej niż rynek.',
    value: (m) => m.beta,
    format: (v) => formatNumber(v),
    better: 'none',
    needsBenchmark: true,
  },
  {
    key: 'alpha',
    label: () => 'Alfa (rocznie)',
    tooltip:
      'Alfa Jensena — roczna nadwyżka zwrotu ponad to, co wynikałoby z samej ekspozycji na benchmark (bety). Dodatnia = dobór pozycji dodaje wartość względem pasywnego trzymania indeksu.',
    value: (m) => m.alphaAnnualPct,
    format: (v) => formatPercent(v),
    better: 'high',
    colorized: true,
    needsBenchmark: true,
    showRfSubtext: true,
  },
];

export function PerformanceStats({
  data,
  benchmarkLabel,
  showBenchmark = true,
  riskFreeRatePct,
  compareSeries,
}: Props) {
  const rfPct = riskFreeRatePct ?? FALLBACK_RISK_FREE_PCT;
  const metrics = useMemo(() => computeMetrics(data, rfPct), [data, rfPct]);
  const multi = !!compareSeries && compareSeries.length >= 2;
  const columns = useMemo(
    () =>
      (compareSeries ?? []).map((s) => ({
        portfolioId: s.portfolioId,
        name: s.name,
        color: s.color,
        metrics: computeMetrics(s.points, rfPct),
      })),
    [compareSeries, rfPct],
  );

  const rfLabel = `rf = ${rfPct.toFixed(1)}%`;

  if (multi) {
    if (!columns.some((c) => c.metrics)) return null;
    return (
      <TooltipProvider>
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {COMPARE_TILES.map((tile) => {
              const disabled = !!tile.needsBenchmark && !showBenchmark;
              const values = columns.map((c) =>
                disabled || !c.metrics ? null : tile.value(c.metrics),
              );
              const best = tile.better === 'none' ? null : pickBest(values, tile.better);
              return (
                <MultiStatTile
                  key={tile.key}
                  label={tile.label(benchmarkLabel)}
                  tooltip={tile.tooltip}
                  subtext={tile.showRfSubtext && !disabled ? rfLabel : undefined}
                  disabled={disabled}
                  rows={columns.map((c, i) => {
                    const v = values[i];
                    return {
                      color: c.color,
                      name: c.name,
                      display: v === null ? '—' : tile.format(v),
                      best: best !== null && v === best,
                      // Kolor NIGDY nie oznacza „najlepszy" — wyłącznie znak wartości
                      // (zysk/strata) i tylko dla metryk zwrotowych. Zwycięzcę
                      // pokazuje podświetlenie wiersza, żeby oba sygnały się nie zlewały,
                      // gdy np. obie wartości są dodatnie (obie zielone).
                      className: cn(
                        v === null && 'text-muted-foreground',
                        tile.colorized &&
                          v !== null &&
                          (v > 0 ? 'text-gain' : v < 0 ? 'text-loss' : ''),
                      ),
                    };
                  })}
                />
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Podświetlony wiersz = najlepsza wartość metryki wśród porównywanych portfeli. Kolor
            wartości oznacza wyłącznie zysk/stratę.
          </p>
        </div>
      </TooltipProvider>
    );
  }

  if (!metrics) {
    return null;
  }

  const returnColor = (v: number) =>
    v > 0 ? ('green' as const) : v < 0 ? ('red' as const) : ('default' as const);
  const hasBenchmark = showBenchmark && metrics.benchmarkReturn !== 0;
  const hasBetaAlpha = showBenchmark && metrics.beta !== null;

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
        <StatTile
          label="Stopa zwrotu"
          value={formatPercent(metrics.totalReturn)}
          color={returnColor(metrics.totalReturn)}
        />
        <StatTile
          label={`vs ${benchmarkLabel || 'benchmark'}`}
          value={hasBenchmark ? formatPercent(metrics.benchmarkReturn) : '—'}
          color={hasBenchmark ? returnColor(metrics.benchmarkReturn) : 'default'}
          disabled={!hasBenchmark}
        />
        <StatTile
          label="CAGR"
          value={formatPercent(metrics.cagr)}
          color={returnColor(metrics.cagr)}
          tooltip="Skumulowana roczna stopa wzrostu. Pokazuje, o ile % rocznie rósł portfel przy założeniu równomiernego wzrostu przez cały okres."
        />
        <StatTile
          label="Volatility"
          value={`${metrics.volatility.toFixed(2)}%`}
          tooltip="Zmienność — odchylenie standardowe rocznych zwrotów. Im wyższa, tym większe wahania wartości portfela i ryzyko."
        />
        <StatTile
          label="Sharpe Ratio"
          value={formatNumber(metrics.sharpeRatio)}
          subtext={rfLabel}
          tooltip="Zwrot ponad stopę wolną od ryzyka na jednostkę zmienności. Wartość >1 dobra, >2 bardzo dobra. Uwzględnia wszystkie wahania — zarówno wzrosty, jak i spadki. Stopa wolna od ryzyka z rentowności rocznych obligacji skarbowych USA (przybliżenie dla PLN)."
        />
        <StatTile
          label="Sortino Ratio"
          value={formatNumber(metrics.sortinoRatio)}
          tooltip="Miara efektywności inwestycji oparta na stopie zwrotu skorygowanej o ryzyko spadkowe (downside deviation). W odróżnieniu od wskaźnika Sharpe, uwzględnia wyłącznie zmienność ujemnych odchyleń od docelowej stopy zwrotu, dokładniej odzwierciedlając realne ryzyko straty. Wartości > 1 uznaje się za dobre, > 2 — za bardzo dobre."
        />
        <StatTile label="Max Drawdown" value={formatPercent(-metrics.maxDrawdown)} color="red" />
        <StatTile label="Max DD Duration" value={`${metrics.maxDrawdownDuration} dni`} />
        <StatTile
          label="Calmar Ratio"
          value={formatNumber(metrics.calmarRatio)}
          tooltip="Roczny zwrot podzielony przez maksymalne obsunięcie (Max Drawdown). Mierzy, ile zysku portfel generuje w stosunku do najgorszego możliwego scenariusza straty."
        />
        <StatTile label="Najlepszy dzień" value={formatPercent(metrics.bestDay)} color="green" />
        <StatTile label="Najgorszy dzień" value={formatPercent(metrics.worstDay)} color="red" />
        <StatTile label="Win Rate" value={`${formatNumber(metrics.winRate, 1)}%`} />
        <StatTile
          label={`Beta vs ${benchmarkLabel || 'benchmark'}`}
          value={hasBetaAlpha ? formatNumber(metrics.beta!) : '—'}
          disabled={!hasBetaAlpha}
          tooltip="Wrażliwość portfela na ruchy benchmarku (regresja dziennych zwrotów TWR). Beta 1 = portfel faluje jak indeks; 1.3 = ruchy o ~30% mocniejsze w obie strony; <1 = spokojniej niż rynek."
        />
        <StatTile
          label="Alfa (rocznie)"
          value={hasBetaAlpha ? formatPercent(metrics.alphaAnnualPct!) : '—'}
          color={hasBetaAlpha ? returnColor(metrics.alphaAnnualPct!) : 'default'}
          disabled={!hasBetaAlpha}
          subtext={hasBetaAlpha ? rfLabel : undefined}
          tooltip="Alfa Jensena — roczna nadwyżka zwrotu ponad to, co wynikałoby z samej ekspozycji na benchmark (bety). Dodatnia = dobór pozycji dodaje wartość względem pasywnego trzymania indeksu."
        />
      </div>
    </TooltipProvider>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  color?: 'default' | 'green' | 'red';
  tooltip?: string;
  subtext?: string;
  disabled?: boolean;
}

function StatTile({ label, value, color = 'default', tooltip, subtext, disabled }: StatTileProps) {
  const colorClass =
    color === 'green' ? 'text-gain' : color === 'red' ? 'text-loss' : 'text-foreground';

  const content = (
    <div
      className={cn(
        'rounded-xl bg-card border border-border px-3 py-2.5',
        disabled && 'opacity-50',
      )}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 flex items-center gap-1">
        {label}
        {tooltip && <Info className="h-3 w-3 text-muted-foreground/60" />}
      </p>
      <p className={cn('text-base font-bold tabular-nums tracking-tight', colorClass)}>{value}</p>
      {subtext && (
        <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{subtext}</p>
      )}
    </div>
  );

  if (!tooltip) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="max-w-[320px] text-xs leading-relaxed">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Kafel trybu porównania: jedna metryka, wiersz per portfel (kropka koloru
 *  serii + wartość). Ta sama ramka co StatTile — kafel rośnie tylko w pionie. */
function MultiStatTile({
  label,
  tooltip,
  subtext,
  disabled,
  rows,
}: {
  label: string;
  tooltip?: string;
  subtext?: string;
  disabled?: boolean;
  rows: { color: string; name: string; display: string; best?: boolean; className?: string }[];
}) {
  const content = (
    <div
      className={cn(
        'rounded-xl bg-card border border-border px-3 py-2.5',
        disabled && 'opacity-50',
      )}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 flex items-center gap-1">
        {label}
        {tooltip && <Info className="h-3 w-3 text-muted-foreground/60" />}
      </p>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <p
            key={`${r.color}-${r.name}`}
            className={cn(
              // Podświetlenie zwycięzcy: sygnał niezależny od koloru wartości
              // (kolor = zysk/strata), czytelny też gdy wszystkie są zielone.
              '-mx-1 flex items-center gap-1.5 rounded-md px-1 py-px',
              r.best && 'bg-accent ring-1 ring-border',
            )}
            title={r.best ? `${r.name} — najlepszy wynik` : r.name}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: r.color }} />
            <span
              className={cn(
                'text-sm tabular-nums tracking-tight',
                r.best ? 'font-bold' : 'font-medium',
                r.className,
              )}
            >
              {r.display}
            </span>
          </p>
        ))}
      </div>
      {subtext && (
        <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{subtext}</p>
      )}
    </div>
  );

  if (!tooltip) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="max-w-[320px] text-xs leading-relaxed">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
