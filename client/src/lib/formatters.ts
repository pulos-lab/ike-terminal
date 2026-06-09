/**
 * Format number as PLN currency
 */
export function formatPLN(value: number): string {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency: 'PLN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format number as USD currency
 */
function formatUSD(value: number): string {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format currency by code
 */
export function formatCurrency(value: number, currency: string): string {
  if (currency === 'PLN') return formatPLN(value);
  if (currency === 'USD') return formatUSD(value);
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value);
}

/**
 * Format number with Polish locale
 */
export function formatNumber(value: number, decimals = 2): string {
  return new Intl.NumberFormat('pl-PL', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Format percentage
 */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Format date as DD.MM.YYYY.
 *
 * Czysty string slicing zamiast `new Date()` — `new Date('2024-05-03')` parsuje
 * jako UTC midnight, więc `toLocaleDateString` w strefach na zachód od UTC
 * pokazywało POPRZEDNI dzień. Daty domenowe (data transakcji/dywidendy) są
 * kalendarzowe, nie chwilowe — nie wolno ich przepuszczać przez strefę czasową.
 *
 * Akceptuje 'YYYY-MM-DD' oraz ISO datetime ('YYYY-MM-DDTHH:MM:SS[Z]' /
 * 'YYYY-MM-DD HH:MM:SS'). Nierozpoznany input przechodzi bez zmian.
 */
export function formatDate(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})($|[T ])/.exec(dateStr);
  if (!m) return dateStr;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/**
 * SQLite CURRENT_TIMESTAMP zapisuje UTC bez oznaczenia strefy
 * ('YYYY-MM-DD HH:MM:SS'). Tu Date round-trip jest CELOWY: normalizujemy do
 * ISO + 'Z' i pokazujemy datę w lokalnej strefie użytkownika (timestamp to
 * moment w czasie, w przeciwieństwie do dat kalendarzowych w formatDate).
 * Nieparsowalny input przechodzi bez zmian.
 */
export function formatTimestampLocal(timestamp: string): string {
  const iso = timestamp.replace(' ', 'T');
  const withZone = /(Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(withZone);
  if (isNaN(d.getTime())) return timestamp;
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Format quantity — integer if whole, up to 4 decimal places for small
 * fractional values (CFD volumes like 0.035), 2 for larger values.
 */
export function formatQuantity(qty: number): string {
  if (qty % 1 === 0) return qty.toString();
  return qty < 1 ? parseFloat(qty.toFixed(4)).toString() : qty.toFixed(2);
}
