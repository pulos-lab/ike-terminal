import type { ColRef, DateFormat, DateSpec, ValueSource } from 'shared';
import { parseNumber } from '../utils.js';

/**
 * Resolver wartości profilu generycznego: kolumny (ColRef), źródła wartości
 * (ValueSource) i daty (DateSpec → ISO 8601). Wszystkie odwołania do kolumn
 * są rozwiązywane przez ColumnResolver na podstawie wiersza nagłówka — brak
 * kolumny to twardy błąd (PL), nie ciche puste pole.
 */

/** Błąd wykonania profilu — komunikat po polsku, prezentowany użytkownikowi. */
export class GenericParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenericParseError';
  }
}

/** Normalizacja nazwy nagłówka do porównań: trim, lowercase, pojedyncze spacje. */
export function normalizeHeaderName(name: string): string {
  return name.replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Rozwiązuje ColRef → indeks kolumny na podstawie wiersza nagłówka.
 * Wyniki są cache'owane — profil odwołuje się do tych samych kolumn wielokrotnie.
 */
export class ColumnResolver {
  private readonly normalized: string[];
  private readonly cache = new Map<string, number>();

  constructor(
    private readonly headers: string[],
    /** Jawny separator dziesiętny z profilu — używany przez resolveNumber. */
    readonly decimalSeparator?: '.' | ',',
  ) {
    this.normalized = headers.map(normalizeHeaderName);
  }

  resolve(ref: ColRef): number {
    if (typeof ref === 'number') {
      if (ref >= this.headers.length) {
        throw new GenericParseError(
          `Profil odwołuje się do kolumny o indeksie ${ref}, ale nagłówek ma tylko ` +
            `${this.headers.length} kolumn.`,
        );
      }
      return ref;
    }
    // ?? 0: profil może przyjść z bazy/LLM jako surowy JSON bez domyślnego occurrence.
    const occurrence = ref.occurrence ?? 0;
    const key = `${normalizeHeaderName(ref.name)}#${occurrence}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const wanted = normalizeHeaderName(ref.name);
    let seen = 0;
    for (let i = 0; i < this.normalized.length; i++) {
      if (this.normalized[i] === wanted) {
        if (seen === occurrence) {
          this.cache.set(key, i);
          return i;
        }
        seen++;
      }
    }
    throw new GenericParseError(
      seen === 0
        ? `W nagłówku pliku brakuje kolumny "${ref.name}" wymaganej przez profil.`
        : `Profil oczekuje ${occurrence + 1}. wystąpienia kolumny "${ref.name}", ` +
            `ale w nagłówku jest ich tylko ${seen}.`,
    );
  }

  /** Komórka wiersza wskazana przez ColRef (trim); undefined gdy wiersz krótszy. */
  cell(row: string[], ref: ColRef): string | undefined {
    const idx = this.resolve(ref);
    const raw = row[idx];
    return raw === undefined ? undefined : String(raw).trim();
  }
}

/** Cache skompilowanych regexów (pattern+flags) — profile używają ich per wiersz. */
const regexCache = new Map<string, RegExp>();

export function compileRegex(pattern: string, flags = ''): RegExp {
  const key = `${flags}::${pattern}`;
  let re = regexCache.get(key);
  if (!re) {
    try {
      re = new RegExp(pattern, flags);
    } catch {
      throw new GenericParseError(`Niepoprawne wyrażenie regularne w profilu: ${pattern}`);
    }
    regexCache.set(key, re);
  }
  return re;
}

/** Wartość ValueSource dla danego wiersza (string, bez parsowania liczb/dat). */
export function resolveValueSource(
  vs: ValueSource,
  row: string[],
  resolver: ColumnResolver,
): string | undefined {
  switch (vs.kind) {
    case 'column': {
      const cell = resolver.cell(row, vs.col);
      return cell || vs.fallback;
    }
    case 'const':
      return vs.value;
    case 'regexExtract': {
      const cell = resolver.cell(row, vs.col);
      if (!cell) return vs.fallback;
      const match = cell.match(compileRegex(vs.pattern));
      if (!match) return vs.fallback;
      const group = match[vs.group];
      return group !== undefined ? group.trim() : vs.fallback;
    }
  }
}

/**
 * Liczba z ValueSource. Gdy profil deklaruje separator dziesiętny (resolver
 * niesie go z file.decimalSeparator) — parsujemy deterministycznie; inaczej
 * fallback do parseNumber (auto-detekcja separatorów, jak parsery wbudowane).
 */
export function resolveNumber(vs: ValueSource, row: string[], resolver: ColumnResolver): number {
  const raw = resolveValueSource(vs, row, resolver);
  return resolver.decimalSeparator
    ? parseNumberWithLocale(raw, resolver.decimalSeparator)
    : parseNumber(raw);
}

/**
 * Parsowanie liczby z JAWNYM separatorem dziesiętnym (bez zgadywania):
 * - ',' dziesiętny → usuń '.' i spacje (tysięczne), zamień ',' na '.',
 * - '.' dziesiętny → usuń ',' i spacje (tysięczne).
 * Zwraca 0 dla pustych/NaN (kontrakt jak parseNumber).
 */
export function parseNumberWithLocale(
  value: string | undefined,
  decimalSeparator: '.' | ',',
): number {
  if (!value) return 0;
  const noSpace = value.toString().replace(/\s/g, '');
  const cleaned =
    decimalSeparator === ','
      ? noSpace.replace(/\./g, '').replace(',', '.')
      : noSpace.replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ── Daty ─────────────────────────────────────────────────────────────────────

/**
 * Regexy formatów: grupy (1,2,3) wg kolejności w formacie + opcjonalny sufiks
 * czasu HH:MM(:SS) jako grupa 4 w tej samej komórce (Bossa: "25.02.2026 09:47:27").
 * Ułamki sekund są tolerowane i ucinane (Trading 212: "...17:08:00.000").
 * Warianty: rok 2-cyfrowy (year2digit, pivot) oraz nazwa miesiąca (monthName, EN+PL).
 */
interface DatePattern {
  re: RegExp;
  order: 'YMD' | 'DMY' | 'MDY';
  /** Rok 2-cyfrowy → pivot: 00–69 = 20xx, 70–99 = 19xx. */
  year2digit?: boolean;
  /** Grupa miesiąca to NAZWA (Jan/January/sty/stycznia) → monthNameToNumber. */
  monthName?: boolean;
}

// Klasa znaków nazwy miesiąca: ASCII + polskie diakrytyki (np. „paź", „września").
const MONTH_RE = '[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]{3,}';

const DATE_PATTERNS: Record<DateFormat, DatePattern> = {
  'YYYY-MM-DD': {
    re: /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,6})?)?$/,
    order: 'YMD',
  },
  'YYYY.MM.DD': {
    re: /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,6})?)?$/,
    order: 'YMD',
  },
  'YYYY/MM/DD': {
    re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,6})?)?$/,
    order: 'YMD',
  },
  'DD.MM.YYYY': {
    re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,6})?)?$/,
    order: 'DMY',
  },
  'DD-MM-YYYY': {
    re: /^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,6})?)?$/,
    order: 'DMY',
  },
  'DD/MM/YYYY': {
    re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,6})?)?$/,
    order: 'DMY',
  },
  'MM/DD/YYYY': {
    re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,6})?)?$/,
    order: 'MDY',
  },
  'DD.MM.YY': {
    re: /^(\d{1,2})\.(\d{1,2})\.(\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,6})?)?$/,
    order: 'DMY',
    year2digit: true,
  },
  'DD/MM/YY': {
    re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,6})?)?$/,
    order: 'DMY',
    year2digit: true,
  },
  'DD-MMM-YYYY': {
    re: new RegExp(
      `^(\\d{1,2})-(${MONTH_RE})-(\\d{4})(?:[ T](\\d{2}:\\d{2}(?::\\d{2})?)(?:\\.\\d{1,6})?)?$`,
    ),
    order: 'DMY',
    monthName: true,
  },
  'DD MMM YYYY': {
    re: new RegExp(
      `^(\\d{1,2})\\s+(${MONTH_RE})\\s+(\\d{4})(?:[ T](\\d{2}:\\d{2}(?::\\d{2})?)(?:\\.\\d{1,6})?)?$`,
    ),
    order: 'DMY',
    monthName: true,
  },
  'MMM DD, YYYY': {
    re: new RegExp(
      `^(${MONTH_RE})\\s+(\\d{1,2}),?\\s+(\\d{4})(?:[ T](\\d{2}:\\d{2}(?::\\d{2})?)(?:\\.\\d{1,6})?)?$`,
    ),
    order: 'MDY',
    monthName: true,
  },
};

/** Skróty nazw miesięcy (pierwsze 3 litery bez diakrytyków) → numer; EN + PL. */
const MONTH_ABBR: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  sty: 1,
  lut: 2,
  kwi: 4,
  maj: 5,
  cze: 6,
  lip: 7,
  sie: 8,
  wrz: 9,
  paz: 10,
  lis: 11,
  gru: 12,
};

/** Nazwa miesiąca (EN/PL, skrót lub pełna) → 1..12; 0 gdy nieznana. */
export function monthNameToNumber(name: string): number {
  const key = name.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').slice(0, 3);
  return MONTH_ABBR[key] ?? 0;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "9:47" / "09:47" / "09:47:27" → "09:47:27"; null gdy nie wygląda na czas. */
function normalizeTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,6})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  return `${pad2(h)}:${m[2]}:${m[3] ?? '00'}`;
}

/**
 * Parsuje datę wg listy formatów (pierwszy pasujący wygrywa) → ISO 8601
 * "YYYY-MM-DDTHH:MM:SS". `timeRaw` (osobna kolumna czasu) wygrywa z czasem
 * doklejonym w komórce daty. Zwraca null gdy żaden format nie pasuje.
 */
export function parseDateWithFormats(
  raw: string | undefined,
  formats: DateFormat[],
  timeRaw?: string,
): string | null {
  if (!raw) return null;
  const value = raw.trim();
  for (const format of formats) {
    const def = DATE_PATTERNS[format];
    const m = value.match(def.re);
    if (!m) continue;
    // Grupy 1-3 → [year, month, day] wg kolejności formatu (month bywa nazwą).
    const g: [string, string, string] = [m[1], m[2], m[3]];
    const [yearStr, monthStr, dayStr] =
      def.order === 'YMD'
        ? [g[0], g[1], g[2]]
        : def.order === 'DMY'
          ? [g[2], g[1], g[0]]
          : [g[2], g[0], g[1]]; // MDY
    const month = def.monthName ? monthNameToNumber(monthStr) : Number(monthStr);
    const day = Number(dayStr);
    let year = Number(yearStr);
    if (def.year2digit) year = year <= 69 ? 2000 + year : 1900 + year;
    if (!month || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const time = normalizeTime(timeRaw) ?? normalizeTime(m[4]) ?? '00:00:00';
    return `${year}-${pad2(month)}-${pad2(day)}T${time}`;
  }
  return null;
}

/** DateSpec → ISO 8601 dla danego wiersza; null gdy nie udało się sparsować. */
export function resolveDate(
  spec: DateSpec,
  row: string[],
  resolver: ColumnResolver,
): string | null {
  const raw = resolveValueSource(spec.source, row, resolver);
  const timeRaw = spec.timeSource ? resolveValueSource(spec.timeSource, row, resolver) : undefined;
  return parseDateWithFormats(raw, spec.formats, timeRaw);
}
