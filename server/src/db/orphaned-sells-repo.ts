import { getDb } from './connection.js';

// Trwałe "Ignoruj" dla wykrytych sprzedaży bez kupna (detectOrphanedSells).
// Sama detekcja jest liczona na żywo z transakcji — tu trzymamy wyłącznie
// decyzję użytkownika, żeby zignorowana pozycja nie wracała po każdym
// imporcie. Zapamiętujemy missing_quantity z momentu decyzji: gdy kolejny
// import powiększy brakującą ilość, pozycja wraca jako oczekująca (nowa
// informacja unieważnia starą decyzję).

export interface OrphanDismissal {
  isin: string;
  missingQuantity: number;
  dismissedAt: string;
}

interface DismissalRow {
  isin: string;
  missing_quantity: number;
  dismissed_at: string;
}

export function listOrphanDismissals(portfolioId: string = 'default'): OrphanDismissal[] {
  const db = getDb(portfolioId);
  const rows = db.prepare('SELECT * FROM orphaned_sell_dismissals').all() as DismissalRow[];
  return rows.map((r) => ({
    isin: r.isin,
    missingQuantity: r.missing_quantity,
    dismissedAt: r.dismissed_at,
  }));
}

export function dismissOrphanedSell(
  isin: string,
  missingQuantity: number,
  portfolioId: string = 'default',
): void {
  const db = getDb(portfolioId);
  db.prepare(
    `INSERT INTO orphaned_sell_dismissals (isin, missing_quantity)
     VALUES (?, ?)
     ON CONFLICT(isin) DO UPDATE SET
       missing_quantity = excluded.missing_quantity,
       dismissed_at = datetime('now')`,
  ).run(isin, missingQuantity);
}

export function restoreOrphanedSell(isin: string, portfolioId: string = 'default'): boolean {
  const db = getDb(portfolioId);
  return db.prepare('DELETE FROM orphaned_sell_dismissals WHERE isin = ?').run(isin).changes > 0;
}

/** Kaskada dla DELETE /api/import/clear — decyzje wskazywałyby na usunięte transakcje. */
export function clearOrphanDismissals(portfolioId: string = 'default'): number {
  const db = getDb(portfolioId);
  return db.prepare('DELETE FROM orphaned_sell_dismissals').run().changes;
}
