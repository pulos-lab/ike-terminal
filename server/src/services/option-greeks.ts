/**
 * Greeki portfela opcji (Black-Scholes) — per pozycja i agregat netto, w dwóch trybach:
 * „teraz" (IV z żywej ceny opcji + żywy kurs bazowego) oraz „z dnia zakupu" (IV z premii
 * transakcji + kurs bazowego z dnia wejścia). Liczone na żądanie (osobny endpoint), żeby
 * nie obciążać głównego widoku pozycji. Reużywa computeOpenPositions (żywa cena opcji,
 * optionMeta, buyLots) i risk-free-rate (stopa dopasowana do terminu, historyczna dla zakupu).
 */
import type {
  OptionGreeks,
  PositionGreeks,
  GreeksNet,
  PortfolioGreeksResponse,
  OptionRight,
} from 'shared';
import { bsGreeks, impliedVol } from 'shared';
import { getAllTransactions } from '../db/transactions-repo.js';
import { getTickerMap } from '../db/ticker-map-repo.js';
import { getOptionContractsMap } from '../db/option-contracts-repo.js';
import { computeOpenPositions } from './portfolio-engine.js';
import { fetchYahooPrice, fetchYahooHistory, fetchFxRate } from './yahoo-finance.js';
import { riskFreeRate } from './risk-free-rate.js';
import { DEFAULT_FX_PLN } from 'shared';

const MS_YEAR = 365 * 86_400_000;
const ZERO_NET: GreeksNet = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };

function yearsBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / MS_YEAR;
}

function moneyness(right: OptionRight, S: number, K: number): 'ITM' | 'ATM' | 'OTM' {
  if (Math.abs(S / K - 1) < 0.02) return 'ATM';
  const itm = right === 'C' ? S > K : S < K;
  return itm ? 'ITM' : 'OTM';
}

/** Greeki per kontrakt → skala pozycji (× mnożnik × shares ze znakiem); theta/vega/rho → PLN. */
function scaleToPosition(
  right: OptionRight,
  S: number,
  K: number,
  T: number,
  r: number,
  iv: number,
  shares: number,
  multiplier: number,
  fxToPln: number,
): OptionGreeks {
  const g = bsGreeks(right, S, K, T, r, iv);
  const qm = shares * multiplier; // ze znakiem: short → ujemne
  return {
    delta: g.delta * qm,
    gamma: g.gamma * qm,
    theta: g.theta * qm * fxToPln,
    vega: g.vega * qm * fxToPln,
    rho: g.rho * qm * fxToPln,
    iv,
  };
}

function addNet(net: GreeksNet, g: OptionGreeks): void {
  net.delta += g.delta;
  net.gamma += g.gamma;
  net.theta += g.theta;
  net.vega += g.vega;
  net.rho += g.rho;
}

export async function computePortfolioGreeks(pid: string): Promise<PortfolioGreeksResponse> {
  const asOf = new Date().toISOString().slice(0, 10);
  const optionTx = getAllTransactions(pid).filter((t) => t.isin.startsWith('OPT:'));
  if (optionTx.length === 0) {
    return { positions: [], net: { current: { ...ZERO_NET }, atPurchase: { ...ZERO_NET } }, asOf };
  }

  const tickerMap = getTickerMap(pid);
  const optionContracts = getOptionContractsMap(pid);
  const { positions } = await computeOpenPositions(optionTx, tickerMap, [], undefined, {
    skipSplitDetection: true,
    optionContracts,
  });
  const optPos = positions.filter((p) => p.category === 'option' && p.optionMeta);
  if (optPos.length === 0) {
    return { positions: [], net: { current: { ...ZERO_NET }, atPurchase: { ...ZERO_NET } }, asOf };
  }

  // FX per waluta kontraktu (do PLN dla theta/vega/rho).
  const currencies = [...new Set(optPos.map((p) => p.currency.toUpperCase()))];
  const fxToPln: Record<string, number> = { PLN: 1 };
  await Promise.all(
    currencies
      .filter((c) => c !== 'PLN')
      .map(async (c) => {
        fxToPln[c] = (await fetchFxRate(`${c}PLN`)) || DEFAULT_FX_PLN[c] || 1;
      }),
  );

  // Żywy kurs + historia kursu bazowego per unikalny underlying (dedup fetchy).
  const underlyings = [...new Set(optPos.map((p) => p.optionMeta!.underlying))];
  const earliestByUnderlying = new Map<string, string>();
  for (const p of optPos) {
    const d = p.buyLots?.[0]?.date?.slice(0, 10);
    const u = p.optionMeta!.underlying;
    if (d && (!earliestByUnderlying.has(u) || d < earliestByUnderlying.get(u)!)) {
      earliestByUnderlying.set(u, d);
    }
  }
  const liveByUnderlying = new Map<string, number | null>();
  const histByUnderlying = new Map<string, Array<{ date: string; close: number }>>();
  await Promise.all(
    underlyings.map(async (u) => {
      const [live, hist] = await Promise.all([
        fetchYahooPrice(u)
          .then((r) => r?.price ?? null)
          .catch(() => null),
        earliestByUnderlying.has(u)
          ? fetchYahooHistory(u, earliestByUnderlying.get(u)!, asOf).catch(() => [])
          : Promise.resolve([]),
      ]);
      liveByUnderlying.set(u, live);
      histByUnderlying.set(u, hist);
    }),
  );
  const closeOnOrBefore = (u: string, date: string): number | null => {
    const arr = histByUnderlying.get(u) ?? [];
    let best: number | null = null;
    for (const h of arr) if (h.date <= date) best = h.close;
    return best;
  };

  const net = { current: { ...ZERO_NET }, atPurchase: { ...ZERO_NET } };
  const out: PositionGreeks[] = [];

  for (const p of optPos) {
    const m = p.optionMeta!;
    const right = m.optionType as OptionRight;
    const K = m.strike;
    const mult = m.multiplier || 100;
    const fx = fxToPln[p.currency.toUpperCase()] ?? 1;
    const dteDays = Math.round(yearsBetween(asOf, m.expiry) * 365);

    // ── Teraz ──
    let current: OptionGreeks | null = null;
    const Snow = liveByUnderlying.get(m.underlying) ?? null;
    const Tnow = yearsBetween(asOf, m.expiry);
    if (Snow != null && Snow > 0 && Tnow > 0 && p.currentPrice != null && p.currentPrice > 0) {
      const rNow = await riskFreeRate(Tnow);
      const iv = impliedVol(right, p.currentPrice, Snow, K, Tnow, rNow);
      if (iv != null) {
        current = scaleToPosition(right, Snow, K, Tnow, rNow, iv, p.shares, mult, fx);
        addNet(net.current, current);
      }
    }

    // ── Z dnia zakupu ──
    let atPurchase: (OptionGreeks & { date: string }) | null = null;
    const lot = p.buyLots?.[0];
    if (lot?.date && lot.price > 0) {
      const buyDate = lot.date.slice(0, 10);
      const Sbuy = closeOnOrBefore(m.underlying, buyDate);
      const Tbuy = yearsBetween(buyDate, m.expiry);
      if (Sbuy != null && Sbuy > 0 && Tbuy > 0) {
        const rBuy = await riskFreeRate(Tbuy, buyDate);
        const iv = impliedVol(right, lot.price, Sbuy, K, Tbuy, rBuy);
        if (iv != null) {
          const g = scaleToPosition(right, Sbuy, K, Tbuy, rBuy, iv, p.shares, mult, fx);
          atPurchase = { ...g, date: buyDate };
          addNet(net.atPurchase, g);
        }
      }
    }

    out.push({
      isin: p.isin,
      underlying: m.underlying,
      dte: dteDays,
      moneyness: Snow != null && Snow > 0 ? moneyness(right, Snow, K) : 'OTM',
      current,
      atPurchase,
    });
  }

  return { positions: out, net, asOf };
}
