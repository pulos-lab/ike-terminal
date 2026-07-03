import { getDb } from './connection.js';
import type { AppliedSpinOff } from 'shared';

// UWAGA: to repo CELOWO nie woła bumpPortfolioDataVersion (tak samo jak splits-repo).
// Applier woła insertSpinOff przy każdym budowaniu widoku pozycji — bump na poziomie
// repo unieważniałby memo historii nawet gdy nic się nie zmieniło. Wersję podbija
// caller (spin-offs-applier / routes) i TYLKO gdy insert/mutacja faktycznie zaszła.

interface SpinOffRow {
  id: number;
  parent_isin: string;
  parent_ticker: string;
  child_isin: string;
  child_ticker: string;
  child_name: string | null;
  ex_date: string;
  ratio: number;
  allocation_pct: number;
  child_qty: number;
  currency: string;
  parent_price_used: number | null;
  child_price_used: number | null;
  status: string;
  source: string;
  applied_at: string;
}

function rowToSpinOff(row: SpinOffRow): AppliedSpinOff {
  return {
    id: row.id,
    parentIsin: row.parent_isin,
    parentTicker: row.parent_ticker,
    childIsin: row.child_isin,
    childTicker: row.child_ticker,
    childName: row.child_name ?? undefined,
    exDate: row.ex_date,
    ratio: row.ratio,
    allocationPct: row.allocation_pct,
    childQty: row.child_qty,
    currency: row.currency,
    parentPriceUsed: row.parent_price_used ?? undefined,
    childPriceUsed: row.child_price_used ?? undefined,
    status: row.status as AppliedSpinOff['status'],
    source: row.source as AppliedSpinOff['source'],
    appliedAt: row.applied_at,
  };
}

export function getSpinOffs(portfolioId: string): AppliedSpinOff[] {
  const db = getDb(portfolioId);
  const rows = db
    .prepare('SELECT * FROM spin_offs ORDER BY ex_date, parent_ticker')
    .all() as SpinOffRow[];
  return rows.map(rowToSpinOff);
}

/**
 * Wstawia wiersz spin-offu. ON CONFLICT(parent_isin, ex_date) DO NOTHING —
 * zwraca true tylko gdy wiersz faktycznie wszedł (race-safe idempotencja:
 * przegrany z równoległych requestów dostaje false i pomija side-effecty
 * typu bumpPortfolioDataVersion / invalidateCachedPrices).
 */
export function insertSpinOff(portfolioId: string, so: AppliedSpinOff): boolean {
  const db = getDb(portfolioId);
  const result = db
    .prepare(
      `INSERT INTO spin_offs
         (parent_isin, parent_ticker, child_isin, child_ticker, child_name,
          ex_date, ratio, allocation_pct, child_qty, currency,
          parent_price_used, child_price_used, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(parent_isin, ex_date) DO NOTHING`,
    )
    .run(
      so.parentIsin,
      so.parentTicker,
      so.childIsin,
      so.childTicker,
      so.childName ?? null,
      so.exDate,
      so.ratio,
      so.allocationPct,
      so.childQty,
      so.currency,
      so.parentPriceUsed ?? null,
      so.childPriceUsed ?? null,
      so.status,
      so.source,
    );
  return result.changes > 0;
}

export function updateSpinOffStatus(
  portfolioId: string,
  id: number,
  status: AppliedSpinOff['status'],
): boolean {
  const db = getDb(portfolioId);
  const result = db.prepare('UPDATE spin_offs SET status = ? WHERE id = ?').run(status, id);
  return result.changes > 0;
}

/** Hard delete — do testów/administracji. Cofnięcie w UI to updateSpinOffStatus('reverted'). */
export function deleteSpinOff(portfolioId: string, id: number): boolean {
  const db = getDb(portfolioId);
  const result = db.prepare('DELETE FROM spin_offs WHERE id = ?').run(id);
  return result.changes > 0;
}
