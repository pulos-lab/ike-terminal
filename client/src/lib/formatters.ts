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
 * Format date as DD.MM.YYYY
 */
export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Format date with time
 */

/**
 * Format quantity — integer if whole, up to 4 decimal places for small
 * fractional values (CFD volumes like 0.035), 2 for larger values.
 */
export function formatQuantity(qty: number): string {
  if (qty % 1 === 0) return qty.toString();
  return qty < 1 ? parseFloat(qty.toFixed(4)).toString() : qty.toFixed(2);
}
