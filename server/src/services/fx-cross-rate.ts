/**
 * Kurs pary krzyżowej z dwóch serii o wspólnej walucie kwotowania
 * (USD/EUR = USDPLN / EURPLN).
 *
 * Serie składowe są cache'owane NIEZALEŻNIE i każda może się zestarzeć osobno —
 * reguła „ostatnia data ≤3 dni = cache świeży" w `fetchYahooHistory` pozwala
 * jednej nodze wyprzedzić drugą o kilka dni. Zwykłe przecięcie dat obcinało
 * wtedy końcówkę wykresu krzyżowego: przy USDPLN do 04.08 i EURPLN do 05.08
 * cross kończył się na 02.08, mimo świeżych danych po obu stronach.
 *
 * Dlatego oś dat to SUMA dat obu serii, a brakująca noga jest przeciągana
 * ostatnią znaną wartością (forward fill) — tak samo jak kurs FX „obowiązuje"
 * przez weekend. Przeciąganie ma sufit wieku: po dłuższej przerwie w jednej
 * serii wolimy urwać wykres niż rysować płaski, wymyślony kurs krzyżowy.
 */

/** Ile dni wolno przeciągać ostatnią znaną wartość nogi (weekend + święta). */
const MAX_CARRY_DAYS = 5;

type Point = { date: string; close: number };

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * @param base seria licznika (np. USDPLN=X)
 * @param quote seria mianownika (np. EURPLN=X)
 * @returns kurs base/quote na sumie dat obu serii; punkty sprzed pierwszego
 *   notowania którejkolwiek nogi i te po przekroczeniu `MAX_CARRY_DAYS` od
 *   ostatniej znanej wartości są pomijane
 */
export function crossRateSeries(base: Point[], quote: Point[]): Point[] {
  const baseByDate = new Map(base.map((p) => [p.date, p.close]));
  const quoteByDate = new Map(quote.map((p) => [p.date, p.close]));
  const dates = [...new Set([...baseByDate.keys(), ...quoteByDate.keys()])].sort();

  const out: Point[] = [];
  let lastBase: Point | null = null;
  let lastQuote: Point | null = null;

  for (const date of dates) {
    const b = baseByDate.get(date);
    const q = quoteByDate.get(date);
    if (b != null && b > 0) lastBase = { date, close: b };
    if (q != null && q > 0) lastQuote = { date, close: q };
    if (!lastBase || !lastQuote) continue; // przed pierwszym notowaniem nogi

    const stale =
      daysBetween(lastBase.date, date) > MAX_CARRY_DAYS ||
      daysBetween(lastQuote.date, date) > MAX_CARRY_DAYS;
    if (stale) continue;

    out.push({ date, close: lastBase.close / lastQuote.close });
  }
  return out;
}
