import type { ClosedTrade } from 'shared';

/**
 * Zgrupowany round-trip pozycji (epizod flat→flat). Jeden cykl otwarcie → pełne
 * zamknięcie może obejmować wiele lotów kupna (FIFO) ORAZ wiele transakcji sprzedaży
 * (partial fille jednego zlecenia, dokupienia/odsprzedaże) — prezentujemy jako jeden
 * wiersz i liczymy jako JEDNĄ transakcję (win rate, podsumowania).
 */
export interface TradeGroup {
  key: string;
  ticker: string;
  paperName: string;
  currency: string;
  /** Data domknięcia round-tripu = ostatnia (najpóźniejsza) sprzedaż. Sort/filtr/wyświetlanie. */
  sellDate: string;
  /** Pierwsza (najwcześniejsza) sprzedaż w round-tripie — do zakresu dat. */
  minSellDate: string;
  /** Średnia cena sprzedaży ważona ilością (Σ qty×cena / Σ qty) — spójna z przychodem brutto. */
  sellPrice: number;
  minSellPrice: number;
  maxSellPrice: number;
  totalQuantity: number;
  totalProfitLoss: number;
  totalCost: number;
  weightedProfitLossPct: number;
  minBuyDate: string;
  maxBuyDate: string;
  minBuyPrice: number;
  maxBuyPrice: number;
  avgHoldingDays: number;
  /** Wszystkie odrębne transakcje sprzedaży w round-tripie (do usuwania / re-otwarcia). */
  sellTransactionIds: number[];
  /** true gdy wszystkie sprzedaże round-tripu są ręczne — tylko wtedy pokazujemy usuwanie. */
  everyManual: boolean;
  /** true gdy round-trip nie domknięty (pozycja wciąż częściowo otwarta). */
  isOpen: boolean;
  trades: ClosedTrade[];
}

/** Koszt nabycia lota — zaangażowany kapitał (cena kupna × ilość + prowizja kupna). */
export function lotCostBasis(trade: ClosedTrade): number {
  return (trade.buyPrice ?? 0) * (trade.quantity ?? 0) + (trade.buyCommission ?? 0);
}

/** Klucz round-tripu — `tradeGroupId` z silnika; fallback per-sprzedaż dla starego cache. */
function groupKeyOf(trade: ClosedTrade): string {
  return (
    trade.tradeGroupId ??
    `${trade.ticker}|${trade.sellDate.slice(0, 10)}|${trade.sellTransactionId}`
  );
}

/**
 * Grupuje zamknięte transakcje per round-trip (epizod pozycji flat→flat, `tradeGroupId`).
 *
 * Partial fille jednego zlecenia oraz dokupienia/odsprzedaże tej samej pozycji trafiają
 * do jednej grupy → jeden wiersz w UI i jedna pozycja w win rate. Dwa odrębne round-tripy
 * (pozycja zamknięta do zera i otwarta ponownie) pozostają osobnymi grupami.
 *
 * P/L % grupy ważony kosztem nabycia (Σ profitLoss / Σ costBasis), a nie ilością —
 * ważenie ilością przekłamuje wynik gdy loty mają różne ceny kupna.
 */
export function groupClosedTrades(trades: ClosedTrade[]): TradeGroup[] {
  if (!trades.length) return [];

  const map = new Map<string, ClosedTrade[]>();
  for (const trade of trades) {
    const key = groupKeyOf(trade);
    const arr = map.get(key) || [];
    arr.push(trade);
    map.set(key, arr);
  }

  const result: TradeGroup[] = [];
  for (const [key, unsorted] of map) {
    // Stabilna kolejność nóg do wyświetlania: po dacie sprzedaży, potem kupna.
    const groupTrades = [...unsorted].sort(
      (a, b) => a.sellDate.localeCompare(b.sellDate) || a.buyDate.localeCompare(b.buyDate),
    );
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
    const sellDates = groupTrades.map((t) => t.sellDate).sort();
    const buyPrices = groupTrades.map((t) => t.buyPrice);
    const sellPrices = groupTrades.map((t) => t.sellPrice);
    const totalHoldingDaysWeighted = groupTrades.reduce(
      (s, t) => s + t.holdingDays * t.quantity,
      0,
    );
    // Przychód brutto round-tripu — różne sprzedaże mogą mieć różne ceny.
    const grossRevenue = groupTrades.reduce((s, t) => s + t.quantity * t.sellPrice, 0);

    const totalCost = groupTrades.reduce(
      (s, t) => s + (t.totalCost || t.buyCommission + t.sellCommission),
      0,
    );

    const sellTransactionIds = Array.from(new Set(groupTrades.map((t) => t.sellTransactionId)));

    result.push({
      key,
      ticker: first.ticker,
      paperName: first.paperName,
      currency: first.currency,
      sellDate: sellDates[sellDates.length - 1],
      minSellDate: sellDates[0],
      sellPrice: totalQuantity > 0 ? grossRevenue / totalQuantity : first.sellPrice,
      minSellPrice: Math.min(...sellPrices),
      maxSellPrice: Math.max(...sellPrices),
      totalQuantity,
      totalProfitLoss,
      totalCost,
      weightedProfitLossPct,
      minBuyDate: buyDates[0],
      maxBuyDate: buyDates[buyDates.length - 1],
      minBuyPrice: Math.min(...buyPrices),
      maxBuyPrice: Math.max(...buyPrices),
      avgHoldingDays: totalQuantity > 0 ? Math.round(totalHoldingDaysWeighted / totalQuantity) : 0,
      sellTransactionIds,
      everyManual: groupTrades.every((t) => t.sellSource === 'manual'),
      isOpen: groupTrades.some((t) => t.tradeGroupOpen),
      trades: groupTrades,
    });
  }

  // Sort po dacie domknięcia (ostatnia sprzedaż) malejąco.
  result.sort((a, b) => b.sellDate.localeCompare(a.sellDate));
  return result;
}
