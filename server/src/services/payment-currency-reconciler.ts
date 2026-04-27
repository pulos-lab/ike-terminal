import type { Transaction, CashOperation } from 'shared';
import { getAllTransactions, updateTransaction } from '../db/transactions-repo.js';
import { getAllOperations } from '../db/operations-repo.js';

/**
 * Reconcile `paymentCurrency` on Bossa and DEGIRO transactions by simulating
 * a per-currency cash ledger from the full history of operations + transactions.
 *
 * Why: Bossa and DEGIRO parsers today hardcode `paymentCurrency` (PLN for Bossa,
 * EUR for DEGIRO) assuming single-currency accounts. In reality both brokers
 * support multi-currency sub-balances — a Polish Bossa IKE user can exchange
 * PLN → USD and then pay for US stocks directly from their USD balance, in
 * which case `paymentCurrency = 'USD'`, not `'PLN'`.
 *
 * Algorithm (per source): build a chronological event stream (operations
 * sorted before transactions on the same date), maintain a Map<currency, number>
 * balance, and for each buy decide whether the quote-currency balance is
 * sufficient to cover it. If yes → `paymentCurrency = quoteCurrency` (direct
 * settlement). If no → `paymentCurrency = baseCurrency` (auto-FX fallback).
 *
 * Idempotent: only writes when the computed value differs from what's in DB.
 */

export type ReconcileSource = 'bossa' | 'degiro';

export interface ReconcileResult {
  /** Number of transactions whose payment_currency was changed. */
  updatedCount: number;
  /** Human-readable warnings about data gaps (e.g. negative base-currency balance). */
  warnings: string[];
}

/** Base (account) currency per broker. For auto-FX fallbacks. */
const BASE_CURRENCY: Record<ReconcileSource, string> = {
  bossa: 'PLN',
  degiro: 'EUR',
};

/** Tolerance for rounding when comparing balances with transaction totals.
 *  FX rates like 3,6948 combined with multi-share amounts can produce tiny
 *  residuals; we treat anything within 0.01 as sufficient. */
const BALANCE_EPSILON = 0.01;

type LedgerEvent =
  | { kind: 'op'; sortKey: string; op: CashOperation }
  | { kind: 'tx'; sortKey: string; tx: Transaction };

/** Produce a stable sort key: date → op-before-tx (same date) → id as tiebreaker. */
function buildSortKey(kind: 'op' | 'tx', date: string, id: number | undefined): string {
  const iso = date.length === 10 ? `${date}T00:00:00` : date;
  const typePrefix = kind === 'op' ? '0' : '1';
  const idStr = String(id ?? 0).padStart(10, '0');
  return `${iso}|${typePrefix}|${idStr}`;
}

/** Core simulation — pure function, testable in isolation. */
export function simulateLedger(
  transactions: Transaction[],
  operations: CashOperation[],
  baseCurrency: string,
): { computed: Map<number, string>; warnings: string[] } {
  const events: LedgerEvent[] = [];
  for (const op of operations) {
    events.push({ kind: 'op', sortKey: buildSortKey('op', op.date, op.id), op });
  }
  for (const tx of transactions) {
    // CFD transactions are not settled through cash ledger — skip entirely.
    if (tx.category === 'cfd') continue;
    // Transactions without id can't be updated in DB; skip to avoid confusion.
    if (tx.id === undefined) continue;
    events.push({ kind: 'tx', sortKey: buildSortKey('tx', tx.date, tx.id), tx });
  }
  events.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  const balance = new Map<string, number>();
  const addBalance = (ccy: string, amount: number) => {
    balance.set(ccy, (balance.get(ccy) ?? 0) + amount);
  };

  const computed = new Map<number, string>();
  const warnings: string[] = [];

  for (const ev of events) {
    if (ev.kind === 'op') {
      // Deposits (+), withdrawals (−), fx_exchange legs (± each per currency),
      // dividends (+), fees/trade_fee (−), commission_refund (+) — all already
      // carry the signed amount from the parser.
      addBalance(ev.op.currency, ev.op.amount);
      continue;
    }

    const tx = ev.tx;
    if (tx.side === 'K') {
      const quoteBalance = balance.get(tx.currency) ?? 0;
      if (quoteBalance >= tx.total - BALANCE_EPSILON) {
        // Direct settlement from the quote-currency sub-balance.
        computed.set(tx.id!, tx.currency);
        addBalance(tx.currency, -tx.total);
      } else {
        // Auto-FX fallback: broker converted baseCurrency → quoteCurrency.
        computed.set(tx.id!, baseCurrency);
        const fxRate = tx.fxRate && tx.fxRate > 0 ? tx.fxRate : 1;
        const prevBase = balance.get(baseCurrency) ?? 0;
        addBalance(baseCurrency, -tx.total * fxRate);
        const newBase = balance.get(baseCurrency) ?? 0;
        // Warning tylko przy przejściu ≥0 → <0 — kolejne tx w minusie to follow-up tej samej luki w CSV.
        if (prevBase >= -BALANCE_EPSILON && newBase < -BALANCE_EPSILON) {
          const date = tx.date.slice(0, 10);
          warnings.push(
            `Transakcja ${tx.paperName} ${date}: saldo ${baseCurrency} spadło poniżej zera ` +
              `(${newBase.toFixed(2)}) — brak pokrycia w CSV (możliwa brakująca wpłata/FX).`,
          );
        }
      }
    } else {
      // Sell — proceeds arrive in the quote currency; any subsequent FX is
      // recorded as a separate fx_exchange operation.
      computed.set(tx.id!, tx.currency);
      addBalance(tx.currency, tx.total);
    }
  }

  return { computed, warnings };
}

/** Reconcile paymentCurrency across the entire portfolio history for the
 *  given brokers. Reads current state from DB, computes expected values, and
 *  applies UPDATE only where they differ. */
export function reconcilePaymentCurrencies(
  portfolioId: string,
  sources: ReconcileSource[] = ['bossa', 'degiro'],
): ReconcileResult {
  let updatedCount = 0;
  const warnings: string[] = [];

  const allTx = getAllTransactions(portfolioId);
  const allOps = getAllOperations(portfolioId);

  for (const source of sources) {
    const baseCurrency = BASE_CURRENCY[source];
    const sourceTxs = allTx.filter((t) => t.source === source);
    const sourceOps = allOps.filter((o) => o.source === source);

    if (sourceTxs.length === 0) continue;

    const { computed, warnings: sourceWarnings } = simulateLedger(
      sourceTxs,
      sourceOps,
      baseCurrency,
    );

    for (const tx of sourceTxs) {
      if (tx.id === undefined) continue;
      const expected = computed.get(tx.id);
      if (!expected) continue;
      const current = tx.paymentCurrency ?? tx.currency;
      if (current !== expected) {
        updateTransaction(tx.id, { paymentCurrency: expected }, portfolioId);
        updatedCount++;
      }
    }

    if (sourceWarnings.length > 0) {
      warnings.push(...aggregateWarnings(source, sourceWarnings));
    }
  }

  return { updatedCount, warnings };
}

/** Przy > N warningach z jednego źródła: jeden zbiorczy komunikat + TOP5 przykładów.
 *  Systematyczna seria dziur najczęściej oznacza niekompletny eksport operacji,
 *  nie N niezależnych incydentów — użytkownik potrzebuje wskazówki, nie listy. */
const AGGREGATE_THRESHOLD = 10;
const TOP_EXAMPLES = 5;

function aggregateWarnings(source: ReconcileSource, sourceWarnings: string[]): string[] {
  if (sourceWarnings.length <= AGGREGATE_THRESHOLD) {
    return sourceWarnings.map((w) => `[${source}] ${w}`);
  }
  const examples = sourceWarnings
    .slice(0, TOP_EXAMPLES)
    .map((w) => `  • ${w}`)
    .join('\n');
  const summary =
    `[${source}] Wykryto ${sourceWarnings.length} transakcji z niepełnym pokryciem gotówki ` +
    `w walucie bazowej — prawdopodobnie niekompletny eksport operacji kasowych ` +
    `(brakujące wpłaty/FX/dywidendy).\nPierwsze ${TOP_EXAMPLES} przykładów:\n${examples}`;
  return [summary];
}
