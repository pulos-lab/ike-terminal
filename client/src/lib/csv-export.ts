/**
 * Eksport tabel do CSV otwieranego dwuklikiem w polskim Excelu.
 *
 * Format jest dobrany pod Excela z polskimi ustawieniami regionalnymi (i nie
 * psuje LibreOffice ani Google Sheets): separator `;`, przecinek dziesiętny,
 * BOM UTF-8 (bez niego „ż/ó/ł” zamieniają się w krzaki), CRLF. Liczby bez
 * separatora tysięcy — inaczej arkusz czyta je jako tekst. Daty ISO
 * `RRRR-MM-DD` sortują się poprawnie i są rozpoznawane jako daty.
 */

export type CsvValue = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

const SEPARATOR = ';';
const BOM = '﻿';
/** Maksymalna precyzja liczb — dość dla ułamkowych akcji i kursów FX, bez ogona float. */
const MAX_DECIMALS = 8;

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  // toFixed + Number zdejmuje ogon binarny (0.1 + 0.2) i notację wykładniczą
  // dla typowych wartości; przecinek dziesiętny dla polskiego Excela.
  const fixed = Number(n.toFixed(MAX_DECIMALS)).toString();
  return fixed.includes('e') ? n.toFixed(MAX_DECIMALS).replace('.', ',') : fixed.replace('.', ',');
}

/**
 * Tekst zaczynający się od `=`, `+`, `-`, `@` (albo tabulatora/CR) arkusz
 * wykonałby jako formułę — nazwa papieru lub opis operacji pochodzą z plików
 * brokera, więc traktujemy je jak dane niezaufane i neutralizujemy apostrofem
 * (CSV injection). Liczby ujemne przechodzą osobną ścieżką i nie są ruszane.
 */
function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function formatCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'tak' : 'nie';
  const text = neutralizeFormula(String(value));
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Buduje treść pliku: BOM + nagłówek + wiersze, rozdzielone CRLF. */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((c) => formatCell(c.header)).join(SEPARATOR)];
  for (const row of rows) {
    lines.push(columns.map((c) => formatCell(c.value(row))).join(SEPARATOR));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Sama data z ISO (`2025-03-14T10:00:00` → `2025-03-14`); puste dla braku. */
export function csvDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

/**
 * `transakcje_moj-portfel_2026-11-09.csv` — nazwa portfela sprowadzona do
 * bezpiecznych znaków (bez polskich liter i spacji: plik ma się dać załączyć
 * i otworzyć wszędzie). Data jest parametrem, żeby funkcja nie czytała zegara.
 */
export function csvFilename(kind: string, portfolioName: string | undefined, date: Date): string {
  const slug = (portfolioName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return [kind, slug, `${y}-${m}-${d}`].filter(Boolean).join('_') + '.csv';
}

/** Uruchamia pobranie pliku w przeglądarce (dane nie opuszczają urządzenia). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Zwolnienie po chwili — Safari potrzebuje URL-a jeszcze przez moment po kliknięciu.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
