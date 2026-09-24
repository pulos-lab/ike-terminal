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
  const num = parseFloat(normalizeNumericText(value.toString()));
  return isNaN(num) ? 0 : num;
}

/**
 * Wspólne czyszczenie tekstu liczby dla `parseNumber` i `isStrictNumber` (dawniej
 * dwie kopie tego samego kodu): usuwa białe znaki (w tym NBSP i wąską spację),
 * zamienia typograficzny minus (U+2212) i półpauzę na `-`, a separatory
 * rozstrzyga regułą „ostatni separator jest dziesiętny".
 */
export function normalizeNumericText(value: string): string {
  let cleaned = value.replace(/\s/g, '').replace(/[\u2212\u2013]/g, '-');
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
  return cleaned;
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
 * Ilość akcji z CSV: usuwa szum zmiennoprzecinkowy (9.9999999 → 10), ale NIE
 * zaokrągla realnych ułamków. Dawne `Math.round(qty)` w mBanku/Bossie/ING
 * zamieniało 0,4 szt. na 0 już PO walidacji (a `value` liczono z ułamka).
 */
export function normalizeQuantity(quantity: number): number {
  const whole = Math.round(quantity);
  return Math.abs(quantity - whole) < 1e-6 ? whole : Math.round(quantity * 1e6) / 1e6;
}

/**
 * Dywidenda netto z pary brutto + podatek u źródła, ZE ZNAKIEM.
 *
 * Wcześniej parsery liczyły `|brutto| − |podatek|`, więc korekta (ujemna
 * dywidenda odwracająca wypłatę) stawała się DOCHODEM, a zwrot podatku
 * (dodatni wiersz WHT) był odejmowany zamiast dodany.
 *
 * - znaki przeciwne (typowo +brutto / −podatek albo −brutto / +zwrot przy
 *   korekcie): suma ze znakiem;
 * - znaki zgodne (np. plik podaje podatek jako magnitudę): dawna semantyka
 *   `|brutto| − |podatek|` ze znakiem brutto — `sameSign` pozwala zgłosić warning.
 */
export function netDividendAmount(
  gross: number,
  tax: number | undefined,
): { net: number; taxAbs: number; taxPct: number; sameSign: boolean } {
  const g = gross;
  const t = tax ?? 0;
  const taxAbs = Math.abs(t);
  const sameSign = t !== 0 && g !== 0 && Math.sign(t) === Math.sign(g);
  const net = sameSign ? Math.sign(g) * (Math.abs(g) - taxAbs) : g + t;
  const gAbs = Math.abs(g);
  const taxPct = gAbs > 0 && taxAbs > 0 ? Math.round((taxAbs / gAbs) * 100) : 0;
  return { net: roundTo2(net), taxAbs, taxPct, sameSign };
}

/**
 * Kurs dla operacji `fx_exchange` w kanonicznej konwencji `CashOperation.fxRate`:
 * przy parze z PLN — **PLN za 1 jednostkę waluty obcej** NIEZALEŻNIE od kierunku
 * wymiany (tak zapisują Bossa/DEGIRO/mBank i tak czyta `plnPerXFromOp` w silniku).
 * Kurs wyliczany z KWOT, więc kierunek jest jednoznaczny. Para krzyżowa (bez PLN):
 * `to` za 1 `from` — silnik i tak bierze wtedy kurs historyczny.
 *
 * Wcześniej T212 i generic zapisywały zawsze `to/from`: wymiana PLN→USD dawała
 * ~0,25 zamiast ~4, a księga wpływu walut liczyła fikcyjny zysk.
 */
export function fxExchangeRate(
  from: { amount: number; currency: string },
  to: { amount: number; currency: string },
): number | undefined {
  const fromAbs = Math.abs(from.amount);
  const toAbs = Math.abs(to.amount);
  if (!(fromAbs > 0) || !(toAbs > 0)) return undefined;
  const fromCur = from.currency.toUpperCase();
  const toCur = to.currency.toUpperCase();
  if (fromCur === 'PLN' && toCur !== 'PLN') return roundFxRate(fromAbs / toAbs);
  if (toCur === 'PLN' && fromCur !== 'PLN') return roundFxRate(toAbs / fromAbs);
  return roundFxRate(toAbs / fromAbs);
}

/**
 * Kurs podany wprost w pliku (kolumna profilu) ma NIEZNANY kierunek. Wybiera
 * orientację (r albo 1/r) bliższą kursowi z kwot i zwraca go w konwencji
 * `fxExchangeRate`. Gdy żadna orientacja nie pasuje (±10%) — kurs z kwot.
 */
export function orientFxRate(
  explicitRate: number | undefined,
  from: { amount: number; currency: string },
  to: { amount: number; currency: string },
): number | undefined {
  const fromAmounts = fxExchangeRate(from, to);
  if (!explicitRate || !(explicitRate > 0)) return fromAmounts;
  if (!fromAmounts) return roundFxRate(explicitRate);
  const close = (a: number) => Math.abs(a / fromAmounts - 1) <= 0.1;
  if (close(explicitRate)) return roundFxRate(explicitRate);
  if (close(1 / explicitRate)) return roundFxRate(1 / explicitRate);
  return fromAmounts;
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
  return /^[+-]?\d+(\.\d+)?$/.test(normalizeNumericText(value));
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

/**
 * Parse ING date-time: DD-MM-YYYY + czas HH:MM:SS lub HH-MM-SS (archiwalne
 * eksporty ~2020 mają czas z myślnikami: "28-12-2020 09-00-00").
 * "29-08-2023 14:25:33" -> "2023-08-29T14:25:33"
 * "29-08-2023"          -> "2023-08-29T00:00:00"
 * Nierozpoznany format zwraca wejście bez zmian (konwencja parseDottedDate).
 */
export function parseDashedDateTime(dateStr: string): string {
  const match = dateStr.match(/(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2})[:-](\d{2})[:-](\d{2}))?/);
  if (match) {
    const time = match[4] ? `${match[4]}:${match[5]}:${match[6]}` : '00:00:00';
    return `${match[3]}-${match[2]}-${match[1]}T${time}`;
  }
  return dateStr;
}
