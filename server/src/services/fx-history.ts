/**
 * Historyczne kursy walut → PLN dla zamkniętych pozycji.
 *
 * Zamknięta pozycja w walucie obcej ma dwie nogi w różnych datach: otwarcie
 * (koszt) i zamknięcie (przychód). Realny wynik w PLN wymaga przeliczenia każdej
 * nogi po kursie z jej dnia — samo `profitLoss × kurs` gubi efekt walutowy na
 * kapitale (np. zysk 10 USD przy osłabieniu złotego o 10% to dużo więcej niż
 * 10 × kurs zamknięcia).
 *
 * Kursy z Yahoo (`USDPLN=X`) przez fetchYahooHistory — 3-warstwowy cache
 * (NodeCache → price_history.db → sieć), więc po pierwszym żądaniu lookup jest
 * praktycznie darmowy.
 */
import type { ClosedTrade } from 'shared';
import { fetchYahooHistory } from './yahoo-finance.js';

/** Kurs waluta→PLN na dany dzień (YYYY-MM-DD lub ISO). null = brak danych. */
export type FxToPlnLookup = (currency: string, date: string) => number | null;

/** Weekend/święto: cofamy się do ostatniego notowania, maks. tyle dni. */
const MAX_LOOKBACK_DAYS = 7;

/** GBX/GBp (pensy) = 1/100 GBP — Yahoo ma tylko parę GBPPLN=X. */
function fxPairFor(currency: string): { pair: string; factor: number } | null {
  const upper = currency.toUpperCase();
  if (upper === 'PLN') return null;
  if (upper === 'GBX' || upper === 'GBP') {
    return { pair: 'GBP', factor: currency.toUpperCase() === 'GBX' ? 0.01 : 1 };
  }
  return { pair: upper, factor: 1 };
}

function shiftDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Buduje lookup kursów dziennych dla podanych walut od `fromDate`.
 * Brak pary / błąd sieci nie rzuca — lookup zwraca null dla tej waluty,
 * a wywołujący zostawia pola PLN niewypełnione.
 */
export async function buildFxToPlnLookup(
  currencies: string[],
  fromDate: string,
): Promise<FxToPlnLookup> {
  const pairs = new Set<string>();
  for (const cur of currencies) {
    const norm = fxPairFor(cur);
    if (norm) pairs.add(norm.pair);
  }

  // Bufor na lookback (start zakresu może wypaść w weekend)
  const start = shiftDays(fromDate.slice(0, 10), -(MAX_LOOKBACK_DAYS * 2));
  const rates = new Map<string, Map<string, number>>();
  await Promise.all(
    Array.from(pairs).map(async (pair) => {
      try {
        const data = await fetchYahooHistory(`${pair}PLN=X`, start);
        const byDate = new Map<string, number>();
        for (const d of data) {
          if (d.close > 0) byDate.set(d.date, d.close);
        }
        if (byDate.size > 0) rates.set(pair, byDate);
      } catch (err) {
        console.warn(`fx-history: brak kursów ${pair}PLN=X:`, err);
      }
    }),
  );

  return (currency, date) => {
    const norm = fxPairFor(currency);
    if (!norm) return 1; // PLN
    const byDate = rates.get(norm.pair);
    if (!byDate) return null;
    let key = date.slice(0, 10);
    for (let i = 0; i <= MAX_LOOKBACK_DAYS; i++) {
      const rate = byDate.get(key);
      if (rate !== undefined) return rate * norm.factor;
      key = shiftDays(key, -1);
    }
    return null;
  };
}

/**
 * Wypełnia `profitLossPln`, `costBasisPln`, `fxRateOpen/Close` na zamkniętych
 * pozycjach (mutacja in-place). Pozycje bez kursu lub bez `costBasis` zostają
 * nietknięte — klient pokazuje je jako nieprzeliczalne zamiast sumować fałszywie.
 *
 * Konwencja: noga otwarcia po kursie z dnia otwarcia, noga zamknięcia po kursie
 * z dnia zamknięcia (jak rozliczenie podatkowe, bez reguły D-1). Wyjątek CFD:
 * wynik materializuje się w walucie konta w dniu zamknięcia, więc całość po
 * kursie zamknięcia (notional to dźwignia, nie zaangażowany kapitał).
 */
export function convertClosedTradesToPln(trades: ClosedTrade[], fx: FxToPlnLookup): void {
  for (const trade of trades) {
    if (trade.currency.toUpperCase() === 'PLN') {
      trade.profitLossPln = trade.profitLoss;
      if (trade.costBasis !== undefined) trade.costBasisPln = trade.costBasis;
      trade.fxRateOpen = 1;
      trade.fxRateClose = 1;
      continue;
    }

    const openFx = fx(trade.currency, trade.buyDate);
    const closeFx = fx(trade.currency, trade.sellDate);
    if (openFx == null || closeFx == null || trade.costBasis === undefined) continue;

    trade.fxRateOpen = openFx;
    trade.fxRateClose = closeFx;

    if (trade.category === 'cfd') {
      trade.profitLossPln = trade.profitLoss * closeFx;
      trade.costBasisPln = trade.costBasis * closeFx;
      continue;
    }

    const fees = (trade.fees ?? []).reduce((s, f) => s + f.amount, 0);
    if (trade.isShort) {
      // buyDate/buyPrice = otwarcie shorta (gotówka wpływa przy otwarciu),
      // sellDate/sellPrice = odkupienie. costBasis = wartość otwarcia + prowizja otwarcia.
      const openValue = trade.costBasis - trade.buyCommission;
      const coverValue =
        openValue - trade.profitLoss - trade.buyCommission - trade.sellCommission - fees;
      trade.profitLossPln =
        (openValue - trade.buyCommission) * openFx -
        (coverValue + trade.sellCommission + fees) * closeFx;
    } else {
      // costBasis = wartość nabycia (z nominałem obligacji) + prowizja kupna,
      // stąd wartość sprzedaży = P/L + costBasis + prowizja sprzedaży + opłaty.
      const sellValue = trade.profitLoss + trade.costBasis + trade.sellCommission + fees;
      trade.profitLossPln =
        (sellValue - trade.sellCommission - fees) * closeFx - trade.costBasis * openFx;
    }
    trade.costBasisPln = trade.costBasis * openFx;
  }
}

/**
 * Wygodny wrapper dla endpointu: zbiera waluty i najwcześniejszą datę z pozycji,
 * buduje lookup i konwertuje. No-op (poza PLN-ami) gdy wszystko w PLN.
 */
export async function annotateClosedTradesPln(trades: ClosedTrade[]): Promise<void> {
  if (trades.length === 0) return;
  const foreign = trades.filter((t) => t.currency.toUpperCase() !== 'PLN');
  let minDate = '9999-12-31';
  for (const t of foreign) {
    const open = t.buyDate.slice(0, 10);
    if (open < minDate) minDate = open;
  }
  const lookup =
    foreign.length > 0
      ? await buildFxToPlnLookup(Array.from(new Set(foreign.map((t) => t.currency))), minDate)
      : (((cur: string) => (cur.toUpperCase() === 'PLN' ? 1 : null)) as FxToPlnLookup);
  convertClosedTradesToPln(trades, lookup);
}
