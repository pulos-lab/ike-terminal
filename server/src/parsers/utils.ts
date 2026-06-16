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
 * Total transakcji wg konwencji K/S: kupno powiększa wartość o prowizję,
 * sprzedaż ją pomniejsza. Zaokrąglone do 2 miejsc (waluta).
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
