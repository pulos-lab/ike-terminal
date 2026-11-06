import type { OrphanedSell } from 'shared';
import { detectOrphanedSells } from '../db/transactions-repo.js';
import { getSplits } from '../db/splits-repo.js';
import { getSpinOffs } from '../db/spin-offs-repo.js';
import { listOrphanDismissals } from '../db/orphaned-sells-repo.js';
import { rehomeSpinOffChildrenForPortfolio } from './spin-offs-applier.js';

// Jedno źródło prawdy dla "sprzedaży bez kupna" pokazywanych użytkownikowi:
// surowa detekcja (detectOrphanedSells) minus trzy rodzaje fałszywych alarmów:
//  1. ISIN-y ze splitem w bazie — surowe sumy K/S są zniekształcone (sprzedaż
//     po splicie "przekracza" kupno sprzed splitu), a korektę robi silnik;
//  2. dzieci ZAAPLIKOWANYCH spin-offów (dopasowanie po ISIN-ie dziecka) — pozycję tworzy syntetyczny zakup
//     compute-time (nie trafia do tabeli transactions), więc surowa detekcja
//     widzi "sprzedaż bez kupna" na zawsze; przycisk kupna-0 jest dla nich
//     i tak blokowany guardem requiresConfirmation, a jedyną pozostałą akcją
//     byłoby mylące "Ignoruj". Statusy skipped_broker/reverted NIE filtrują —
//     tam syntetyka nie ma i decyzja faktycznie należy do użytkownika;
//  3. pozycje trwale zignorowane przez użytkownika (orphaned_sell_dismissals),
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
  // Najpierw przepięcie dzieci spin-offów na ISIN realnych transakcji — inaczej
  // sprzedaż zaimportowana przed pierwszym wczytaniem portfela wyglądałaby na
  // osieroconą (wiersz `spin_offs` wciąż wskazywałby `AUTO_<TICKER>`).
  rehomeSpinOffChildrenForPortfolio(portfolioId);
  const appliedSpinOffs = getSpinOffs(portfolioId).filter((s) => s.status === 'applied');
  // Pokrycie WYŁĄCZNIE po ISIN-ie, pod którym silnik wstawia syntetyczne kupno.
  // Dawniej wystarczała zgodność TICKERA — i to ona ukryła zgłoszenie 2026-11-05:
  // dziecko SPGI→MBGL siedziało pod `AUTO_MBGL`, sprzedaż z Bossy pod
  // `US60744M1062`, silnik liczył je jako dwie pozycje, a skrzynka milczała.
  // Gdy przepięcie nie rozstrzyga (np. kilka ISIN-ów z tym samym tickerem),
  // sprzedaż ma się tu POKAZAĆ — decyzja należy wtedy do użytkownika.
  const coveredBySpinOff = (o: OrphanedSell) => appliedSpinOffs.some((s) => o.isin === s.childIsin);
  const detected = detectOrphanedSells(portfolioId).filter(
    (o) => !splitIsins.has(o.isin) && !coveredBySpinOff(o),
  );
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
