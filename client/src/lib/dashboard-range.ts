/** Presety zakresu wykresu na dashboardzie — kolejność = kolejność przycisków. */
export const PRESET_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', 'ALL'] as const;

export type PresetRange = (typeof PRESET_RANGES)[number];

export const DEFAULT_PRESET_RANGE: PresetRange = 'ALL';

/**
 * Sprowadza wartość z localStorage do znanego presetu.
 *
 * Zapamiętujemy WYŁĄCZNIE presety: zakres własny to konkretne daty, które po
 * tygodniu byłyby nieaktualne („ostatnie 30 dni” wpisane ręcznie przestaje nimi
 * być), więc `CUSTOM` i każda nieznana wartość (stary klucz, ręczna edycja
 * storage) wracają do domyślnego `ALL`.
 */
export function clampPresetRange(stored: unknown): PresetRange {
  return (PRESET_RANGES as readonly unknown[]).includes(stored)
    ? (stored as PresetRange)
    : DEFAULT_PRESET_RANGE;
}
