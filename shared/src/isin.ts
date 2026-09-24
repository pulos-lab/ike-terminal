/**
 * ISIN (ISO 6166): 2 litery kraju + 9 znaków alfanumerycznych + cyfra kontrolna.
 * Jedno źródło prawdy zamiast kopii wyrażeń regularnych w parserach i serwisach —
 * część była „luźna" (ostatni znak mógł być literą), część ścisła.
 */
export const ISIN_PATTERN = '[A-Z]{2}[A-Z0-9]{9}[0-9]';

const ISIN_SHAPE_RE = new RegExp(`^${ISIN_PATTERN}$`);

/** Czy tekst ma kształt ISIN (bez sprawdzania cyfry kontrolnej). */
export function isIsinShape(value: string | null | undefined): boolean {
  return !!value && ISIN_SHAPE_RE.test(value);
}

/**
 * Pełna walidacja ISIN: kształt + cyfra kontrolna (Luhn na cyfrach, litery A=10…Z=35).
 * Odróżnia prawdziwy ISIN od 12-znakowego pseudo-identyfikatora z nazwy papieru.
 */
export function isValidIsin(value: string | null | undefined): boolean {
  if (!isIsinShape(value)) return false;
  const digits = value!
    .split('')
    .map((ch) => (ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch))
    .join('');
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
