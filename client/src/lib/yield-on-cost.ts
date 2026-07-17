/**
 * Yield on cost z FAKTYCZNIE wypłaconych dywidend (ostatnie 12 miesięcy, kwoty
 * netto w PLN po kursie z dnia wypłaty) względem kosztu nabycia otwartych
 * pozycji. Koszt PLN pozycji wyprowadzany z danych silnika:
 * currentValuePln − profitLossPln (kurs z dnia zakupu — ta sama konwencja co
 * P/L). Dywidendy ze sprzedanych pozycji są celowo POZA licznikiem (nie ma ich
 * kosztu w mianowniku); rekord bez dopasowanego ISIN-u lub bez kursu FX
 * ustawia flagę approx (wynik zaniżony).
 */
import type { DividendRecord, Position } from 'shared';

export interface YocPosition {
  isin: string;
  ticker: string;
  paperName: string;
  costPln: number;
  dividends12mPln: number;
  yocPct: number;
}

export interface YocSummary {
  /** Dywidendy 12M przypisane do otwartych pozycji (PLN). */
  totalDividends12mPln: number;
  /** Koszt nabycia wszystkich uwzględnionych otwartych pozycji (PLN). */
  totalCostPln: number;
  /** totalDividends12mPln / totalCostPln — yield on cost całego portfela (%). */
  totalYocPct: number;
  /** Pozycje z dywidendą w oknie 12M, malejąco po YoC. */
  positions: YocPosition[];
  /** True gdy część dywidend 12M nie weszła do rachunku (brak ISIN-u/kursu FX). */
  approx: boolean;
}

/** ISO date minus `days` dni (daty domenowe są kalendarzowe — czysta arytmetyka UTC). */
function isoDaysAgo(todayIso: string, days: number): string {
  const d = new Date(todayIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function computeYieldOnCost(
  dividends: DividendRecord[],
  positions: Position[],
  todayIso: string,
): YocSummary | null {
  // Opcje nie płacą dywidend, a shorty mają ujemny koszt — poza rachunkiem.
  const eligible = positions.filter((p) => {
    if (p.category === 'option') return false;
    const costPln = p.currentValuePln - p.profitLossPln;
    return Number.isFinite(costPln) && costPln > 0;
  });
  if (!eligible.length) return null;

  const ttmStart = isoDaysAgo(todayIso, 365);
  const byIsin = new Map<string, number>();
  let approx = false;
  for (const d of dividends) {
    const date = d.date.slice(0, 10);
    if (date < ttmStart || date > todayIso) continue;
    if (d.isin == null || d.amountPln == null) {
      approx = true;
      continue;
    }
    byIsin.set(d.isin, (byIsin.get(d.isin) ?? 0) + d.amountPln);
  }

  let totalCostPln = 0;
  let totalDividends12mPln = 0;
  const payers: YocPosition[] = [];
  for (const p of eligible) {
    const costPln = p.currentValuePln - p.profitLossPln;
    totalCostPln += costPln;
    const dividends12mPln = byIsin.get(p.isin) ?? 0;
    if (dividends12mPln > 0) {
      totalDividends12mPln += dividends12mPln;
      payers.push({
        isin: p.isin,
        ticker: p.ticker,
        paperName: p.paperName,
        costPln,
        dividends12mPln,
        yocPct: (dividends12mPln / costPln) * 100,
      });
    }
  }
  if (totalCostPln <= 0) return null;

  payers.sort((a, b) => b.yocPct - a.yocPct);
  return {
    totalDividends12mPln,
    totalCostPln,
    totalYocPct: (totalDividends12mPln / totalCostPln) * 100,
    positions: payers,
    approx,
  };
}
