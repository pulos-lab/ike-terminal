/**
 * Redakcja próbek CSV przed zapisem do biblioteki profili i (w Fazie 4)
 * przed wysyłką do LLM API. Defense in depth: próbka służy WYŁĄCZNIE do
 * zmapowania struktury formatu, więc dane identyfikujące są maskowane,
 * a nazwy instrumentów/ISIN-y/kwoty zostają (bez nich mapowanie nie ma sensu).
 *
 * Dwie warstwy:
 * 1. Kolumny wrażliwe po NAZWIE nagłówka (rachunki, właściciel, adres, PESEL…)
 *    — cała komórka maskowana.
 * 2. Wzorce w pozostałych komórkach: IBAN, e-maile, długie ciągi cyfr
 *    (numery rachunków/identyfikatory klienta; kwoty mają separatory, więc
 *    nie wpadają w ciąg ≥9 cyfr).
 */

const SENSITIVE_HEADER_RE =
  /(rachun|konto|account|iban|klient|client|owner|właścic|wlascic|adres|address|pesel|nip\b|e-?mail|nazwisko|imię|imie|name and surname|phone|telefon)/i;

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?\d{4}){4,8}\b/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;
const LONG_DIGITS_RE = /\d{9,}/g;

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
