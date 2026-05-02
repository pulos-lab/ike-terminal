/**
 * Shared parser utilities — numeric parsing, rounding, date conversion.
 */

/**
 * Parse European number format: "1 234,56" -> 1234.56
 * Handles whitespace thousands separators and comma decimal separator.
 * Returns 0 for undefined/empty/NaN values.
 */
export function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.toString().replace(/\s/g, '').replace(',', '.');
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
