/**
 * Auto-domknięcie opcji po terminie wygaśnięcia — transformacja compute-time (lustro
 * `spin-off-transform` / `adjustTransactionsForSplits`). Opcja, której termin minął, ale która
 * nie ma jawnej transakcji zamykającej (kody IBKR `Ep`/`Ex`/`A`), wisiałaby w nieskończoność
 * jako otwarta pozycja. Tutaj wstrzykujemy SYNTETYCZNĄ transakcję zamykającą w dniu wygaśnięcia,
 * po cenie rozliczenia (wartość wewnętrzna z kursu bazowego w dniu wygaśnięcia; OTM → 0).
 *
 * NIC nie jest zapisywane do tabeli `transactions` — transform stosują tylko `computeOpenPositions`
 * i `computeClosedTrades` na już-skorygowanym strumieniu (po splitach/spin-offach). Samokorygujące:
 * gdy zaimportujesz prawdziwy wiersz `Ep`/`Ex`/`A`, guard („istnieje tx w dniu ≥ wygaśnięcia")
 * sprawia, że syntetyk się nie odpala, a FIFO domyka pozycję realnym wierszem.
 *
 * Historia (`computePortfolioHistory`) NIE używa tego transformu — sama zeruje/wycenia opcje po
 * wygaśnięciu wartością wewnętrzną (portfolio-engine, pętla intrinsic per dzień).
 */
import type { OptionContract, Transaction } from 'shared';
import { optionIntrinsicValue } from 'shared';
import { fetchYahooHistory, fetchYahooSplitEvents } from './yahoo-finance.js';

const EPS = 1e-9;
const round2 = (x: number): number => Math.round(x * 100) / 100;
const dayOf = (isoDate: string): string => isoDate.slice(0, 10);

interface ExpiredOpenOption {
  isin: string;
  contract: OptionContract;
  /** Ilość netto otwarta (dodatnia). */
  qty: number;
  /** Strona domykająca: 'S' gdy long netto, 'K' gdy short netto. */
  closingSide: 'K' | 'S';
  /** Pierwsza transakcja grupy (paperName / source do syntetyka). */
  sample: Transaction;
}

/**
 * Znajdź opcje po terminie z niezerową pozycją netto i BEZ transakcji zamykającej w dniu ≥
 * wygaśnięcia. Pozycja netto = Σ(K) − Σ(S); dla opcji nie ma jednoczesnego long+short, więc
 * znak netto jednoznacznie daje kierunek (bez potrzeby pełnego FIFO).
 */
function findExpiredOpenOptions(
  transactions: Transaction[],
  optionContracts: Map<string, OptionContract>,
  asOf: string,
): ExpiredOpenOption[] {
  const byIsin = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (tx.category !== 'option') continue;
    const arr = byIsin.get(tx.isin);
    if (arr) arr.push(tx);
    else byIsin.set(tx.isin, [tx]);
  }

  const out: ExpiredOpenOption[] = [];
  for (const [isin, txs] of byIsin) {
    const contract = optionContracts.get(isin);
    if (!contract) continue; // brak metadanych (expiry) — nie ruszamy
    if (!(contract.expiry < asOf)) continue; // żyje w dniu wygaśnięcia; bezwartościowa dzień PO
    // Guard: realny Ep/Ex/A (jakikolwiek wiersz w dniu ≥ wygaśnięcia) już domyka przez FIFO.
    if (txs.some((t) => dayOf(t.date) >= contract.expiry)) continue;

    let net = 0;
    for (const t of txs) net += t.side === 'K' ? t.quantity : -t.quantity;
    if (Math.abs(net) < EPS) continue; // już zamknięta przed terminem

    out.push({
      isin,
      contract,
      qty: Math.abs(net),
      closingSide: net > 0 ? 'S' : 'K',
      sample: txs[0],
    });
  }
  return out;
}

/**
 * Ceny rozliczenia (wartość wewnętrzna w dniu wygaśnięcia) dla opcji, które auto-domkniemy.
 * Kurs bazowego z Yahoo na dzień ≤ wygaśnięcia; ceny historyczne Yahoo są SKORYGOWANE o splity,
 * a strike jest w skali z dnia handlu — sprowadzamy kurs do skali strike'a mnożąc przez iloczyn
 * ratio splitów PO wygaśnięciu (identycznie jak pętla intrinsic w `computePortfolioHistory`).
 * Brak notowań (np. Eurex) → brak wpisu → transform spadnie na 0 (bezwartościowa).
 * Zwracana mapa jest idempotentna i cache'owalna (ceny w przeszłości są niezmienne).
 */
export async function resolveOptionExpirySettlements(
  transactions: Transaction[],
  optionContracts: Map<string, OptionContract>,
  asOf: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const candidates = findExpiredOpenOptions(transactions, optionContracts, asOf);
  if (candidates.length === 0) return out;

  await Promise.all(
    candidates.map(async ({ isin, contract }) => {
      const underlying = contract.underlying;
      const expiry = contract.expiry;
      // Okno ~10 dni przed wygaśnięciem (weekend/święto → ostatni close ≤ expiry).
      const start = new Date(new Date(`${expiry}T00:00:00Z`).getTime() - 10 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const [hist, splitEvents] = await Promise.all([
        fetchYahooHistory(underlying, start, expiry),
        fetchYahooSplitEvents(underlying, expiry), // zdarzenia od wygaśnięcia do dziś
      ]);
      const onOrBefore = hist.filter((d) => d.date <= expiry);
      if (onOrBefore.length === 0) return; // brak kursu → fallback 0
      const close = onOrBefore[onOrBefore.length - 1].close;
      let scale = 1;
      for (const e of splitEvents) if (e.date > expiry) scale *= e.ratio;
      out.set(isin, optionIntrinsicValue(contract.optionType, close * scale, contract.strike));
    }),
  );
  return out;
}

/**
 * Zwraca NOWĄ tablicę transakcji z dostrzykniętymi syntetycznymi zamknięciami opcji po terminie.
 * `settlementPrices` (isin → cena intrinsic) z `resolveOptionExpirySettlements`; brak wpisu → 0.
 * Czysta, synchroniczna; nie mutuje wejścia.
 */
export function expireOptions(
  transactions: Transaction[],
  optionContracts: Map<string, OptionContract>,
  asOf: string,
  settlementPrices?: Map<string, number>,
): Transaction[] {
  const expired = findExpiredOpenOptions(transactions, optionContracts, asOf);
  if (expired.length === 0) return transactions;

  const synthetics: Transaction[] = expired.map(({ isin, contract, qty, closingSide, sample }) => {
    const price = settlementPrices?.get(isin) ?? 0;
    return {
      date: contract.expiry,
      paperName: sample.paperName,
      isin,
      quantity: qty,
      side: closingSide,
      price,
      value: round2(price * qty),
      commission: 0,
      // total = 0 → zdarzenie bezgotówkowe (oba tory cash liczą z tx.total; jak spin-off).
      total: 0,
      currency: contract.currency,
      paymentCurrency: contract.currency,
      category: 'option',
      source: sample.source,
      syntheticOrigin: `Wygaśnięcie opcji ${contract.occTicker} (${contract.expiry}) — auto-domknięcie po terminie${
        price > EPS ? `, wartość wewnętrzna ${round2(price)}` : ' (bezwartościowa)'
      }`,
    };
  });

  return [...transactions, ...synthetics];
}
