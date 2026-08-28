import type { ClosedTrade } from 'shared';
import { parseOccTicker } from 'shared';

/**
 * Zgrupowany round-trip pozycji (epizod flat→flat). Jeden cykl otwarcie → pełne
 * zamknięcie może obejmować wiele lotów kupna (FIFO) ORAZ wiele transakcji sprzedaży
 * (partial fille jednego zlecenia, dokupienia/odsprzedaże) — prezentujemy jako jeden
 * wiersz i liczymy jako JEDNĄ transakcję (win rate, podsumowania).
 *
 * Dodatkowo: zamknięte nogi spreadu opcyjnego (ten sam underlying+expiry, jedna noga
 * długa i jedna krótka) są scalane w JEDEN round-trip — spread to jedna pozycja/jedno
 * rozliczenie, więc liczy się jako jedna transakcja w statystykach (spójnie z widokiem
 * otwartych pozycji).
 */
export interface TradeGroup {
  key: string;
  ticker: string;
  paperName: string;
  currency: string;
  sellDate: string;
  minSellDate: string;
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
  sellTransactionIds: number[];
  everyManual: boolean;
  isOpen: boolean;
  trades: ClosedTrade[];
  /** true gdy grupa to scalony spread opcyjny (nogi = różne kontrakty, nie loty jednego). */
  isSpread?: boolean;
  /** Czytelna etykieta spreadu ("DECK 90/100 PUT" / "DECK · 3 nogi"); tylko dla isSpread. */
  spreadLabel?: string;
  /** Waluta nogi kupna, gdy różni się od `currency` (trade mieszany — np. kupno
   *  GPW/PLN domknięte squeeze-outem LSE/GBP). Etykiety cen kupna idą po niej. */
  buyCurrency?: string;
}

/** Koszt nabycia lota — zaangażowany kapitał (cena kupna × ilość + prowizja kupna). */
export function lotCostBasis(trade: ClosedTrade): number {
  // Trade mieszany (waluta kupna ≠ waluty sprzedaży): koszt w walucie kupna nie
  // sumuje się z P/L w walucie sprzedaży — bierzemy koszt przeliczony przez PLN
  // z powrotem na walutę sprzedaży (kursy z nóg policzone na serwerze).
  if (trade.buyCurrency && trade.costBasisPln != null && trade.fxRateClose) {
    return trade.costBasisPln / trade.fxRateClose;
  }
  return (trade.buyPrice ?? 0) * (trade.quantity ?? 0) + (trade.buyCommission ?? 0);
}

/** Klucz round-tripu — `tradeGroupId` z silnika; fallback per-sprzedaż dla starego cache. */
function groupKeyOf(trade: ClosedTrade): string {
  return (
    trade.tradeGroupId ??
    `${trade.ticker}|${trade.sellDate.slice(0, 10)}|${trade.sellTransactionId}`
  );
}

/** Strike bez zbędnych zer: 90 → „90", 5.6 → „5,6". */
function fmtStrike(n: number): string {
  return n.toLocaleString('pl-PL', { maximumFractionDigits: 3 });
}

/** Etykieta scalonego spreadu z jego nóg (kontraktów). */
function buildSpreadLabel(trades: ClosedTrade[]): string {
  const parsed = trades
    .map((t) => ({ t, p: parseOccTicker(t.ticker) }))
    .filter(
      (x): x is { t: ClosedTrade; p: NonNullable<ReturnType<typeof parseOccTicker>> } => !!x.p,
    );
  const underlying = parsed[0]?.p.underlying ?? trades[0].ticker;
  const distinct = new Map<string, { strike: number; right: 'C' | 'P' }>();
  for (const { t, p } of parsed) distinct.set(t.ticker, { strike: p.strike, right: p.optionType });
  const legs = [...distinct.values()];
  const rights = new Set(legs.map((l) => l.right));
  if (legs.length === 2 && rights.size === 1) {
    const strikes = legs.map((l) => l.strike).sort((a, b) => a - b);
    const right = rights.values().next().value === 'C' ? 'CALL' : 'PUT';
    return `${underlying} ${fmtStrike(strikes[0])}/${fmtStrike(strikes[1])} ${right}`;
  }
  return `${underlying} · ${legs.length} ${legs.length >= 5 ? 'nóg' : 'nogi'}`;
}

/**
 * Wyznacza scalanie round-tripów w spready: opcyjne round-tripy z tym samym
 * underlying+expiry, gdzie jest noga długa ORAZ krótka. Zwraca finalne kubełki
 * (spread → jeden klucz z unią nóg; reszta bez zmian).
 */
function mergeSpreads(
  byRoundTrip: Map<string, ClosedTrade[]>,
): Map<string, { trades: ClosedTrade[]; isSpread: boolean; spreadLabel?: string }> {
  const ueBuckets = new Map<string, string[]>();
  const rtIsShort = new Map<string, boolean>();
  for (const [rtKey, rt] of byRoundTrip) {
    if (rt[0].category !== 'option') continue;
    const p = parseOccTicker(rt[0].ticker);
    if (!p) continue;
    const ue = `${p.underlying}|${p.expiry}`;
    (ueBuckets.get(ue) ?? ueBuckets.set(ue, []).get(ue)!).push(rtKey);
    // Round-trip pojedynczego kontraktu jest w całości long albo short.
    rtIsShort.set(rtKey, !!rt[0].isShort);
  }

  const spreadKeyByRt = new Map<string, string>();
  const spreadLabelByKey = new Map<string, string>();
  for (const [ue, rtKeys] of ueBuckets) {
    if (rtKeys.length < 2) continue;
    const hasLong = rtKeys.some((k) => !rtIsShort.get(k));
    const hasShort = rtKeys.some((k) => rtIsShort.get(k));
    if (!hasLong || !hasShort) continue;
    const sKey = `spread|${ue}`;
    const legTrades = rtKeys.flatMap((k) => byRoundTrip.get(k)!);
    rtKeys.forEach((k) => spreadKeyByRt.set(k, sKey));
    spreadLabelByKey.set(sKey, buildSpreadLabel(legTrades));
  }

  const out = new Map<string, { trades: ClosedTrade[]; isSpread: boolean; spreadLabel?: string }>();
  for (const [rtKey, rt] of byRoundTrip) {
    const sKey = spreadKeyByRt.get(rtKey);
    if (sKey) {
      const e = out.get(sKey) ?? {
        trades: [],
        isSpread: true,
        spreadLabel: spreadLabelByKey.get(sKey),
      };
      e.trades.push(...rt);
      out.set(sKey, e);
    } else {
      out.set(rtKey, { trades: rt, isSpread: false });
    }
  }
  return out;
}

function buildGroup(
  key: string,
  unsorted: ClosedTrade[],
  isSpread: boolean,
  spreadLabel: string | undefined,
): TradeGroup {
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
  const totalHoldingDaysWeighted = groupTrades.reduce((s, t) => s + t.holdingDays * t.quantity, 0);
  const grossRevenue = groupTrades.reduce((s, t) => s + t.quantity * t.sellPrice, 0);
  const totalCost = groupTrades.reduce(
    (s, t) => s + (t.totalCost || t.buyCommission + t.sellCommission),
    0,
  );
  const sellTransactionIds = Array.from(new Set(groupTrades.map((t) => t.sellTransactionId)));

  return {
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
    isSpread: isSpread || undefined,
    spreadLabel,
    buyCurrency: groupTrades.find((t) => t.buyCurrency)?.buyCurrency,
  };
}

/**
 * Grupuje zamknięte transakcje per round-trip (epizod pozycji flat→flat, `tradeGroupId`),
 * a następnie scala nogi spreadów opcyjnych (patrz mergeSpreads).
 *
 * Partial fille jednego zlecenia oraz dokupienia/odsprzedaże tej samej pozycji trafiają
 * do jednej grupy → jeden wiersz w UI i jedna pozycja w win rate. Dwa odrębne round-tripy
 * (pozycja zamknięta do zera i otwarta ponownie) pozostają osobnymi grupami.
 */
export function groupClosedTrades(trades: ClosedTrade[]): TradeGroup[] {
  if (!trades.length) return [];

  const byRoundTrip = new Map<string, ClosedTrade[]>();
  for (const trade of trades) {
    const key = groupKeyOf(trade);
    const arr = byRoundTrip.get(key) || [];
    arr.push(trade);
    byRoundTrip.set(key, arr);
  }

  const result: TradeGroup[] = [];
  for (const [key, bucket] of mergeSpreads(byRoundTrip)) {
    result.push(buildGroup(key, bucket.trades, bucket.isSpread, bucket.spreadLabel));
  }

  // Sort po dacie domknięcia (ostatnia sprzedaż) malejąco.
  result.sort((a, b) => b.sellDate.localeCompare(a.sellDate));
  return result;
}
