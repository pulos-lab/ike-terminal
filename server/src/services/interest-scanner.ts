/**
 * Skaner oprocentowania wolnych środków.
 *
 * Na podstawie ustawień portfela (`settings.freeCashInterest` — stawka roczna per
 * waluta + opcjonalny cap) miesięcznie dopisuje operacje odsetkowe do bazy:
 * `operationType:'other'` + `subkind:'interest'`, `source:'auto-interest'`,
 * `importBatch:'auto-interest'`. Dzięki temu odsetki są widoczne/edytowalne w panelu
 * „Korekty i koszty" i automatycznie wchodzą do salda gotówki oraz wartości portfela
 * (oba tory cash — `computeCashBalances` i `computePortfolioHistory` — czytają
 * operacje z DB), bez żadnych zmian w silniku.
 *
 * Idempotencja przez delete-and-recompute: wiersze auto-odsetek są oznaczone
 * `importBatch:'auto-interest'`, liczymy pełny, deterministyczny zestaw i piszemy do
 * bazy TYLKO gdy różni się od aktualnego (brak churnu `dataVersion`).
 *
 * Model naliczania: dzienne naliczanie ACT/365 na saldzie końca dnia, kapitalizacja
 * miesięczna (rata księgowana na koniec miesiąca podnosi saldo kolejnych miesięcy).
 * Księgujemy tylko ZAMKNIĘTE miesiące (bieżący, niepełny — po jego zamknięciu).
 * Odsetki tylko od DODATNIEGO salda; saldo ujemne (margin) pomijane. Jeśli w danym
 * miesiącu+walucie istnieje zaimportowana operacja odsetkowa (`subkind:'interest'`),
 * pomijamy syntetyczne naliczenie (realne wiersze brokera wygrywają).
 *
 * Reguły znaku salda są lustrem `computeCashBalances` (portfolio-engine.ts): operacje
 * = `op.amount`; transakcje = `sign(K=-1,S=1) × total`, księgowane w `paymentCurrency`
 * po `fxRate` brokera gdy różna od waluty notowania.
 */
import { getAllPortfolios, getPortfolio } from '../db/portfolio-registry.js';
import { getAllTransactions } from '../db/transactions-repo.js';
import {
  getAllOperations,
  insertOperationsWithDedup,
  deleteOperationsByBatch,
  getMetadata,
  setMetadata,
} from '../db/operations-repo.js';
import { FREE_CASH_INTEREST_TAX_REGULAR, FREE_CASH_INTEREST_TAX_IKE_IKZE } from 'shared';
import type { CashOperation, FreeCashInterestRate, PortfolioSettings, Transaction } from 'shared';

/** Marker batcha auto-odsetek — klucz delete-and-recompute. */
export const AUTO_INTEREST_BATCH = 'auto-interest';

/** Podatek Belki od odsetek: 0% na IKE/IKZE, 19% na koncie zwykłym. */
export function interestTaxRate(settings: PortfolioSettings): number {
  return settings.isIKE || settings.isIKZE
    ? FREE_CASH_INTEREST_TAX_IKE_IKZE
    : FREE_CASH_INTEREST_TAX_REGULAR;
}

export interface InterestScanResult {
  /** Czy zestaw wierszy w bazie faktycznie się zmienił (wpłynął na dataVersion). */
  changed: boolean;
  /** Liczba wstawionych wierszy auto-odsetek po przeliczeniu. */
  emitted: number;
  errors: string[];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 'YYYY-MM' danego dnia. */
function monthOf(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/** Kolejny 'YYYY-MM'. */
function nextMonth(ym: string): string {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7)); // 1..12
  const nextY = month === 12 ? year + 1 : year;
  const nextM = month === 12 ? 1 : month + 1;
  return `${nextY}-${String(nextM).padStart(2, '0')}`;
}

/** Liczba dni w miesiącu 'YYYY-MM'. */
function daysInMonth(ym: string): number {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7)); // 1..12
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Dzień 'YYYY-MM-DD' w miesiącu. */
function dayOf(ym: string, day: number): string {
  return `${ym}-${String(day).padStart(2, '0')}`;
}

interface CashDelta {
  date: string; // YYYY-MM-DD
  currency: string; // uppercase
  amount: number;
}

/**
 * Datowane delty gotówki per waluta — lustro reguł `computeCashBalances`.
 * Zwraca posortowaną chronologicznie listę (stabilnie po dacie).
 */
export function buildCashDeltas(
  transactions: Transaction[],
  operations: CashOperation[],
): CashDelta[] {
  const deltas: CashDelta[] = [];

  for (const op of operations) {
    if (!op.currency) continue;
    deltas.push({ date: op.date, currency: op.currency.toUpperCase(), amount: op.amount });
  }

  for (const tx of transactions) {
    const sign = tx.side === 'K' ? -1 : 1;
    const quoteCcy = tx.currency.toUpperCase();
    const payCcy = (tx.paymentCurrency || tx.currency).toUpperCase();
    if (payCcy !== quoteCcy && tx.fxRate && tx.fxRate > 0) {
      deltas.push({ date: tx.date, currency: payCcy, amount: sign * round2(tx.total * tx.fxRate) });
    } else {
      deltas.push({ date: tx.date, currency: quoteCcy, amount: sign * tx.total });
    }
  }

  deltas.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return deltas;
}

interface ActiveRate {
  ratePct: number;
  cap: number; // 0 = bez limitu
}

/** Normalizuje ustawienia → mapa CUR → {ratePct, cap}; odrzuca stawki ≤ 0. */
function activeRatesFromSettings(
  rates: FreeCashInterestRate[] | undefined,
): Map<string, ActiveRate> {
  const out = new Map<string, ActiveRate>();
  for (const r of rates ?? []) {
    if (!r || !r.currency) continue;
    const ratePct = Number(r.annualRatePct);
    if (!Number.isFinite(ratePct) || ratePct <= 0) continue;
    const cap = Number.isFinite(Number(r.cap)) && Number(r.cap) > 0 ? Number(r.cap) : 0;
    out.set(r.currency.toUpperCase(), { ratePct, cap });
  }
  return out;
}

/**
 * Wylicza deterministyczny zestaw operacji auto-odsetek dla portfela.
 * Czysta funkcja (bez I/O) — używana też w testach.
 */
export function computeInterestOperations(
  transactions: Transaction[],
  operations: CashOperation[],
  rates: FreeCashInterestRate[] | undefined,
  today: string,
  taxRate = 0,
): CashOperation[] {
  const active = activeRatesFromSettings(rates);
  if (active.size === 0) return [];

  // Bazowe operacje = wszystko poza naszymi wcześniejszymi auto-odsetkami.
  const baseOps = operations.filter((op) => op.importBatch !== AUTO_INTEREST_BATCH);

  const deltas = buildCashDeltas(transactions, baseOps);
  if (deltas.length === 0) return [];

  // Miesiące+waluty, w których istnieją zaimportowane odsetki (broker/ręczne) —
  // pomijamy tam syntetyczne naliczenie (realne wiersze wygrywają).
  const brokerInterestMonths = new Set<string>();
  for (const op of baseOps) {
    if (op.subkind === 'interest' && op.currency) {
      brokerInterestMonths.add(`${monthOf(op.date)}|${op.currency.toUpperCase()}`);
    }
  }

  const startDate = deltas[0].date;
  const firstMonth = monthOf(startDate);
  const currentMonth = monthOf(today);

  const desired: CashOperation[] = [];
  const balance = new Map<string, number>();
  let di = 0; // wskaźnik do posortowanych delt

  // Iterujemy tylko ZAMKNIĘTE miesiące: firstMonth .. (currentMonth - 1).
  for (let ym = firstMonth; ym < currentMonth; ym = nextMonth(ym)) {
    const dim = daysInMonth(ym);
    const monthAccrual = new Map<string, number>(); // CUR -> suma dziennych naliczeń

    for (let day = 1; day <= dim; day++) {
      const dateStr = dayOf(ym, day);
      if (dateStr < startDate) continue; // przed pierwszą aktywnością (tylko 1. miesiąc)

      // Zaksięguj wszystkie delty do końca tego dnia.
      while (di < deltas.length && deltas[di].date <= dateStr) {
        const d = deltas[di];
        balance.set(d.currency, (balance.get(d.currency) || 0) + d.amount);
        di++;
      }

      // Nalicz odsetki od salda końca dnia (tylko dodatnie).
      for (const [cur, { ratePct, cap }] of active) {
        const bal = balance.get(cur) || 0;
        if (bal <= 0) continue;
        const base = cap > 0 ? Math.min(bal, cap) : bal;
        monthAccrual.set(cur, (monthAccrual.get(cur) || 0) + (base * (ratePct / 100)) / 365);
      }
    }

    // Koniec miesiąca: emituj rate i kapitalizuj.
    const monthEnd = dayOf(ym, dim);
    for (const [cur, accrued] of monthAccrual) {
      const amount = round2(accrued);
      if (amount < 0.01) continue;
      if (brokerInterestMonths.has(`${ym}|${cur}`)) continue;
      const ratePct = active.get(cur)!.ratePct;
      desired.push({
        date: monthEnd,
        operationType: 'other',
        subkind: 'interest',
        description: `Odsetki od wolnych środków (${ratePct}% p.a.)`,
        amount,
        currency: cur,
        source: 'auto-interest',
        importBatch: AUTO_INTEREST_BATCH,
      });
      // Kapitalizacja: rata BRUTTO podnosi saldo…
      balance.set(cur, (balance.get(cur) || 0) + amount);

      // …a podatek (Belki) osobnym wierszem `fee` obniża je z powrotem — 1:1 jak
      // broker (np. XTB „Free funds interest tax"). Kapitalizacja idzie więc na
      // netto. IKE/IKZE: taxRate=0 → brak wiersza podatku.
      if (taxRate > 0) {
        const tax = round2(amount * taxRate);
        if (tax >= 0.01) {
          const taxPct = Math.round(taxRate * 100);
          desired.push({
            date: monthEnd,
            operationType: 'fee',
            description: `Podatek od odsetek (${taxPct}%)`,
            amount: -tax,
            currency: cur,
            source: 'auto-interest',
            importBatch: AUTO_INTEREST_BATCH,
          });
          balance.set(cur, (balance.get(cur) || 0) - tax);
        }
      }
    }
  }

  return desired;
}

/** Stabilny klucz porównania zestawów (date|currency|amount). */
function opKey(op: CashOperation): string {
  return `${op.date}|${op.currency.toUpperCase()}|${op.amount.toFixed(2)}`;
}

function sameOpSet(a: CashOperation[], b: CashOperation[]): boolean {
  if (a.length !== b.length) return false;
  const bag = new Map<string, number>();
  for (const op of a) bag.set(opKey(op), (bag.get(opKey(op)) || 0) + 1);
  for (const op of b) {
    const k = opKey(op);
    const n = bag.get(k);
    if (!n) return false;
    if (n === 1) bag.delete(k);
    else bag.set(k, n - 1);
  }
  return bag.size === 0;
}

/**
 * Skan jednego portfela. Idempotentny: przelicza pełny zestaw auto-odsetek i pisze
 * do bazy tylko gdy różni się od aktualnego. Wywoływany z harmonogramu (raz/dobę),
 * po zapisie ustawień i po imporcie.
 *
 * @param force pomija throttle `last_interest_scan` (używane po zmianie ustawień/imporcie)
 */
export function scanInterest(portfolioId: string, force = false): InterestScanResult {
  const errors: string[] = [];
  const portfolio = getPortfolio(portfolioId);
  if (!portfolio) {
    return { changed: false, emitted: 0, errors: [`Portfolio ${portfolioId} not found`] };
  }

  const today = new Date().toISOString().split('T')[0];
  if (!force && getMetadata(portfolioId, 'last_interest_scan') === today) {
    return { changed: false, emitted: 0, errors: [] };
  }

  try {
    const operations = getAllOperations(portfolioId);
    const existingAuto = operations.filter((op) => op.importBatch === AUTO_INTEREST_BATCH);
    const transactions = getAllTransactions(portfolioId);

    const desired = computeInterestOperations(
      transactions,
      operations,
      portfolio.settings.freeCashInterest,
      today,
      interestTaxRate(portfolio.settings),
    );

    let changed = false;
    if (!sameOpSet(existingAuto, desired)) {
      // Delete-and-recompute. deleteOperationsByBatch + insert bumpują dataVersion.
      if (existingAuto.length > 0) deleteOperationsByBatch(AUTO_INTEREST_BATCH, portfolioId);
      if (desired.length > 0) insertOperationsWithDedup(desired, portfolioId);
      changed = existingAuto.length > 0 || desired.length > 0;
      if (changed) {
        console.log(
          `[interest-scanner] ${portfolioId}: ${existingAuto.length} → ${desired.length} auto-odsetek`,
        );
      }
    }

    setMetadata(portfolioId, 'last_interest_scan', today);
    return { changed, emitted: desired.length, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    console.error(`[interest-scanner] ${portfolioId}:`, msg);
    return { changed: false, emitted: 0, errors };
  }
}

/** Skan wszystkich portfeli — wołany z harmonogramu. */
export function scanAllInterest(): void {
  for (const p of getAllPortfolios()) {
    try {
      scanInterest(p.id);
    } catch (err) {
      console.error(`[interest-scanner] Error scanning ${p.id}:`, err);
    }
  }
}
