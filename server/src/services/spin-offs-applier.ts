/**
 * Automatyczna aplikacja spin-offów do portfela — "jeśli wpis jest w źródłach,
 * spin-off się dokonuje" (bez zatwierdzeń). Wołany przy budowaniu widoków
 * pozycji/historii; przy braku kandydatów kończy się na tanich lokalnych
 * bramkach (zero sieci).
 *
 * Kandydaci: statyczna `SPIN_OFF_MAP` (shared) ∪ globalna tabela `spinoff_events`
 * (scraper — Faza 3). Zastosowane zdarzenie ląduje w per-portfelowej tabeli
 * `spin_offs` z ZAMROŻONYM `allocationPct` — jedyną wielkością zależną od cen,
 * więc późniejsze zmiany cache'u cen nie zmieniają wstecznie wyniku.
 *
 * Guardy pełnej automatyki (zamiast ludzkiej weryfikacji):
 *  - dziecko musi być resolvowalne u dostawcy cen (inaczej defer, retry ≥1h),
 *  - alokacja z realnych cen (post-ex rodzic + pierwszy print dziecka),
 *    clamp do [0.001, 0.9]; brak ceny → defer, zero częściowych zapisów,
 *  - dedup vs broker: realne zaksięgowanie dziecka wygrywa (skipped_broker),
 *  - idempotencja: UNIQUE(parent_isin, ex_date) + ON CONFLICT DO NOTHING,
 *  - odwracalność: DELETE w UI ustawia status 'reverted' (tombstone).
 */
import type { Transaction, TickerMapEntry, DetectedSplit, AppliedSpinOff } from 'shared';
import { SPIN_OFF_MAP, type SpinOffMapEntry } from 'shared';
import { getSpinOffs, insertSpinOff, updateSpinOffStatus } from '../db/spin-offs-repo.js';
import { getTickerBySymbol, upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import { bumpPortfolioDataVersion } from '../db/data-version.js';
import { invalidateCachedPrices } from './history-cache.js';
import { fetchYahooPrice, fetchYahooHistoryDirect } from './yahoo-finance.js';
import { fetchYahooTickerName } from './ticker-search.js';
import { adjustTransactionsForSplits } from './split-detector.js';
import { parentSharesAtExDate } from './spin-off-transform.js';

/** Okno dopasowania realnych transakcji dziecka wokół ex-date (dni). */
const BROKER_DEDUP_WINDOW_DAYS = 14;
/** Próg pokrycia (ułamek oczekiwanej ilości), od którego broker wygrywa. */
const BROKER_DEDUP_COVERAGE = 0.9;
/** Backoff nieudanych prób sieciowych per zdarzenie (ticker dziecka bez notowań itp.). */
const DEFER_RETRY_MS = 60 * 60 * 1000;

/** Clamp frakcji alokacji — poza tym zakresem cena jest podejrzana, nie aplikujemy. */
const MIN_ALLOC = 0.001;
const MAX_ALLOC = 0.9;

/** In-memory: ostatnia nieudana próba sieciowa per (pid|parent|exDate). */
const deferredUntil = new Map<string, number>();

export interface SpinOffApplyResult {
  appliedNow: AppliedSpinOff[];
}

function isoDaysDiff(a: string, b: string): number {
  return Math.abs(
    (new Date(`${a}T12:00:00Z`).getTime() - new Date(`${b}T12:00:00Z`).getTime()) / 86_400_000,
  );
}

/**
 * Suma realnych (nie syntetycznych) zakupów dziecka w oknie wokół ex-date —
 * sygnał, że broker sam zaksięgował dystrybucję i syntetyk ma się wycofać.
 */
function realChildBuyQty(
  transactions: Transaction[],
  childIsin: string,
  childTicker: string,
  exDate: string,
): number {
  let sum = 0;
  for (const tx of transactions) {
    if (tx.side !== 'K' || tx.syntheticOrigin) continue;
    const matchesChild =
      tx.isin === childIsin ||
      tx.paperName?.toUpperCase() === childTicker.toUpperCase() ||
      tx.isin === `AUTO_${childTicker.toUpperCase()}`;
    if (!matchesChild) continue;
    if (isoDaysDiff(tx.date.split('T')[0], exDate) <= BROKER_DEDUP_WINDOW_DAYS) {
      sum += tx.quantity;
    }
  }
  return sum;
}

/** Kandydaci zdarzeń dla portfela: mapa statyczna (Faza 3 dokłada tabelę spinoff_events). */
function collectCandidates(override?: SpinOffMapEntry[]): SpinOffMapEntry[] {
  return override ?? SPIN_OFF_MAP;
}

/** Znajdź wpis rodzica w ticker_map portfela (po ISIN gdy znany, inaczej po tickerze). */
function findParentEntry(
  tickerMap: Map<string, TickerMapEntry>,
  candidate: SpinOffMapEntry,
): TickerMapEntry | null {
  if (candidate.parentIsin) {
    const byIsin = tickerMap.get(candidate.parentIsin);
    if (byIsin) return byIsin;
  }
  const t = candidate.parentTicker.toUpperCase();
  for (const entry of tickerMap.values()) {
    if (entry.ticker.toUpperCase() === t) return entry;
  }
  return null;
}

/**
 * Resolwuje ticker dziecka do wpisu ticker_map (tworzy wpis z Yahoo gdy brak) —
 * lustro auto-create z POST /transactions. Zwraca null gdy Yahoo (jeszcze) nie
 * zna tickera — wtedy defer.
 */
async function resolveChildEntry(
  pid: string,
  candidate: SpinOffMapEntry,
): Promise<TickerMapEntry | null> {
  const existing = getTickerBySymbol(candidate.childTicker, pid);
  if (existing) return existing;

  const [yahooData, yahooName] = await Promise.all([
    fetchYahooPrice(candidate.childTicker),
    fetchYahooTickerName(candidate.childTicker),
  ]);
  if (!yahooData) return null;

  const upperTicker = candidate.childTicker.toUpperCase();
  const newEntry: TickerMapEntry = {
    isin: candidate.childIsin ?? `AUTO_${upperTicker}`,
    ticker: upperTicker,
    name: candidate.childName ?? yahooName ?? upperTicker,
    exchange: 'OTHER',
    currency: yahooData.currency || 'USD',
    priceSource: 'yahoo',
  };
  if (upperTicker.endsWith('.WA')) {
    newEntry.exchange = 'GPW';
    newEntry.currency = 'PLN';
    newEntry.priceSource = 'stooq';
  }
  upsertTickerMapEntry(newEntry, pid);
  return newEntry;
}

/**
 * Skanuje kandydatów i aplikuje zaległe spin-offy do portfela. Bezpieczne do
 * wołania przy każdym budowaniu widoku: tanie lokalne bramki, sieć tylko gdy
 * istnieje niezastosowane zdarzenie (z backoffem po porażce), a bump wersji
 * danych wyłącznie przy realnym insercie/mutacji.
 */
export async function applyPendingSpinOffs(
  pid: string,
  transactions: Transaction[],
  tickerMap: Map<string, TickerMapEntry>,
  savedSplits: DetectedSplit[],
  /** Override listy kandydatów — wyłącznie dla testów. */
  candidatesOverride?: SpinOffMapEntry[],
): Promise<SpinOffApplyResult> {
  const appliedNow: AppliedSpinOff[] = [];
  const today = new Date().toISOString().split('T')[0];
  const existing = getSpinOffs(pid);

  // ── Problem D cz. 2: broker zaksięgował dziecko PO naszej aplikacji ──
  // Realne wiersze zawsze wygrywają — syntetyk cicho się wycofuje.
  for (const row of existing) {
    if (row.status !== 'applied') continue;
    const realQty = realChildBuyQty(transactions, row.childIsin, row.childTicker, row.exDate);
    if (realQty >= BROKER_DEDUP_COVERAGE * row.childQty && row.childQty > 0 && row.id) {
      updateSpinOffStatus(pid, row.id, 'skipped_broker');
      bumpPortfolioDataVersion(pid);
      console.log(
        `[spin-offs] ${row.parentTicker}→${row.childTicker} (${row.exDate}): broker zaksięgował ` +
          `${realQty} szt. dziecka — syntetyk wycofany (skipped_broker)`,
      );
    }
  }

  // ── Aplikacja nowych zdarzeń ──
  const adjustedTxs = adjustTransactionsForSplits(transactions, savedSplits);

  for (const candidate of collectCandidates(candidatesOverride)) {
    // Tania bramka 1: zdarzenie z przyszłości
    if (candidate.exDate > today) continue;

    // Tania bramka 2: rodzic nieobecny w portfelu
    const parentEntry = findParentEntry(tickerMap, candidate);
    if (!parentEntry) continue;
    const parentIsin = parentEntry.isin;

    // Tania bramka 3: zdarzenie już rozstrzygnięte (każdy status — 'reverted'
    // jest tombstone'em blokującym ponowną auto-aplikację)
    if (existing.some((r) => r.parentIsin === parentIsin && r.exDate === candidate.exDate)) {
      continue;
    }

    // Tania bramka 4: brak akcji rodzica na ex (w skali post-split strumienia)
    const qtyAtExAdjusted = parentSharesAtExDate(adjustedTxs, parentIsin, candidate.exDate);
    if (qtyAtExAdjusted <= 0) continue;

    // Realna liczba akcji na ex: cofnij splity rodzica zaszłe PO ex-date
    let laterSplitProduct = 1;
    for (const s of savedSplits) {
      if (s.isin === parentIsin && s.date > candidate.exDate) laterSplitProduct *= s.ratio;
    }
    const realQtyAtEx = qtyAtExAdjusted / laterSplitProduct;
    const expectedChildQty = realQtyAtEx * candidate.ratio;

    // Waluta lotów rodzica (dla opisu w wierszu)
    const parentBuy = adjustedTxs.find((t) => t.isin === parentIsin && t.side === 'K');
    const currency = parentBuy?.currency ?? parentEntry.currency ?? 'USD';

    // ── Problem D cz. 1: broker już zaksięgował dziecko → skipped_broker ──
    const childIsinGuess = candidate.childIsin ?? `AUTO_${candidate.childTicker.toUpperCase()}`;
    const preRealQty = realChildBuyQty(
      transactions,
      childIsinGuess,
      candidate.childTicker,
      candidate.exDate,
    );
    if (preRealQty >= BROKER_DEDUP_COVERAGE * expectedChildQty) {
      const inserted = insertSpinOff(pid, {
        parentIsin,
        parentTicker: parentEntry.ticker,
        childIsin: childIsinGuess,
        childTicker: candidate.childTicker.toUpperCase(),
        childName: candidate.childName,
        exDate: candidate.exDate,
        ratio: candidate.ratio,
        allocationPct: 0,
        childQty: expectedChildQty,
        currency,
        status: 'skipped_broker',
        source: 'map',
      });
      if (inserted) bumpPortfolioDataVersion(pid);
      continue;
    }

    // ── Ścieżka sieciowa (backoff po porażce) ──
    const deferKey = `${pid}|${parentIsin}|${candidate.exDate}`;
    const deferredTs = deferredUntil.get(deferKey);
    if (deferredTs && Date.now() - deferredTs < DEFER_RETRY_MS) continue;

    // Resolve tickera dziecka (+ auto ticker_map). Yahoo nie zna → defer.
    const childEntry = await resolveChildEntry(pid, candidate);
    if (!childEntry) {
      deferredUntil.set(deferKey, Date.now());
      console.warn(
        `[spin-offs] ${candidate.parentTicker}→${candidate.childTicker} (${candidate.exDate}): ` +
          `ticker dziecka nieznany u dostawcy — odraczam (retry ≥1h)`,
      );
      continue;
    }

    // Frakcja alokacji kosztu: jawny override z mapy albo z cen rynkowych
    let frac: number;
    let parentPriceUsed: number | undefined;
    let childPriceUsed: number | undefined;
    if (candidate.costAllocPct !== undefined) {
      frac = candidate.costAllocPct;
    } else {
      // Cache-bypass (jak detekcja splitów): trwały cache może trzymać ceny
      // sprzed retro-korekty Yahoo po spin-offie.
      const [parentPx, childPx] = await Promise.all([
        fetchYahooHistoryDirect(parentEntry.ticker, candidate.exDate),
        fetchYahooHistoryDirect(childEntry.ticker, candidate.exDate),
      ]);
      if (!parentPx || !childPx || parentPx <= 0 || childPx <= 0) {
        deferredUntil.set(deferKey, Date.now());
        console.warn(
          `[spin-offs] ${candidate.parentTicker}→${candidate.childTicker} (${candidate.exDate}): ` +
            `brak cen do alokacji (parent=${parentPx}, child=${childPx}) — odraczam (retry ≥1h)`,
        );
        continue;
      }
      // parentPx to close z ex-date (już bez wartości dziecka) lub pierwszy
      // dostępny po nim — formuła post-ex.
      frac = (candidate.ratio * childPx) / (parentPx + candidate.ratio * childPx);
      parentPriceUsed = parentPx;
      childPriceUsed = childPx;
    }

    if (!(frac >= MIN_ALLOC && frac <= MAX_ALLOC)) {
      deferredUntil.set(deferKey, Date.now());
      console.warn(
        `[spin-offs] ${candidate.parentTicker}→${candidate.childTicker}: frakcja alokacji ` +
          `${frac.toFixed(4)} poza [${MIN_ALLOC}, ${MAX_ALLOC}] — podejrzane ceny, odraczam`,
      );
      continue;
    }

    // ── Zamrożenie + side-effecty (tylko gdy insert faktycznie zaszedł) ──
    const row: AppliedSpinOff = {
      parentIsin,
      parentTicker: parentEntry.ticker,
      childIsin: childEntry.isin,
      childTicker: childEntry.ticker,
      childName: candidate.childName ?? childEntry.name,
      exDate: candidate.exDate,
      ratio: candidate.ratio,
      allocationPct: frac,
      childQty: expectedChildQty,
      currency,
      parentPriceUsed,
      childPriceUsed,
      status: 'applied',
      source: 'map',
    };
    const inserted = insertSpinOff(pid, row);
    if (inserted) {
      // Yahoo potrafi retro-skorygować historię rodzica po spin-offie —
      // lustro persistNewSplits.
      invalidateCachedPrices(parentEntry.ticker);
      bumpPortfolioDataVersion(pid);
      deferredUntil.delete(deferKey);
      appliedNow.push(row);
      console.log(
        `[spin-offs] Zastosowano ${row.parentTicker}→${row.childTicker} (${row.exDate}): ` +
          `${expectedChildQty} szt. dziecka, alokacja ${(frac * 100).toFixed(1)}% kosztu rodzica`,
      );
    }
  }

  return { appliedNow };
}

/** Reset stanu backoffu — wyłącznie dla testów. */
export function _resetSpinOffDeferrals(): void {
  deferredUntil.clear();
}
