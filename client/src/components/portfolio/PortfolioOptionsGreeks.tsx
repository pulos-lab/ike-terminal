import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OptionGreeks, GreeksNet } from 'shared';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { formatNumber } from '@/lib/formatters';
import type { OptionGroup } from './PortfolioOptionsCard';

type Mode = 'current' | 'atPurchase';

const GREEK_HELP: Record<string, string> = {
  delta:
    'Delta (Δ) — kierunkowa ekspozycja w ekwiwalencie akcji bazowych. −100 ≈ jakbyś był short 100 akcji.',
  gamma: 'Gamma (Γ) — jak szybko delta zmienia się przy ruchu kursu bazowego o 1.',
  theta:
    'Theta (Θ) — ile zyskujesz/tracisz dziennie na upływie czasu, w walucie opcji (długie opcje tracą).',
  vega: 'Vega — ile zyskujesz/tracisz na wzrost zmienności implikowanej o 1 pp, w walucie opcji.',
  rho: 'Rho — ile zyskujesz/tracisz na wzrost stopy wolnej od ryzyka o 1 pp, w walucie opcji.',
};

function signColor(v: number): string {
  return v > 0 ? 'text-green-600' : v < 0 ? 'text-red-600' : 'text-muted-foreground';
}
function fmtSigned(v: number, decimals = 0): string {
  return `${v > 0 ? '+' : ''}${formatNumber(v, decimals)}`;
}

const CCY_SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', PLN: 'zł' };
function ccySym(c: string): string {
  return CCY_SYMBOL[c] ?? c;
}

/** Krótkie wyjaśnienia greeków — widoczna legenda pod tabelą (nie tylko tooltip). */
const GREEK_LEGEND: Array<{ sym: string; name: string; text: string }> = [
  {
    sym: 'Δ',
    name: 'Delta',
    text: 'kierunkowa ekspozycja w ekwiwalencie akcji bazowych (−100 ≈ jak short 100 akcji).',
  },
  { sym: 'Γ', name: 'Gamma', text: 'jak szybko zmienia się delta przy ruchu kursu bazowego o 1.' },
  {
    sym: 'Θ',
    name: 'Theta',
    text: 'zysk/strata dziennie z upływu czasu (długie opcje tracą, wystawca zyskuje).',
  },
  { sym: 'ν', name: 'Vega', text: 'zysk/strata na wzrost zmienności implikowanej o 1 pp.' },
  { sym: 'ρ', name: 'Rho', text: 'zysk/strata na wzrost stopy wolnej od ryzyka o 1 pp.' },
  {
    sym: 'IV',
    name: 'Zmienność implikowana',
    text: 'zmienność „wyciągnięta" z ceny opcji przez model Black-Scholes.',
  },
];

/** Sumuje greeki nóg grupy dla wybranego trybu; null gdy żadna noga ich nie ma. */
function sumGroupGreeks(
  group: OptionGroup,
  byIsin: Map<
    string,
    { current: OptionGreeks | null; atPurchase: (OptionGreeks & { date: string }) | null }
  >,
  mode: Mode,
): (OptionGreeks & { dte: number }) | null {
  let any = false;
  const acc = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, iv: 0, dte: 0 };
  let ivWeight = 0;
  for (const leg of group.legs) {
    const g = byIsin.get(leg.isin)?.[mode];
    if (!g) continue;
    any = true;
    acc.delta += g.delta;
    acc.gamma += g.gamma;
    acc.theta += g.theta;
    acc.vega += g.vega;
    acc.rho += g.rho;
    // IV: ważona |delta| (pojedyncza noga → jej IV).
    const w = Math.abs(g.delta) || 1;
    acc.iv += g.iv * w;
    ivWeight += w;
  }
  if (!any) return null;
  acc.iv = ivWeight > 0 ? acc.iv / ivWeight : 0;
  return acc;
}

function NetTile({
  label,
  greek,
  value,
  unit,
}: {
  label: string;
  greek: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="text-xs text-muted-foreground cursor-help">{label}</div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{GREEK_HELP[greek]}</TooltipContent>
      </Tooltip>
      <div className="text-xl font-medium tabular-nums font-mono">{value}</div>
      <div className="text-[11px] text-muted-foreground">{unit}</div>
    </div>
  );
}

export function PortfolioOptionsGreeks({ groups }: { groups: OptionGroup[] }) {
  const [mode, setMode] = useState<Mode>('current');
  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.positionsGreeks,
    queryFn: api.getPositionsGreeks,
    staleTime: 5 * 60 * 1000,
  });

  const byIsin = useMemo(() => {
    const m = new Map<
      string,
      { current: OptionGreeks | null; atPurchase: (OptionGreeks & { date: string }) | null }
    >();
    for (const p of data?.positions ?? [])
      m.set(p.isin, { current: p.current, atPurchase: p.atPurchase });
    return m;
  }, [data]);

  if (isLoading) return <LoadingSpinner />;
  if (isError || !data) return <EmptyState message="Nie udało się policzyć greeków." />;

  const net: GreeksNet = mode === 'current' ? data.net.current : data.net.atPurchase;
  const deltaEquiv = Math.round(net.delta);
  const netCcy = ccySym(data.net.currency);
  // Waluta kolumn money w tabeli: wspólna waluta pozycji (kwotowanie w walucie opcji), null gdy mieszane.
  const posCcys = new Set((data.positions ?? []).map((p) => p.currency));
  const tableCcy = posCcys.size === 1 ? ccySym([...posCcys][0]) : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <p className="text-xs text-muted-foreground">Ekspozycja netto portfela opcji</p>
        <div className="inline-flex items-center rounded-md bg-muted p-0.5">
          {(['current', 'atPurchase'] as Mode[]).map((mo) => (
            <button
              key={mo}
              onClick={() => setMode(mo)}
              className={`px-2.5 py-0.5 rounded text-xs font-medium transition-colors ${
                mode === mo ? 'bg-background text-foreground' : 'text-muted-foreground'
              }`}
            >
              {mo === 'current' ? 'Teraz' : 'Z dnia zakupu'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <NetTile
          label="Delta (Δ)"
          greek="delta"
          value={fmtSigned(deltaEquiv)}
          unit={`jak ${deltaEquiv >= 0 ? 'long' : 'short'} ${Math.abs(deltaEquiv)} akcji`}
        />
        <NetTile
          label="Theta (Θ)"
          greek="theta"
          value={`${fmtSigned(net.theta, 0)} ${netCcy}`}
          unit="dziennie na czasie"
        />
        <NetTile
          label="Vega"
          greek="vega"
          value={`${fmtSigned(net.vega, 0)} ${netCcy}`}
          unit="na +1 pp IV"
        />
        <NetTile
          label="Rho"
          greek="rho"
          value={`${fmtSigned(net.rho, 0)} ${netCcy}`}
          unit="na +1 pp stopy"
        />
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Instrument</TableHead>
              <TableHead className="text-right">DTE</TableHead>
              {(['delta', 'gamma', 'theta', 'vega', 'rho'] as const).map((k) => (
                <TableHead key={k} className="text-right">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help">
                        {k === 'delta'
                          ? 'Δ'
                          : k === 'gamma'
                            ? 'Γ'
                            : k === 'theta'
                              ? `Θ/d${tableCcy ? ` · ${tableCcy}` : ''}`
                              : k === 'vega'
                                ? `Vega${tableCcy ? ` · ${tableCcy}` : ''}`
                                : `Rho${tableCcy ? ` · ${tableCcy}` : ''}`}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs">{GREEK_HELP[k]}</TooltipContent>
                  </Tooltip>
                </TableHead>
              ))}
              <TableHead className="text-right">IV</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => {
              const gk = sumGroupGreeks(g, byIsin, mode);
              return (
                <TableRow key={g.key}>
                  <TableCell className="font-mono font-medium whitespace-nowrap">
                    {g.label}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    <DteFromGroup group={g} />
                  </TableCell>
                  {gk ? (
                    <>
                      <TableCell
                        className={`text-right tabular-nums font-mono ${signColor(gk.delta)}`}
                      >
                        {fmtSigned(gk.delta)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-mono text-muted-foreground">
                        {formatNumber(gk.gamma, 1)}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-mono ${signColor(gk.theta)}`}
                      >
                        {fmtSigned(gk.theta, 0)}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-mono ${signColor(gk.vega)}`}
                      >
                        {fmtSigned(gk.vega, 0)}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-mono ${signColor(gk.rho)}`}
                      >
                        {fmtSigned(gk.rho, 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {Math.round(gk.iv * 100)}%
                      </TableCell>
                    </>
                  ) : (
                    <TableCell colSpan={6} className="text-right text-muted-foreground text-xs">
                      brak danych
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-1.5 text-[11px] leading-snug">
        {GREEK_LEGEND.map((g) => (
          <div key={g.name} className="flex gap-1.5">
            <dt className="font-mono font-medium text-foreground shrink-0 w-7">{g.sym}</dt>
            <dd className="text-muted-foreground">
              <span className="text-foreground">{g.name}</span> — {g.text}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
        Model Black-Scholes; IV odwrócone z ceny opcji (teraz) lub premii transakcji (z dnia
        zakupu). Stopa wolna od ryzyka z rentowności skarbowych US dopasowana do terminu. Δ/Γ =
        ekwiwalent akcji bazowych; Θ/Vega/Rho kwotowane w walucie opcji.
      </p>
    </div>
  );
}

function DteFromGroup({ group }: { group: OptionGroup }) {
  if (!group.expiry) return <>—</>;
  const dte = Math.round((Date.parse(group.expiry) - Date.now()) / 86_400_000);
  return <>{dte}</>;
}
