/**
 * Czysta transformacja spin-offów — lustro `adjustTransactionsForSplits`.
 *
 * Spin-off (wydzielenie): posiadacz akcji rodzica na koniec sesji przed ex-date
 * otrzymuje `ratio` akcji dziecka za każdą akcję rodzica; akcje rodzica NIE są
 * unicestwiane. Koszt nabycia rodzica dzieli się proporcjonalnie między rodzica
 * a dziecko (zamrożony `allocationPct` z tabeli `spin_offs`).
 *
 * Transformacja działa w compute-time na strumieniu transakcji JUŻ skorygowanym
 * o splity i jest aplikowana w tych samych trzech miejscach silnika co korekta
 * splitów (computeOpenPositions / computeClosedTrades / computePortfolioHistory),
 * dzięki czemu wszystkie widoki są spójne. Nic nie jest zapisywane do tabeli
 * `transactions`.
 *
 * Niezmienniki (pilnowane testami):
 *  - ilość rodzica bez zmian; koszt rodzica zredukowany o allocationPct od ex-date,
 *  - dziecko pojawia się na ex-date z kosztem = przeniesiona część kosztu rodzica,
 *  - ZERO zmiany cash na ex-date — syntetyczny zakup dziecka ma `total = 0`,
 *    a oba tory cash (computeCashBalances i pętla cash-flow historii) liczą
 *    wyłącznie z `tx.total`; sumy `total` przepisanych lotów rodzica niezmienione,
 *  - ZERO realized P&L — żadna sprzedaż nie powstaje; sprzedaże sprzed ex
 *    konsumują części lotów z ORYGINALNĄ ceną (podział lotu A/B poniżej),
 *  - późniejsza sprzedaż dziecka FIFO-uje z wstrzykniętym kosztem.
 */
import type { Transaction, AppliedSpinOff, DetectedSplit } from 'shared';
import { adjustTransactionsForSplits } from './split-detector.js';

const EPSILON = 1e-9;

/** Wpis guardu detekcji splitów — akceptuje wiersze spin_offs i wpisy mapy. */
export interface SpinOffGuardEvent {
  parentIsin?: string;
  parentTicker?: string;
  childIsin?: string;
  childTicker?: string;
  exDate: string;
}

/** Okno wokół ex-date, w którym detekcje splitu rodzica są odrzucane. */
const GUARD_WINDOW_DAYS = 30;

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(`${a}T12:00:00Z`).getTime() - new Date(`${b}T12:00:00Z`).getTime());
  return ms / 86_400_000;
}

/**
 * Ilość akcji rodzica posiadanych na wejściu w ex-date (transakcje z date < exDate,
 * FIFO — sprzedaże konsumują najstarsze zakupy; pozycje krótkie nie dają prawa).
 * Wynik jest w skali strumienia wejściowego (po korekcie splitów).
 */
export function parentSharesAtExDate(
  transactions: Transaction[],
  parentIsin: string,
  exDate: string,
): number {
  const remaining = computeRemainingByBuyTx(transactions, parentIsin, exDate);
  let sum = 0;
  for (const r of remaining.values()) sum += r;
  return sum;
}

/**
 * Symulacja FIFO transakcji rodzica sprzed ex-date. Zwraca mapę: pre-ex transakcja
 * zakupu → ilość nieskonsumowana sprzedażami sprzed ex-date (czyli trzymana na ex).
 */
function computeRemainingByBuyTx(
  transactions: Transaction[],
  parentIsin: string,
  exDate: string,
): Map<Transaction, number> {
  const parentTxs = transactions
    .filter((tx) => tx.isin === parentIsin && tx.date.split('T')[0] < exDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  const queue: Array<{ tx: Transaction; remaining: number }> = [];
  let shortQty = 0;

  for (const tx of parentTxs) {
    if (tx.side === 'K') {
      let qty = tx.quantity;
      // Zakup najpierw domyka ewentualną pozycję krótką (jak computePositionMetrics)
      if (shortQty > 0) {
        const cover = Math.min(shortQty, qty);
        shortQty -= cover;
        qty -= cover;
      }
      if (qty > EPSILON) queue.push({ tx, remaining: qty });
    } else {
      let toConsume = tx.quantity;
      while (toConsume > EPSILON && queue.length > 0) {
        const head = queue[0];
        if (head.remaining <= toConsume + EPSILON) {
          toConsume -= head.remaining;
          head.remaining = 0;
          queue.shift();
        } else {
          head.remaining -= toConsume;
          toConsume = 0;
        }
      }
      if (toConsume > EPSILON) shortQty += toConsume; // short — bez prawa do dziecka
    }
  }

  const result = new Map<Transaction, number>();
  for (const { tx, remaining } of queue) {
    if (remaining > EPSILON) result.set(tx, remaining);
  }
  return result;
}

/**
 * Aplikuje spin-offy (tylko wiersze `status === 'applied'`) do strumienia transakcji
 * skorygowanego o splity. Zwraca nowy strumień:
 *  - loty rodzica trzymane na ex mają cenę ×(1 - allocationPct); lot częściowo
 *    skonsumowany sprzedażą sprzed ex jest dzielony na dwie sąsiednie transakcje —
 *    część skonsumowaną A z ceną oryginalną (pierwszą, żeby stabilne sortowanie
 *    zachowało kolejność FIFO) i część pozostałą B z ceną obniżoną,
 *  - na ex-date wstrzykiwany jest syntetyczny zakup dziecka (per waluta lotów)
 *    z `total = 0` (cash-neutralny) i kosztem = przeniesiona część kosztu rodzica.
 *
 * `splits` — pełna lista splitów użyta do korekty strumienia; potrzebna, by
 * (a) przeliczyć ilość rodzica na ex do realnej skali, gdy rodzic miał split PO
 * ex-date, oraz (b) przeskalować wstrzykniętą transakcję dziecka o splity dziecka
 * (transformacja działa już PO adjustTransactionsForSplits).
 */
export function applySpinOffs(
  transactions: Transaction[],
  spinOffs: AppliedSpinOff[],
  splits: DetectedSplit[] = [],
): Transaction[] {
  const active = spinOffs
    .filter((so) => so.status === 'applied')
    .sort((a, b) => a.exDate.localeCompare(b.exDate));
  if (active.length === 0) return transactions;

  let working = transactions;

  for (const so of active) {
    const frac = so.allocationPct;
    if (!(frac > 0) || frac >= 1) continue;

    const remainingByTx = computeRemainingByBuyTx(working, so.parentIsin, so.exDate);
    let qtyAtEx = 0;
    for (const r of remainingByTx.values()) qtyAtEx += r;
    if (qtyAtEx <= EPSILON) continue; // rodzic sprzedany przed ex → no-op

    // Splity rodzica PO ex-date: strumień jest w skali post-split, a prawo do
    // dziecka naliczało się od realnej liczby akcji na ex → cofamy skalowanie.
    let laterParentSplitProduct = 1;
    for (const s of splits) {
      if (s.isin === so.parentIsin && s.date > so.exDate) laterParentSplitProduct *= s.ratio;
    }
    const realQtyAtEx = qtyAtEx / laterParentSplitProduct;

    // Przepisanie lotów rodzica + koszt przeniesiony per waluta
    const movedByCurrency = new Map<string, number>();
    const next: Transaction[] = [];
    for (const tx of working) {
      const r = remainingByTx.get(tx);
      if (r === undefined) {
        next.push(tx);
        continue;
      }
      const moved = frac * r * tx.price;
      movedByCurrency.set(tx.currency, (movedByCurrency.get(tx.currency) ?? 0) + moved);

      if (r >= tx.quantity - EPSILON) {
        // Lot w całości trzymany na ex — sama redukcja ceny
        next.push({ ...tx, price: tx.price * (1 - frac) });
      } else {
        // Lot częściowo skonsumowany przed ex — podział A (skonsumowana, cena
        // oryginalna, PIERWSZA dla FIFO) + B (pozostała, cena obniżona).
        const consumed = tx.quantity - r;
        const fA = consumed / tx.quantity;
        const fB = r / tx.quantity;
        next.push({
          ...tx,
          quantity: consumed,
          value: tx.value * fA,
          total: tx.total * fA,
          commission: tx.commission * fA,
        });
        next.push({
          ...tx,
          id: undefined,
          quantity: r,
          price: tx.price * (1 - frac),
          value: tx.value * fB,
          total: tx.total * fB,
          commission: tx.commission * fB,
        });
      }
    }

    // Syntetyczny zakup dziecka — per waluta lotów (w praktyce jedna); ilość
    // dzielona proporcjonalnie do udziału przeniesionego kosztu.
    let movedTotal = 0;
    for (const m of movedByCurrency.values()) movedTotal += m;
    const childQtyTotal = realQtyAtEx * so.ratio;
    const sourceTx = [...remainingByTx.keys()][0];

    if (movedTotal > EPSILON && childQtyTotal > EPSILON) {
      const childTxs: Transaction[] = [];
      for (const [currency, moved] of movedByCurrency) {
        const qty = childQtyTotal * (moved / movedTotal);
        if (qty <= EPSILON) continue;
        childTxs.push({
          date: so.exDate,
          paperName: so.childName ?? so.childTicker,
          isin: so.childIsin,
          quantity: qty,
          side: 'K',
          price: moved / qty,
          value: moved,
          commission: 0,
          // total = 0 → zdarzenie bezgotówkowe. Oba tory cash silnika liczą
          // wyłącznie z tx.total, więc spin-off nie tworzy fantomowego wypływu.
          total: 0,
          currency,
          source: sourceTx?.source ?? 'manual',
          category: 'stock',
          syntheticOrigin: `Spin-off: ${so.parentTicker} → ${so.childTicker} (${so.ratio}:1, ex ${so.exDate}) — przeniesiono ${(frac * 100).toFixed(1)}% kosztu nabycia`,
        });
      }
      // Splity DZIECKA po ex-date — strumień wejściowy był już skorygowany,
      // więc świeżo wstrzykniętą transakcję skalujemy tutaj.
      const childSplits = splits.filter((s) => s.isin === so.childIsin);
      next.push(...adjustTransactionsForSplits(childTxs, childSplits));
    }

    working = next;
  }

  return working;
}

/**
 * Guard C: odrzuca detekcje splitów będące artefaktem spin-offu.
 *  - `kind='price'`  — spadek kursu rodzica po ex wygląda jak reverse split
 *    (Yahoo potrafi wręcz opublikować ułamkowy "split" dla spin-offu):
 *    odrzucamy detekcje na rodzicu w oknie ±30 dni od ex-date.
 *  - `kind='quantity'` — sprzedaż dziecka bez syntetycznego zakupu w surowym
 *    strumieniu wygląda jak mismatch ilości: odrzucamy detekcje na dziecku
 *    (dowolna data) oraz na rodzicu w oknie.
 * Przyjmuje zarówno wiersze `spin_offs` (każdy status — znane zdarzenie jest
 * hazardem niezależnie od aplikacji), jak i wpisy mapy jeszcze niezastosowane.
 */
export function filterDetectedSplitsForSpinOffs<
  T extends { isin: string; date: string; ticker?: string },
>(detected: T[], spinOffs: SpinOffGuardEvent[], kind: 'price' | 'quantity'): T[] {
  if (spinOffs.length === 0 || detected.length === 0) return detected;

  const matchesParent = (d: T, so: SpinOffGuardEvent): boolean => {
    if (so.parentIsin && d.isin === so.parentIsin) return true;
    return !!(
      so.parentTicker &&
      d.ticker &&
      d.ticker.toUpperCase() === so.parentTicker.toUpperCase()
    );
  };
  const matchesChild = (d: T, so: SpinOffGuardEvent): boolean => {
    if (so.childIsin && d.isin === so.childIsin) return true;
    return !!(
      so.childTicker &&
      d.ticker &&
      d.ticker.toUpperCase() === so.childTicker.toUpperCase()
    );
  };

  return detected.filter((d) => {
    for (const so of spinOffs) {
      if (matchesParent(d, so) && daysBetween(d.date, so.exDate) <= GUARD_WINDOW_DAYS) {
        return false;
      }
      if (kind === 'quantity' && matchesChild(d, so)) {
        return false;
      }
    }
    return true;
  });
}
