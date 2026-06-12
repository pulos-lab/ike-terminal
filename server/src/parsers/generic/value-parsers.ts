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

  constructor(private readonly headers: string[]) {
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

/** Jak resolveValueSource, ale przez parseNumber (formaty europejskie). */
export function resolveNumber(vs: ValueSource, row: string[], resolver: ColumnResolver): number {
  return parseNumber(resolveValueSource(vs, row, resolver));
}

// ── Daty ─────────────────────────────────────────────────────────────────────

/**
 * Regexy formatów: grupy (1,2,3) wg kolejności w formacie + opcjonalny sufiks
 * czasu HH:MM(:SS) w tej samej komórce (Bossa: "25.02.2026 09:47:27").
 * Ułamki sekund są tolerowane i ucinane (Trading 212: "...17:08:00.000").
 */
const DATE_PATTERNS: Record<DateFormat, { re: RegExp; order: 'YMD' | 'DMY' | 'MDY' }> = {
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
};

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
    const { re, order } = DATE_PATTERNS[format];
    const m = value.match(re);
    if (!m) continue;
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const [year, month, day] =
      order === 'YMD' ? [a, b, c] : order === 'DMY' ? [c, b, a] : [c, a, b];
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
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
