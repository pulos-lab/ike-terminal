/**
 * Redakcja próbek CSV przed zapisem do biblioteki profili i (w Fazie 4)
 * przed wysyłką do LLM API. Defense in depth: próbka służy WYŁĄCZNIE do
 * zmapowania struktury formatu, więc dane identyfikujące są maskowane,
 * a nazwy instrumentów/ISIN-y/kwoty zostają (bez nich mapowanie nie ma sensu).
 *
 * Dwie warstwy:
 * 1. Kolumny wrażliwe po NAZWIE nagłówka (rachunki, właściciel, adres, PESEL…)
 *    — cała komórka maskowana.
 * 2. Wzorce w pozostałych komórkach: IBAN, e-maile, SAMODZIELNE długie ciągi cyfr
 *    (numery rachunków/identyfikatory klienta). Cyfry będące częścią liczby
 *    dziesiętnej (np. ułamkowe ilości „0.3069000000") NIE są maskowane — to nie
 *    PII, a są potrzebne do uczciwego dry-runu profilu na próbce.
 */

const SENSITIVE_HEADER_RE =
  /(rachun|konto|account|iban|klient|client|owner|właścic|wlascic|adres|address|pesel|nip\b|e-?mail|nazwisko|imię|imie|name and surname|phone|telefon)/i;

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?\d{4}){4,8}\b/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;
// ≥9 cyfr, ale tylko SAMODZIELNY ciąg: lookbehind/lookahead wyklucza cyfry sąsiadujące
// z inną cyfrą albo separatorem dziesiętnym (`.`/`,`), więc ułamkowe ilości/ceny
// (np. „0.3069000000", „1234567.890123456") zostają, a numery rachunków są maskowane.
const LONG_DIGITS_RE = /(?<![\d.,])\d{9,}(?![\d.,])/g;

export const REDACTED = '***';

/** Maskowanie wzorców wewnątrz pojedynczej komórki. */
export function redactCell(value: string): string {
  return value
    .replace(IBAN_RE, REDACTED)
    .replace(EMAIL_RE, REDACTED)
    .replace(LONG_DIGITS_RE, REDACTED);
}

/**
 * Redaguje wiersze próbki względem nagłówków. Zwraca nową strukturę —
 * wejście pozostaje nietknięte.
 */
export function redactSampleRows(headers: string[], rows: string[][]): string[][] {
  const sensitiveCols = new Set<number>();
  headers.forEach((h, i) => {
    if (SENSITIVE_HEADER_RE.test(h)) sensitiveCols.add(i);
  });

  return rows.map((row) =>
    row.map((cell, i) => {
      const value = String(cell ?? '');
      if (value === '') return value;
      if (sensitiveCols.has(i)) return REDACTED;
      return redactCell(value);
    }),
  );
}

/**
 * Redakcja nazwy pliku przed wysyłką do LLM (wskazówka dla brokerLabel).
 * Nazwy eksportów często zawierają numer rachunku — ciągi ≥6 cyfr są
 * maskowane; krótsze (lata, daty) zostają, bo to użyteczny, niegroźny sygnał.
 */
export function redactFileName(name: string): string {
  return name.replace(/\d{6,}/g, '###').slice(0, 120);
}
