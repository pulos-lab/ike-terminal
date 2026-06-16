import type { DateFormat, RowClass } from 'shared';
import { validateImportProfile } from 'shared';

/**
 * Logika kreatora importu uniwersalnego — czysta (testowalna bez Reacta):
 * - ProfileDraft: stan formularza MappingEditora (indeksy kolumn, -1 = brak),
 * - suggestDraft(): heurystyczny prefill mapowania z nazw nagłówków i próbki,
 * - buildProfileFromDraft(): draft → JSON ImportProfile + walidacja schematem.
 *
 * Kreator obsługuje dwa tryby:
 * - 'all-trades' — każdy wiersz z datą to transakcja (typowy eksport historii),
 * - 'rules'      — reguły klasyfikacji (pliki operacji / mieszane).
 * Mapowanie pól gotówkowych jest WSPÓLNE dla wszystkich klas (jeden plik =
 * jeden układ kolumn) — profil powiela je per klasa, zgodnie ze spec.
 */

export interface DraftClassifyRule {
  id: string;
  /** Indeks kolumny dyskryminatora; -1 = niewybrana. */
  colIndex: number;
  op: 'contains' | 'equals' | 'startsWith' | 'notEmpty';
  /** Wartości rozdzielone przecinkami (ignorowane dla notEmpty). */
  values: string;
  emit: RowClass;
}

export interface DraftTradeMapping {
  dateCol: number;
  dateFormat: DateFormat;
  paperNameCol: number;
  /** -1 = brak ISIN w pliku → pseudo-ISIN + rezolucja po nazwie. */
  isinCol: number;
  quantityCol: number;
  priceCol: number;
  valueCol: number;
  commissionCol: number;
  totalCol: number;
  currencyCol: number;
  currencyFallback: string;
  sideStrategy: 'column' | 'signedQuantity' | 'signedAmount';
  sideCol: number;
  /** Wartości rozdzielone przecinkami, np. "K, BUY, Kupno". */
  buyValues: string;
  sellValues: string;
  wholeShares: boolean;
}

export interface DraftCashMapping {
  dateCol: number;
  dateFormat: DateFormat;
  amountCol: number;
  currencyCol: number;
  currencyFallback: string;
  descriptionCol: number;
  tickerCol: number;
}

export interface ProfileDraft {
  brokerLabel: string;
  delimiter: string;
  /** Z analyze — >0 oznacza preludium metadanych → headerRow.scan. */
  headerRowIndex: number;
  headers: string[];
  mode: 'all-trades' | 'rules';
  classify: DraftClassifyRule[];
  defaultClass: 'skip' | 'other';
  trade: DraftTradeMapping;
  cash: DraftCashMapping;
}

/** Klasy gotówkowe dostępne w edytorze reguł (kolejność = kolejność w dropdownie). */
export const RULE_CLASSES: RowClass[] = [
  'trade',
  'dividend',
  'withholding_tax',
  'coupon',
  'interest',
  'deposit',
  'withdrawal',
  'fx_leg',
  'fee',
  'trade_fee',
  'commission_refund',
  'capital_return',
  'other',
  'skip',
];

export const ROW_CLASS_LABELS: Record<RowClass, string> = {
  trade: 'Transakcja (K/S)',
  dividend: 'Dywidenda',
  withholding_tax: 'Podatek od dywidendy',
  coupon: 'Kupon obligacji',
  interest: 'Odsetki',
  deposit: 'Wpłata',
  withdrawal: 'Wypłata',
  fx_leg: 'Wymiana walut',
  fee: 'Opłata',
  trade_fee: 'Koszt pozycji (swap)',
  commission_refund: 'Zwrot prowizji',
  capital_return: 'Zwrot kapitału',
  other: 'Inna operacja',
  skip: 'Pomiń wiersz',
};

export const DATE_FORMATS: DateFormat[] = [
  'YYYY-MM-DD',
  'DD.MM.YYYY',
  'DD-MM-YYYY',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'YYYY.MM.DD',
  'YYYY/MM/DD',
  'DD.MM.YY',
  'DD/MM/YY',
  'DD-MMM-YYYY',
  'DD MMM YYYY',
  'MMM DD, YYYY',
];

// ── Heurystyczny prefill ─────────────────────────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase();

/** Pierwsza kolumna, której znormalizowana nazwa pasuje do któregoś wzorca. */
function findCol(headers: string[], patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const idx = headers.findIndex((h) => pattern.test(norm(h)));
    if (idx >= 0) return idx;
  }
  return -1;
}

const DATE_FORMAT_PATTERNS: Array<{ format: DateFormat; re: RegExp; dayFirst?: boolean }> = [
  { format: 'YYYY-MM-DD', re: /^\d{4}-\d{1,2}-\d{1,2}/ },
  { format: 'YYYY.MM.DD', re: /^\d{4}\.\d{1,2}\.\d{1,2}/ },
  { format: 'YYYY/MM/DD', re: /^\d{4}\/\d{1,2}\/\d{1,2}/ },
  { format: 'DD.MM.YYYY', re: /^\d{1,2}\.\d{1,2}\.\d{4}/ },
  { format: 'DD-MM-YYYY', re: /^\d{1,2}-\d{1,2}-\d{4}/ },
  { format: 'DD/MM/YYYY', re: /^\d{1,2}\/\d{1,2}\/\d{4}/, dayFirst: true },
];

/**
 * Wykryj format daty z wartości próbki. Dla XX/XX/YYYY rozstrzyga zawartość:
 * pierwszy człon >12 → DD/MM, drugi człon >12 → MM/DD (inaczej zostaje DD/MM).
 */
export function detectDateFormat(samples: string[]): DateFormat {
  for (const { format, re, dayFirst } of DATE_FORMAT_PATTERNS) {
    const matching = samples.filter((s) => re.test(s.trim()));
    if (matching.length === 0) continue;
    if (!dayFirst) return format;
    for (const value of matching) {
      const [a, b] = value.trim().split('/').map(Number);
      if (a > 12) return 'DD/MM/YYYY';
      if (b > 12) return 'MM/DD/YYYY';
    }
    return 'DD/MM/YYYY';
  }
  return 'YYYY-MM-DD';
}

const BUY_VALUE_RE = /^(k|b|buy|kupno|nabycie|zakup|purchase|stock purchase|open)$/i;
const SELL_VALUE_RE = /^(s|sell|sprzedaż|sprzedaz|zbycie|sale|stock sale|close)$/i;

/** Wartości kolumny w próbce (unikalne, niepuste, max `limit`). */
function distinctValues(sampleRows: string[][], col: number, limit = 8): string[] {
  const seen = new Set<string>();
  for (const row of sampleRows) {
    const v = (row[col] ?? '').trim();
    if (v) seen.add(v);
    if (seen.size > limit) break;
  }
  return [...seen];
}

/** Heurystyczny prefill draftu z nagłówków i (zredagowanej) próbki. */
export function suggestDraft(
  headers: string[],
  sampleRows: string[][],
  meta: { delimiter: string; headerRowIndex: number },
): ProfileDraft {
  const dateCol = findCol(headers, [/^(data|date|czas|time|datum)\b/, /(data|date|czas|time)/]);
  const isinCol = findCol(headers, [/isin/]);
  const paperNameCol = findCol(headers, [
    /^(papier|walor|instrument|produkt|security|nazwa|name|symbol|ticker)/,
    /(papier|walor|instrument|produkt|security|symbol|ticker)/,
  ]);
  const quantityCol = findCol(headers, [/(ilość|ilosc|liczba|shares|quantity|qty|volume|sztuk)/]);
  const priceCol = findCol(headers, [/(cena|kurs|price)/]);
  const valueCol = findCol(headers, [/(wartość|wartosc|value)/]);
  const commissionCol = findCol(headers, [/(prowizja|commission)/]);
  const currencyCol = findCol(headers, [/(waluta|currency|ccy)/]);
  const sideCol = findCol(headers, [
    /^(k\/s|strona|side|direction|kierunek)$/,
    /(k\/s|strona|side|direction|typ|type|rodzaj|operacja)/,
  ]);
  const amountCol = findCol(headers, [/(kwota|amount)/]);
  const descriptionCol = findCol(headers, [/(tytuł|tytul|opis|description|comment|komentarz)/]);

  const dateSamples = dateCol >= 0 ? sampleRows.map((r) => r[dateCol] ?? '') : [];
  const dateFormat = detectDateFormat(dateSamples);

  // Strona K/S: spróbuj rozpoznać wartości kupna/sprzedaży w kolumnie strony.
  let buyValues = 'K, BUY, Kupno';
  let sellValues = 'S, SELL, Sprzedaż';
  if (sideCol >= 0) {
    const values = distinctValues(sampleRows, sideCol);
    const buys = values.filter((v) => BUY_VALUE_RE.test(v));
    const sells = values.filter((v) => SELL_VALUE_RE.test(v));
    if (buys.length > 0) buyValues = buys.join(', ');
    if (sells.length > 0) sellValues = sells.join(', ');
  }

  return {
    brokerLabel: '',
    delimiter: meta.delimiter,
    headerRowIndex: meta.headerRowIndex,
    headers,
    mode: 'all-trades',
    classify: [],
    defaultClass: 'skip',
    trade: {
      dateCol,
      dateFormat,
      paperNameCol,
      isinCol,
      quantityCol,
      priceCol,
      valueCol,
      commissionCol,
      totalCol: -1,
      currencyCol,
      currencyFallback: 'PLN',
      sideStrategy: sideCol >= 0 ? 'column' : 'signedQuantity',
      sideCol: sideCol >= 0 ? sideCol : quantityCol,
      buyValues,
      sellValues,
      wholeShares: false,
    },
    cash: {
      dateCol,
      dateFormat,
      amountCol,
      currencyCol,
      currencyFallback: 'PLN',
      descriptionCol,
      tickerCol: -1,
    },
  };
}

// ── Draft → ImportProfile ────────────────────────────────────────────────────

const splitValues = (raw: string): string[] =>
  raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const col = (index: number) => ({ kind: 'column' as const, col: index });
const colWithFallback = (index: number, fallback: string) =>
  fallback ? { kind: 'column' as const, col: index, fallback } : col(index);

/** Klasy gotówkowe, dla których ma sens kolumna tickera. */
const TICKER_CLASSES = new Set<RowClass>([
  'dividend',
  'withholding_tax',
  'coupon',
  'fee',
  'trade_fee',
]);

export interface BuildResult {
  ok: boolean;
  profile?: unknown;
  errors?: string[];
}

/**
 * Buduje JSON ImportProfile z draftu i waliduje schematem (te same komunikaty
 * PL co backend). Zwraca profil jako surowy obiekt — to on idzie do preview/commit.
 */
export function buildProfileFromDraft(draft: ProfileDraft): BuildResult {
  const errors: string[] = [];

  const classify: Array<Record<string, unknown>> = [];
  if (draft.mode === 'all-trades') {
    if (draft.trade.dateCol < 0) errors.push('Wybierz kolumnę daty transakcji');
    classify.push({
      id: 'trade',
      when: [{ col: draft.trade.dateCol, op: 'notEmpty' }],
      emit: 'trade',
    });
  } else {
    if (draft.classify.length === 0) errors.push('Dodaj co najmniej jedną regułę klasyfikacji');
    draft.classify.forEach((rule, i) => {
      if (rule.colIndex < 0) {
        errors.push(`Reguła ${i + 1}: wybierz kolumnę`);
        return;
      }
      const values = splitValues(rule.values);
      if (rule.op !== 'notEmpty' && values.length === 0) {
        errors.push(`Reguła ${i + 1}: podaj wartości (rozdzielone przecinkami)`);
        return;
      }
      classify.push({
        id: `rule-${i + 1}`,
        when: [
          rule.op === 'notEmpty'
            ? { col: rule.colIndex, op: 'notEmpty' }
            : { col: rule.colIndex, op: rule.op, values },
        ],
        emit: rule.emit,
      });
    });
  }

  const emitted = new Set<RowClass>(
    draft.mode === 'all-trades'
      ? ['trade']
      : draft.classify.map((r) => r.emit).filter((c): c is RowClass => c !== 'skip'),
  );
  if (draft.defaultClass === 'other') emitted.add('other');

  const profile: Record<string, unknown> = {
    specVersion: 1,
    brokerLabel: draft.brokerLabel.trim() || 'Nieznany broker',
    file: {
      delimiter: draft.delimiter,
      headerRow:
        draft.headerRowIndex > 0
          ? {
              strategy: 'scan',
              // Sygnatura: 2-3 najdłuższe nazwy nagłówków (najbardziej charakterystyczne).
              signature: [...draft.headers]
                .filter((h) => h.trim())
                .sort((a, b) => b.length - a.length)
                .slice(0, 3),
            }
          : { strategy: 'first' },
    },
    classify,
    defaultClass: draft.defaultClass,
  };

  if (emitted.has('trade')) {
    const t = draft.trade;
    if (t.dateCol < 0) errors.push('Transakcje: wybierz kolumnę daty');
    if (t.paperNameCol < 0) errors.push('Transakcje: wybierz kolumnę nazwy papieru');
    if (t.quantityCol < 0) errors.push('Transakcje: wybierz kolumnę ilości');
    if (t.priceCol < 0) errors.push('Transakcje: wybierz kolumnę ceny');
    if (t.currencyCol < 0 && !t.currencyFallback.trim()) {
      errors.push('Transakcje: wybierz kolumnę waluty albo podaj walutę domyślną');
    }
    if (t.sideStrategy === 'column') {
      if (t.sideCol < 0) errors.push('Transakcje: wybierz kolumnę strony (K/S)');
      if (splitValues(t.buyValues).length === 0) errors.push('Transakcje: podaj wartości kupna');
      if (splitValues(t.sellValues).length === 0)
        errors.push('Transakcje: podaj wartości sprzedaży');
    } else if (t.sideCol < 0) {
      errors.push('Transakcje: wybierz kolumnę dla znaku ilości/kwoty');
    }

    profile.trade = {
      date: { source: col(t.dateCol), formats: [t.dateFormat] },
      paperName: col(t.paperNameCol),
      ...(t.isinCol >= 0 ? { isin: col(t.isinCol) } : {}),
      quantity: col(t.quantityCol),
      wholeShares: t.wholeShares,
      price: col(t.priceCol),
      ...(t.valueCol >= 0 ? { value: col(t.valueCol) } : {}),
      ...(t.commissionCol >= 0 ? { commission: col(t.commissionCol) } : {}),
      ...(t.totalCol >= 0 ? { total: col(t.totalCol) } : {}),
      currency:
        t.currencyCol >= 0
          ? colWithFallback(t.currencyCol, t.currencyFallback.trim().toUpperCase())
          : { kind: 'const', value: t.currencyFallback.trim().toUpperCase() || 'PLN' },
      side:
        t.sideStrategy === 'column'
          ? {
              strategy: 'column',
              col: t.sideCol,
              buyValues: splitValues(t.buyValues),
              sellValues: splitValues(t.sellValues),
            }
          : { strategy: t.sideStrategy, col: t.sideCol },
    };
    if (t.isinCol < 0) profile.needsNameResolution = true;
  }

  const cashClasses = [...emitted].filter((c) => c !== 'trade' && c !== 'skip');
  if (cashClasses.length > 0) {
    const c = draft.cash;
    if (c.dateCol < 0) errors.push('Operacje: wybierz kolumnę daty');
    if (c.amountCol < 0) errors.push('Operacje: wybierz kolumnę kwoty');
    if (c.currencyCol < 0 && !c.currencyFallback.trim()) {
      errors.push('Operacje: wybierz kolumnę waluty albo podaj walutę domyślną');
    }

    const cashMapping: Record<string, unknown> = {
      date: { source: col(c.dateCol), formats: [c.dateFormat] },
      amount: col(c.amountCol),
      currency:
        c.currencyCol >= 0
          ? colWithFallback(c.currencyCol, c.currencyFallback.trim().toUpperCase())
          : { kind: 'const', value: c.currencyFallback.trim().toUpperCase() || 'PLN' },
      ...(c.descriptionCol >= 0 ? { description: col(c.descriptionCol) } : {}),
    };
    const mappingKey: Partial<Record<RowClass, string>> = {
      dividend: 'dividend',
      withholding_tax: 'withholdingTax',
      coupon: 'coupon',
      interest: 'interest',
      deposit: 'deposit',
      withdrawal: 'withdrawal',
      fx_leg: 'fxLeg',
      fee: 'fee',
      trade_fee: 'tradeFee',
      commission_refund: 'commissionRefund',
      capital_return: 'capitalReturn',
      other: 'other',
    };
    for (const cls of cashClasses) {
      const key = mappingKey[cls];
      if (!key) continue;
      profile[key] = {
        ...cashMapping,
        ...(c.tickerCol >= 0 && TICKER_CLASSES.has(cls) ? { ticker: col(c.tickerCol) } : {}),
      };
    }
    // Podatek od dywidend parowany z dywidendą po tickerze+dacie (netto).
    if (emitted.has('withholding_tax')) {
      profile.pairing = {
        dividendWht: { matchBy: ['ticker', 'date'], windowDays: 0, handling: 'subtract' },
      };
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const validation = validateImportProfile(profile);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, profile };
}

// ── Adopcja podobnego profilu (P1: anty-dryf formatu) ────────────────────────

/**
 * Sklonuj profil z biblioteki (sugestia o podobnych nagłówkach) do użycia na
 * BIEŻĄCYM pliku. Profil mógł powstać dla innego delimitera/arkusza, a silnik
 * parsuje treść po `file.delimiter` — więc nadpisujemy delimiter (i nazwę
 * arkusza dla XLSX) wartościami z analizy tego pliku. Reszta mapowania (kolumny
 * po NAZWIE, reguły klasyfikacji, parowanie) przenosi się 1:1. Podgląd po
 * adopcji jest dry-runem: jeśli układ jednak nie pasuje, użytkownik to zobaczy.
 *
 * Zwraca surowy obiekt (jak buildProfileFromDraft) — idzie wprost do preview/commit.
 */
export function adoptProfileForDocument(
  profileJson: unknown,
  doc: { delimiter: string; sheet?: string },
): unknown {
  const clone = structuredClone(profileJson) as { file?: Record<string, unknown> } | null;
  if (clone && typeof clone === 'object' && clone.file && typeof clone.file === 'object') {
    clone.file.delimiter = doc.delimiter;
    if (doc.sheet !== undefined) clone.file.sheet = doc.sheet;
    else delete clone.file.sheet;
  }
  return clone;
}
