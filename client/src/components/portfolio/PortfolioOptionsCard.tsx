import { Fragment, useMemo, useState } from 'react';
import type { Position } from 'shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { CcyChip } from '@/components/ui/ccy-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { formatCurrency, formatNumber, formatPLN, formatQuantity } from '@/lib/formatters';
import { useToggleSet } from '@/hooks/useToggleSet';
import { PortfolioOptionsGreeks } from './PortfolioOptionsGreeks';

/**
 * Karta „Opcje" w zakładce Portfel — wydzielona sekcja dla pozycji category='option'.
 * Ujemna ilość = pozycja krótka (wystawiona opcja), ujemna wartość = zobowiązanie odkupu.
 *
 * Grupowanie: nogi na tym samym instrumencie bazowym i tej samej dacie wygaśnięcia są
 * pokazywane jako jeden wiersz (np. spread pionowy) z wartością/P&L NETTO, rozwijany do
 * poszczególnych nóg — wzorzec grupowania lotów z zakładki Transakcje. Grupujemy po
 * BIEŻĄCYCH otwartych nogach (nie po zleceniu otwarcia): domknięcie jednej nogi spreadu
 * zostawia pojedynczą pozycję, która przestaje być spreadem. Grupowanie jest czysto
 * prezentacyjne — nie dotyka wyceny ani P/L (te liczy silnik per noga).
 */

export interface OptionGroup {
  key: string;
  underlying: string;
  expiry: string;
  legs: Position[];
  /** Etykieta instrumentu: "DECK 90/100 PUT" (spread) lub "DECK" (pojedyncza / złożona). */
  label: string;
  /** Podpis rodzaju: "spread pionowy" / "N nóg"; null dla pojedynczej nogi. */
  kindLabel: string | null;
  currency: string;
  netValuePln: number;
  netProfitLoss: number;
  netProfitLossPct: number;
  expiryPassed: boolean;
}

/** Strike bez zbędnych zer: 90 → „90", 5.6 → „5,6". */
function fmtStrike(n: number): string {
  return n.toLocaleString('pl-PL', { maximumFractionDigits: 3 });
}

/** Polska odmiana: 2-4 „nogi", 5+ „nóg". */
function legWord(n: number): string {
  return `${n} ${n >= 5 ? 'nóg' : 'nogi'}`;
}

function daysToExpiry(expiry: string): number {
  const today = new Date().toISOString().slice(0, 10);
  return Math.round(
    (new Date(`${expiry}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

/** "DKNG 60 PUT" z optionMeta; fallback: paperName (symbol IBKR jest czytelny). */
function legLabel(pos: Position): string {
  const meta = pos.optionMeta;
  if (!meta) return pos.paperName;
  return `${meta.underlying} ${fmtStrike(meta.strike)} ${meta.optionType === 'C' ? 'CALL' : 'PUT'}`;
}

export function buildGroups(positions: Position[]): OptionGroup[] {
  const buckets = new Map<string, Position[]>();
  for (const pos of positions) {
    const meta = pos.optionMeta;
    const key = meta ? `${meta.underlying}|${meta.expiry}` : `raw|${pos.isin}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(pos);
  }

  // W jeden wiersz scalamy tylko RZECZYWISTE struktury spreadu: ten sam underlying+expiry
  // z nogą długą ORAZ krótką (bull call spread, iron condor, butterfly...). Dwie niezależne
  // długie pozycje na tym samym underlying to nie strategia — zostają osobnymi wierszami.
  const map = new Map<string, Position[]>();
  for (const [key, legs] of buckets) {
    const hasLong = legs.some((l) => l.shares > 0);
    const hasShort = legs.some((l) => l.shares < 0);
    if (legs.length > 1 && hasLong && hasShort) {
      map.set(key, legs);
    } else {
      legs.forEach((leg) => map.set(`${key}|${leg.isin}`, [leg]));
    }
  }

  const groups: OptionGroup[] = [];
  for (const [key, legs] of map) {
    const meta0 = legs[0].optionMeta;
    const underlying = meta0?.underlying ?? legs[0].ticker;
    const expiry = meta0?.expiry ?? '';
    const currency = legs[0].currency;
    const netValuePln = legs.reduce((s, p) => s + p.currentValuePln, 0);
    const netProfitLoss = legs.reduce((s, p) => s + p.profitLoss, 0);
    // costBasisNative per noga = currentValue − profitLoss; mianownik = |suma| (dla shortów ujemna).
    const netCostBasis = legs.reduce((s, p) => s + (p.currentValue - p.profitLoss), 0);
    const netProfitLossPct =
      Math.abs(netCostBasis) > 0 ? (netProfitLoss / Math.abs(netCostBasis)) * 100 : 0;

    // Spread pionowy: 2 nogi, jedna long + jedna short, ten sam typ (obie C albo obie P).
    const isVertical =
      legs.length === 2 &&
      legs.every((l) => l.optionMeta) &&
      legs.some((l) => l.shares > 0) &&
      legs.some((l) => l.shares < 0) &&
      legs[0].optionMeta!.optionType === legs[1].optionMeta!.optionType;

    let label: string;
    let kindLabel: string | null;
    if (legs.length === 1) {
      label = legLabel(legs[0]);
      kindLabel = null;
    } else if (isVertical) {
      const strikes = legs.map((l) => l.optionMeta!.strike).sort((a, b) => a - b);
      const right = legs[0].optionMeta!.optionType === 'C' ? 'CALL' : 'PUT';
      label = `${underlying} ${fmtStrike(strikes[0])}/${fmtStrike(strikes[1])} ${right}`;
      kindLabel = 'spread pionowy';
    } else {
      label = underlying;
      kindLabel = legWord(legs.length);
    }

    groups.push({
      key,
      underlying,
      expiry,
      legs: [...legs].sort((a, b) => (a.optionMeta?.strike ?? 0) - (b.optionMeta?.strike ?? 0)),
      label,
      kindLabel,
      currency,
      netValuePln,
      netProfitLoss,
      netProfitLossPct,
      expiryPassed: legs.some((l) => l.expiryPassed),
    });
  }
  // Sort malejąco po |wartości| — najistotniejsze grupy na górze.
  return groups.sort((a, b) => Math.abs(b.netValuePln) - Math.abs(a.netValuePln));
}

/** Badge DTE z kolorem ostrzegawczym; null gdy brak daty. */
function DteCell({ expiry }: { expiry: string }) {
  if (!expiry) return <>—</>;
  const dte = daysToExpiry(expiry);
  if (dte < 0)
    return (
      <Badge variant="outline" className="text-red-600 border-red-300">
        po terminie
      </Badge>
    );
  if (dte <= 7)
    return (
      <Badge variant="outline" className="text-amber-600 border-amber-300">
        {dte} dni
      </Badge>
    );
  return <>{dte} dni</>;
}

// Safety-net: od wprowadzenia auto-domknięcia opcji po terminie (silnik zamyka wygasłe
// pozycje po wartości wewnętrznej) `expiryPassed` na OTWARTEJ pozycji jest teraz RZADKI —
// głównie gdy brak metadanych kontraktu (expiry). Ostrzeżenie zostaje jako sygnał tych
// przypadków brzegowych; nie usuwamy.
const ExpiryWarning = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <AlertTriangle className="h-4 w-4 text-amber-500 inline ml-1 cursor-help" />
    </TooltipTrigger>
    <TooltipContent side="right" className="max-w-[280px]">
      Opcja po dacie wygaśnięcia, a pozycja wciąż otwarta — prawdopodobnie brakuje metadanych
      kontraktu (data wygaśnięcia) albo wiersza wygaśnięcia/wykonania. Zaimportuj nowszy Activity
      Statement albo dodaj transakcję zamykającą ręcznie.
    </TooltipContent>
  </Tooltip>
);

/** Wiersz pojedynczej nogi — używany dla grup 1-nogowych (indent=false) i po rozwinięciu (indent). */
function LegRow({ pos, indent }: { pos: Position; indent?: boolean }) {
  const isShort = pos.shares < 0;
  return (
    <TableRow className={indent ? 'bg-muted/30' : undefined}>
      <TableCell
        className={`font-mono font-medium whitespace-nowrap ${indent ? 'pl-9 text-sm' : ''}`}
      >
        {indent && <span className="text-muted-foreground mr-1">└</span>}
        {legLabel(pos)}
        {isShort && (
          <Badge variant="outline" className="ml-2 text-red-600 border-red-300">
            SHORT
          </Badge>
        )}
        {pos.expiryPassed && <ExpiryWarning />}
      </TableCell>
      <TableCell className="text-muted-foreground whitespace-nowrap">
        {pos.optionMeta?.expiry ?? '—'}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <DteCell expiry={pos.optionMeta?.expiry ?? ''} />
      </TableCell>
      <TableCell className={`text-right tabular-nums ${isShort ? 'text-red-600 font-medium' : ''}`}>
        {formatQuantity(pos.shares)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatNumber(pos.avgBuyPrice)}</TableCell>
      <TableCell className="text-right">
        <span className="tabular-nums">
          {pos.currentPrice ? formatNumber(pos.currentPrice) : '—'}
        </span>
        <CcyChip ccy={pos.currency} className="ml-1.5" />
        {pos.priceManual && (
          <span
            className="ml-1 text-[10px] text-muted-foreground/60"
            title="Cena z ostatniej transakcji — kontrakt bez aktualnych notowań (np. Eurex)"
          >
            ⚠
          </span>
        )}
      </TableCell>
      <TableCell
        className={`text-right font-medium tabular-nums ${pos.currentValuePln < 0 ? 'text-red-600' : ''}`}
      >
        {formatPLN(pos.currentValuePln)}
      </TableCell>
      <TableCell className={`text-right font-medium ${plColor(pos.profitLossPct)}`}>
        {formatCurrency(pos.profitLoss, pos.currency)}
      </TableCell>
      <TableCell className="text-right">
        <PLBadge value={pos.profitLossPct} />
      </TableCell>
    </TableRow>
  );
}

export function PortfolioOptionsCard({
  positions,
  totalValuePln,
}: {
  positions: Position[];
  totalValuePln: number;
}) {
  const groups = useMemo(() => buildGroups(positions), [positions]);
  const [expanded, toggle] = useToggleSet<string>();
  const [tab, setTab] = useState<'positions' | 'greeks'>('positions');

  if (positions.length === 0) return null;
  const optionsValuePln = positions.reduce((s, p) => s + p.currentValuePln, 0);

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          Opcje
          <span className="ml-2 text-muted-foreground font-normal">
            ({groups.length} {groups.length === 1 ? 'pozycja' : 'pozycje'} |{' '}
            {formatPLN(optionsValuePln)})
          </span>
        </CardTitle>
        <div className="inline-flex items-center rounded-md bg-muted p-0.5 shrink-0">
          {(['positions', 'greeks'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-0.5 rounded text-xs font-medium transition-colors ${
                tab === t ? 'bg-background text-foreground' : 'text-muted-foreground'
              }`}
            >
              {t === 'positions' ? 'Pozycje' : 'Greeks'}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {tab === 'greeks' && <PortfolioOptionsGreeks groups={groups} />}
        {tab === 'positions' && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Instrument</TableHead>
                  <TableHead>Wygasa</TableHead>
                  <TableHead className="text-right">DTE</TableHead>
                  <TableHead className="text-right">Ilość</TableHead>
                  <TableHead className="text-right">Śr. premia</TableHead>
                  <TableHead className="text-right">Kurs</TableHead>
                  <TableHead className="text-right">Wartość (PLN)</TableHead>
                  <TableHead className="text-right">P/L</TableHead>
                  <TableHead className="text-right">P/L %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => {
                  // Pojedyncza noga — zwykły wiersz (bez rozwijania).
                  if (g.legs.length === 1) return <LegRow key={g.key} pos={g.legs[0]} />;

                  const isOpen = expanded.has(g.key);
                  return (
                    <Fragment key={g.key}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggle(g.key)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggle(g.key);
                          }
                        }}
                      >
                        <TableCell className="font-mono font-medium whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            )}
                            {g.label}
                            {g.kindLabel && (
                              <Badge variant="outline" className="ml-1 text-[10px]">
                                {g.kindLabel}
                              </Badge>
                            )}
                            {g.expiryPassed && <ExpiryWarning />}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">
                          {g.expiry || '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <DteCell expiry={g.expiry} />
                        </TableCell>
                        {/* Ilość/premia/kurs są per-noga — na wierszu spreadu puste, widoczne po rozwinięciu. */}
                        <TableCell className="text-right text-muted-foreground">
                          {legWord(g.legs.length)}
                        </TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell
                          className={`text-right font-medium tabular-nums ${g.netValuePln < 0 ? 'text-red-600' : ''}`}
                        >
                          {formatPLN(g.netValuePln)}
                        </TableCell>
                        <TableCell
                          className={`text-right font-medium ${plColor(g.netProfitLossPct)}`}
                        >
                          {formatCurrency(g.netProfitLoss, g.currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          <PLBadge value={g.netProfitLossPct} />
                        </TableCell>
                      </TableRow>
                      {isOpen && g.legs.map((leg) => <LegRow key={leg.isin} pos={leg} indent />)}
                    </Fragment>
                  );
                })}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell colSpan={6} className="text-right">
                    Razem
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${optionsValuePln < 0 ? 'text-red-600' : ''}`}
                  >
                    {formatPLN(optionsValuePln)}
                  </TableCell>
                  <TableCell colSpan={2} className="text-right text-muted-foreground font-normal">
                    {totalValuePln > 0
                      ? `${((optionsValuePln / totalValuePln) * 100).toFixed(1)}% portfela`
                      : ''}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
