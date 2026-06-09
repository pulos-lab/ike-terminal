/**
 * Zwrot za okres między dwoma punktami SKUMULOWANYCH zwrotów procentowych
 * (chain-linking). Skumulowane procenty nie składają się addytywnie:
 * portfel na +100%, który urósł do +110%, zarobił w okresie
 * (2.10 / 2.00 − 1) = +5%, a nie 110 − 100 = +10 p.p.
 */
export function chainLinkPct(endPct: number, startPct: number): number {
  const startIndex = 1 + startPct / 100;
  if (startIndex <= 0) return endPct - startPct; // degeneracja (≤ −100%) — bezpieczny fallback
  return ((1 + endPct / 100) / startIndex - 1) * 100;
}
