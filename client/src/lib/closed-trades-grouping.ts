import type { ClosedTrade } from 'shared';

/**
 * Zgrupowana pozycja zamknięta — jedna transakcja sprzedaży (sellTransactionId)
 * może zamykać wiele lotów kupna (FIFO), które prezentujemy jako jeden wiersz.
 */
export interface TradeGroup {
  key: string;
  ticker: string;
  paperName: string;
  sellDate: string;
  sellPrice: number;
  currency: string;
  totalQuantity: number;
  totalProfitLoss: number;
  totalCost: number;
  weightedProfitLossPct: number;
  minBuyDate: string;
  maxBuyDate: string;
  minBuyPrice: number;
  maxBuyPrice: number;
  avgHoldingDays: number;
  sellTransactionId: number;
  sellSource: 'bossa' | 'mbank' | 'degiro' | 'xtb' | 'manual' | 'auto-yahoo';
  trades: ClosedTrade[];
}

/** Koszt nabycia lota — zaangażowany kapitał (cena kupna × ilość + prowizja kupna). */
export function lotCostBasis(trade: ClosedTrade): number {
  return (trade.buyPrice ?? 0) * (trade.quantity ?? 0) + (trade.buyCommission ?? 0);
}

/**
 * Grupuje zamknięte transakcje per transakcja sprzedaży.
 *
 * Klucz zawiera sellTransactionId — dwie odrębne sprzedaże tego samego tickera
 * tego samego dnia NIE mogą się scalić (wcześniej trash button usuwał tylko pierwszą).
 *
 * P/L % grupy ważony kosztem nabycia (Σ profitLoss / Σ costBasis), a nie ilością —
 * ważenie ilością przekłamuje wynik gdy loty mają różne ceny kupna.
 */
export function groupClosedTrades(trades: ClosedTrade[]): TradeGroup[] {
  if (!trades.length) return [];

  const map = new Map<string, ClosedTrade[]>();
  for (const trade of trades) {
    const sellDay = trade.sellDate.slice(0, 10);
    const key = `${trade.ticker}|${sellDay}|${trade.sellTransactionId}`;
    const arr = map.get(key) || [];
    arr.push(trade);
    map.set(key, arr);
  }

  const result: TradeGroup[] = [];
  for (const [key, groupTrades] of map) {
    const first = groupTrades[0];
    const totalQuantity = groupTrades.reduce((s, t) => s + t.quantity, 0);
    const totalProfitLoss = groupTrades.reduce((s, t) => s + t.profitLoss, 0);

    // Ważenie kosztem nabycia: Σ(P/L) / Σ(koszt) — poprawne gdy loty mają różne ceny.
    // Fallback do średniej ważonej ilością gdy koszt nieznany/zerowy (np. shorty CFD).
    const totalCostBasis = groupTrades.reduce((s, t) => s + lotCostBasis(t), 0);
    const weightedProfitLossPct =
      totalCostBasis > 0
        ? (totalProfitLoss / totalCostBasis) * 100
        : totalQuantity > 0
          ? groupTrades.reduce((s, t) => s + t.profitLossPct * t.quantity, 0) / totalQuantity
          : 0;

    const buyDates = groupTrades.map((t) => t.buyDate).sort();
    const buyPrices = groupTrades.map((t) => t.buyPrice);
    const totalHoldingDaysWeighted = groupTrades.reduce(
      (s, t) => s + t.holdingDays * t.quantity,
      0,
    );

    const totalCost = groupTrades.reduce(
      (s, t) => s + (t.totalCost || t.buyCommission + t.sellCommission),
      0,
    );

    result.push({
      key,
      ticker: first.ticker,
      paperName: first.paperName,
      sellDate: first.sellDate,
      sellPrice: first.sellPrice,
      currency: first.currency,
      totalQuantity,
      totalProfitLoss,
      totalCost,
      weightedProfitLossPct,
      minBuyDate: buyDates[0],
      maxBuyDate: buyDates[buyDates.length - 1],
      minBuyPrice: Math.min(...buyPrices),
      maxBuyPrice: Math.max(...buyPrices),
      avgHoldingDays: totalQuantity > 0 ? Math.round(totalHoldingDaysWeighted / totalQuantity) : 0,
      sellTransactionId: first.sellTransactionId,
      sellSource: first.sellSource,
      trades: groupTrades,
    });
  }

  result.sort((a, b) => b.sellDate.localeCompare(a.sellDate));
  return result;
}
