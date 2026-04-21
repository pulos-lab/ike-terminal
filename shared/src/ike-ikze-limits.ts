/**
 * Historyczne roczne limity wpłat na IKE i IKZE (1.2× i 1.8× przeciętnego wynagrodzenia).
 *
 * Źródła:
 * - IKE / IKZE regular: oficjalne obwieszczenia Ministra Rodziny, Pracy i Polityki Społecznej
 *   (3× / 1.2× prognozowane przeciętne wynagrodzenie miesięczne w gospodarce narodowej)
 * - IKZE-DG (1.8×): wprowadzone ustawą od 2021 roku dla osób prowadzących pozarolniczą
 *   działalność gospodarczą. Przed 2021 brak odrębnego wariantu — limit DG = zwykły IKZE.
 *
 * Dokumenty potwierdzające:
 * - https://www.gov.pl/web/rodzina/ike-limit-wplat (2017-2026)
 * - https://www.bsmiedzyrzec.pl/limity-wplat-na-ike-oraz-ikze (2017-2026 z cross-check)
 * - Pierwotne obwieszczenia M.P. 2011-2019 (M. P. z 2011 r. poz. 963, itd.) dla lat 2012-2018
 *
 * Gdy pojawi się nowa stawka na kolejny rok — dodać tutaj wpis. To jedyne miejsce w kodzie
 * gdzie są te dane; UI i server importują przez `shared`.
 */

export const IKE_LIMITS: Record<number, number> = {
  2012: 10578,
  2013: 11139,
  2014: 11238,
  2015: 11877,
  2016: 12165,
  2017: 12789,
  2018: 13329,
  2019: 14295,
  2020: 15681,
  2021: 15777,
  2022: 17766,
  2023: 20805,
  2024: 23472,
  2025: 26019,
  2026: 28260,
};

/**
 * IKZE zwykły (1.2× prognozowanego przeciętnego wynagrodzenia miesięcznego).
 * Przed 2014 rokiem wzór był inny (4% podstawy składek ZUS z poprzedniego roku) — wartości
 * dla 2012-2013 oparte na ogłoszonych kwotach maksymalnych, nie formule.
 */
export const IKZE_LIMITS: Record<number, number> = {
  2012: 4030.80,
  2013: 4231.20,
  2014: 4495.20,
  2015: 4750.80,
  2016: 4866.00,
  2017: 5115.60,
  2018: 5331.60,
  2019: 5718.00,
  2020: 6272.40,
  2021: 6310.80,
  2022: 7106.40,
  2023: 8322.00,
  2024: 9388.80,
  2025: 10407.60,
  2026: 11305.20,
};

/**
 * IKZE dla osób prowadzących pozarolniczą działalność gospodarczą (1.8× przeciętnego wynagrodzenia).
 * Wariant wprowadzony w 2021 roku. Dla lat wcześniejszych brak odrębnej stawki — zwraca zwykły IKZE.
 */
export const IKZE_DG_LIMITS: Record<number, number> = {
  // Pre-2021: brak odrębnego wariantu — limit DG = IKZE zwykły. Wypełnione tu dla spójności lookup'u.
  2012: IKZE_LIMITS[2012],
  2013: IKZE_LIMITS[2013],
  2014: IKZE_LIMITS[2014],
  2015: IKZE_LIMITS[2015],
  2016: IKZE_LIMITS[2016],
  2017: IKZE_LIMITS[2017],
  2018: IKZE_LIMITS[2018],
  2019: IKZE_LIMITS[2019],
  2020: IKZE_LIMITS[2020],
  2021: 9466.20,
  2022: 10659.60,
  2023: 12483.00,
  2024: 14083.20,
  2025: 15611.40,
  2026: 16957.80,
};

/**
 * Pobierz limit IKE dla danego roku. Zwraca 0 dla lat nieobsługiwanych.
 */
export function getIKELimit(year: number): number {
  return IKE_LIMITS[year] ?? 0;
}

/**
 * Pobierz limit IKZE dla danego roku. Wariant zależy od flagi `isJDG`
 * (prowadzenie pozarolniczej działalności gospodarczej).
 */
export function getIKZELimit(year: number, isJDG: boolean = false): number {
  if (isJDG) return IKZE_DG_LIMITS[year] ?? 0;
  return IKZE_LIMITS[year] ?? 0;
}

/**
 * Lata dla których dostępny jest limit — używane przez UI do iteracji po historii.
 */
export const SUPPORTED_IKE_IKZE_YEARS: number[] = Object.keys(IKE_LIMITS)
  .map(Number)
  .sort((a, b) => a - b);
