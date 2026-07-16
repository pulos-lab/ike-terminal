import type { OrphanedSell } from 'shared';
import { detectOrphanedSells } from '../db/transactions-repo.js';
import { getSplits } from '../db/splits-repo.js';
import { listOrphanDismissals } from '../db/orphaned-sells-repo.js';

// Jedno źródło prawdy dla "sprzedaży bez kupna" pokazywanych użytkownikowi:
// surowa detekcja (detectOrphanedSells) minus dwa rodzaje fałszywych alarmów:
//  1. ISIN-y ze splitem w bazie — surowe sumy K/S są zniekształcone (sprzedaż
//     po splicie "przekracza" kupno sprzed splitu), a korektę robi silnik;
//  2. pozycje trwale zignorowane przez użytkownika (orphaned_sell_dismissals),
//     chyba że brakująca ilość od tamtej pory WZROSŁA — wtedy wraca.
// Używane przez wynik importu (ImportResult.orphanedSells) i hub Importu,
// żeby obie ścieżki pokazywały dokładnie to samo.

const QTY_TOLERANCE = 0.001;

export interface OrphanedSellsView {
  /** Oczekujące na decyzję użytkownika. */
  pending: OrphanedSell[];
  /** Wykryte, ale trwale zignorowane (hub pokazuje je z opcją "Przywróć"). */
  dismissed: OrphanedSell[];
}

export function getOrphanedSellsView(portfolioId: string): OrphanedSellsView {
  const splitIsins = new Set(getSplits(portfolioId).map((s) => s.isin));
  const detected = detectOrphanedSells(portfolioId).filter((o) => !splitIsins.has(o.isin));
  const dismissals = new Map(listOrphanDismissals(portfolioId).map((d) => [d.isin, d]));

  const pending: OrphanedSell[] = [];
  const dismissed: OrphanedSell[] = [];
  for (const o of detected) {
    const d = dismissals.get(o.isin);
    const stillDismissed = d && o.missingQuantity <= d.missingQuantity + QTY_TOLERANCE;
    (stillDismissed ? dismissed : pending).push(o);
  }
  return { pending, dismissed };
}

/** Skrót dla ścieżek importu — tylko pozycje wymagające decyzji. */
export function getActionableOrphanedSells(portfolioId: string): OrphanedSell[] {
  return getOrphanedSellsView(portfolioId).pending;
}
