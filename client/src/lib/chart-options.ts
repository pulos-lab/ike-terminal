/**
 * Wspólne stałe konfiguracji wykresów lightweight-charts.
 */

/**
 * Dolny kres odstępu między świecami (px na punkt).
 *
 * lightweight-charts@5 ma DOMYŚLNE `minBarSpacing: 0.5`, a `fitContent()`
 * klampuje wyliczony odstęp do tego minimum TRZYMAJĄC PRAWĄ krawędź — wykres
 * o szerokości W px mieści więc najwyżej 2·W punktów. Pełna dzienna historia
 * portfela (np. 2017→dziś ≈ 3400 punktów) nie mieściła się i zakres „All"
 * zaczynał się w ~2018 zamiast na pierwszym punkcie serii (zgłoszenie usera).
 *
 * 0.001 (nie 0): twardy, dodatni kres z zapasem ~1000·W punktów; nadmierny
 * zoom-out i tak ogranicza subscriber klampujący widoczny zakres do danych.
 */
export const CHART_MIN_BAR_SPACING = 0.001;
