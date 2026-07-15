import type { SkipReason } from 'shared';

/**
 * Shared parser utilities — numeric parsing, rounding, date conversion,
 * wspólna walidacja wierszy transakcji.
 */

/**
 * Normalizacja tekstu nagłówka do dopasowań detektorów formatu: lowercase, bez
 * diakrytyków, ł→l, scalone spacje. Dzięki temu detekcja brokera jest odporna na
 * warianty z/bez polskich znaków ("Tytuł operacji" == "Tytul operacji",
 * "Opłaty AutoFX" == "Oplaty AutoFX"). Spójna z normalizacją fingerprinta importu
 * uniwersalnego, ale wolnostojąca (utils nie zależy od silnika generycznego).
 */
export function normalizeForDetect(s: string): string {
  return s
    .replace(/^﻿/, '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse European number format: "1 234,56" -> 1234.56
 * Handles whitespace thousands separators and comma decimal separator.
 * Gdy występują OBA separatory ('.' i ','), ostatni z nich jest traktowany
 * jako dziesiętny, a drugi jako tysięczny:
 *   "1.234,56" -> 1234.56 (kropka-tysiące, przecinek-dziesiętny)
 *   "1,234.56" -> 1234.56 (przecinek-tysiące, kropka-dziesiętny)
 * Returns 0 for undefined/empty/NaN values.
 */
export function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  let cleaned = value.toString().replace(/\s/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    cleaned =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else {
    cleaned = cleaned.replace(',', '.');
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Round to 2 decimal places (currency precision).
 */
export function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Zaokrąglenie implikowanego kursu FX (|kwota rozliczenia| / (ilość×cena)) do
 * wspólnej liczby miejsc. Parser XTB i silnik generic MUSZĄ używać tej samej
 * funkcji — identyczny wynik jest warunkiem parytetu compare:generic.
 */
export function roundFxRate(rate: number): number {
  return Math.round(rate * 1e6) / 1e6;
}

/**
 * Total transakcji wg konwencji K/S: kupno powiększa wartość o prowizję,
 * sprzedaż ją pomniejsza. Zaokrąglone do 2 miejsc (waluta).
 *
 * Konwencja prowizji per broker (celowa dywergencja — nowy parser musi wybrać
 * świadomie jedną z trzech ścieżek):
 * - mBank / IBKR / silnik generic: przeliczają total TĄ funkcją z wartości
 *   i prowizji (broker podaje składniki osobno);
 * - Bossa: ufa kolumnie CSV „po prowizji" wprost, bez przeliczania (kwota
 *   rozliczenia brokera jest źródłem prawdy);
 * - DEGIRO: commission=0 i total=value — opłaty księgowane osobno w EUR
 *   (wiersze „DEGIRO Opłata Transakcyjna" w Account.csv).
 */
export function computeTotal(side: 'K' | 'S', value: number, commission: number): number {
  return side === 'K' ? roundTo2(value + commission) : roundTo2(value - commission);
}

export type TradeFieldsCheck = { ok: true } | { ok: false; reason: SkipReason };

/**
 * Wspólna walidacja pól wiersza transakcji CSV (mBank/Bossa/DEGIRO).
 * Sprawdzane są TYLKO pola przekazane w `fields` — parser decyduje, które
 * kolumny są dla niego obowiązkowe (np. Bossa wymaga ISIN, mBank nazwy).
 * Kolejność sprawdzania jest stała: data → nazwa → ISIN → strona → ilość → cena;
 * zwracany jest pierwszy napotkany powód odrzucenia (zgodny z SkippedRow.reason).
 */
export function validateTradeFields(fields: {
  date?: string;
  paperName?: string;
  isin?: string;
  side?: string;
  quantity?: number;
  price?: number;
}): TradeFieldsCheck {
  if ('date' in fields && !fields.date) return { ok: false, reason: 'missing_date' };
  if ('paperName' in fields && !fields.paperName) return { ok: false, reason: 'missing_name' };
  if ('isin' in fields && !fields.isin) return { ok: false, reason: 'missing_isin' };
  if ('side' in fields && fields.side !== 'K' && fields.side !== 'S') {
    return { ok: false, reason: 'invalid_side' };
  }
  if ('quantity' in fields && (fields.quantity ?? 0) <= 0) {
    return { ok: false, reason: 'invalid_quantity' };
  }
  if ('price' in fields && (fields.price ?? 0) <= 0) {
    return { ok: false, reason: 'invalid_price' };
  }
  return { ok: true };
}

// ── Walidacja struktury wiersza — ochrona przed cichym przesunięciem kolumn ──
//
// Zagrożenie: dodatkowy separator w środku pola (np. średnik w tytule operacji)
// przesuwa wartości do złych kolumn, a `parseNumber('12abc') = 12` przechodzi bez
// sygnału — dane lądują w DB z przekłamanymi kwotami. Wykrywamy FAKTYCZNE
// przesunięcie sygnałami TREŚCI (liczba w kolumnie waluty, tekst w kolumnie
// liczbowej, brak daty w kolumnie daty), a NIE liczbą kolumn: nadmiarowe kolumny
// po prawej (np. "Product" w nowych eksportach) i puste `__parsed_extra`
// z trailing separatora są nieszkodliwe i muszą być tolerowane.

export type RowFieldKind = 'number' | 'currency' | 'date';

export interface RowShapeField {
  /** Etykieta kolumny (nazwa z nagłówka pliku) — do komunikatu ostrzeżenia. */
  label: string;
  value: string | undefined;
  kind: RowFieldKind;
}

/**
 * Czy tekst jest W CAŁOŚCI liczbą w formacie EU/US (te same reguły czyszczenia
 * co parseNumber: spacje tysięcy, przecinek/kropka dziesiętna, oba separatory).
 * W przeciwieństwie do parseNumber odrzuca częściowe dopasowania ('12abc').
 */
export function isStrictNumber(value: string): boolean {
  let cleaned = value.replace(/\s/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    cleaned =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else {
    cleaned = cleaned.replace(',', '.');
  }
  return /^[+-]?\d+(\.\d+)?$/.test(cleaned);
}

/**
 * Data w dowolnej konwencji obsługiwanej przez parsery (DD.MM.YYYY, DD-MM-YYYY,
 * YYYY-MM-DD, opcjonalny czas). Celowo LUŹNE — chodzi o wykrycie przesunięcia
 * (liczba/tekst w kolumnie daty), nie o egzekwowanie konkretnego formatu;
 * warianty formatu łapie dalsza walidacja parsera.
 */
const DATE_ANY_RE = /(\d{2}[.-]\d{2}[.-]\d{4}|\d{4}-\d{2}-\d{2})/;

/**
 * Sygnały przesunięcia kolumn w wierszu. Puste pole NIGDY nie jest sygnałem
 * (braki obsługuje walidacja pól parsera — missing_date/invalid_price itd.).
 * Zwraca listę opisów problemów; pusta lista = wiersz strukturalnie OK.
 */
export function detectColumnShift(fields: RowShapeField[]): string[] {
  const problems: string[] = [];
  for (const f of fields) {
    const v = f.value?.toString().trim();
    if (!v) continue;
    switch (f.kind) {
      case 'number':
        if (!isStrictNumber(v)) problems.push(`kolumna „${f.label}" nie jest liczbą („${v}")`);
        break;
      case 'currency':
        if (/^[+-]?\d/.test(v))
          problems.push(`kolumna „${f.label}" zawiera liczbę („${v}") zamiast kodu waluty`);
        break;
      case 'date':
        if (!DATE_ANY_RE.test(v)) problems.push(`kolumna „${f.label}" nie zawiera daty („${v}")`);
        break;
    }
  }
  return problems;
}

const RAW_ROW_MAX_LEN = 220;

/**
 * Surowa treść wiersza do ostrzeżenia. Przyjmuje tablicę komórek (Papa
 * header:false) lub obiekt wiersza (Papa header:true — kolejność pól = kolejność
 * nagłówka, `__parsed_extra` spłaszczane na koniec).
 */
export function rawRowForWarning(row: unknown, delimiter: string): string {
  const values = Array.isArray(row)
    ? row
    : row && typeof row === 'object'
      ? Object.values(row as Record<string, unknown>).flat()
      : [row];
  const s = values.map((v) => (v == null ? '' : String(v))).join(delimiter);
  return s.length > RAW_ROW_MAX_LEN ? `${s.slice(0, RAW_ROW_MAX_LEN)}…` : s;
}

/**
 * Czytelne ostrzeżenie o pominiętym wierszu z przesuniętymi kolumnami — z numerem
 * wiersza i surową treścią, żeby użytkownik mógł znaleźć i poprawić wiersz w pliku.
 */
export function columnShiftWarning(rowNum: number, problems: string[], rawRow: string): string {
  return (
    `Wiersz ${rowNum} pominięty — wartości nie pasują do kolumn formatu ` +
    `(prawdopodobnie dodatkowy separator w którymś polu przesunął kolumny): ` +
    `${problems.join('; ')}. Treść wiersza: ${rawRow}`
  );
}

/**
 * Parse DD.MM.YYYY with optional HH:MM:SS time to ISO 8601.
 * "25.02.2026 09:47:27" -> "2026-02-25T09:47:27"
 * "25.02.2026"          -> "2026-02-25T00:00:00"
 */
export function parseDottedDate(dateStr: string): string {
  const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2}:\d{2}:\d{2})?/);
  if (match) {
    const time = match[4] || '00:00:00';
    return `${match[3]}-${match[2]}-${match[1]}T${time}`;
  }
  return dateStr;
}

/**
 * Parse DEGIRO date (DD-MM-YYYY) + optional time (HH:MM) to ISO 8601.
 * "25-02-2026" + "09:47" -> "2026-02-25T09:47:00"
 * "25-02-2026"           -> "2026-02-25T00:00:00"
 */
export function parseDegiroDate(dateStr: string, timeStr?: string): string {
  const match = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (match) {
    const time = timeStr ? `${timeStr}:00` : '00:00:00';
    return `${match[3]}-${match[2]}-${match[1]}T${time}`;
  }
  return dateStr;
}
