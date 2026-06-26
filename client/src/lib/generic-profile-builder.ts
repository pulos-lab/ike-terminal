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

// Rozpoznanie kupna/sprzedaży po TOKENACH (nie zakotwiczone) — brokerzy często
// prefiksują, np. „Market buy", „Stock sale", więc rozbijamy wartość na słowa.
const BUY_TOKENS = new Set(['k', 'b', 'buy', 'kupno', 'nabycie', 'zakup', 'purchase', 'open']);
const SELL_TOKENS = new Set(['s', 'sell', 'sprzedaż', 'sprzedaz', 'zbycie', 'sale', 'close']);
const sideTokens = (v: string) =>
  norm(v)
    .split(/[\s/_,-]+/)
    .filter(Boolean);
const isBuyValue = (v: string) => sideTokens(v).some((t) => BUY_TOKENS.has(t));
const isSellValue = (v: string) => sideTokens(v).some((t) => SELL_TOKENS.has(t));

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

/**
 * Wykryj w wskazanej kolumnie wartości oznaczające kupno/sprzedaż (do prefilla
 * pól w kreatorze). Zwraca null, gdy nic nie rozpoznano — wtedy zostają domyślne.
 */
export function suggestSideValues(
  sampleRows: string[][],
  col: number,
): { buyValues: string; sellValues: string } | null {
  if (col < 0) return null;
  const values = distinctValues(sampleRows, col);
  const buys = values.filter(isBuyValue);
  const sells = values.filter(isSellValue);
  if (buys.length === 0 && sells.length === 0) return null;
  return { buyValues: buys.join(', '), sellValues: sells.join(', ') };
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
    /^(k\/s|strona|side|direction|kierunek|action|akcja)$/,
    /(k\/s|strona|side|direction|typ|type|rodzaj|operacja|operation|action|akcja)/,
  ]);
  const amountCol = findCol(headers, [/(kwota|amount)/]);
  const descriptionCol = findCol(headers, [/(tytuł|tytul|opis|description|comment|komentarz)/]);

  const dateSamples = dateCol >= 0 ? sampleRows.map((r) => r[dateCol] ?? '') : [];
  const dateFormat = detectDateFormat(dateSamples);

  // Strona K/S: spróbuj rozpoznać wartości kupna/sprzedaży w kolumnie strony.
  let buyValues = 'K, BUY, Kupno';
  let sellValues = 'S, SELL, Sprzedaż';
  const detectedSide = suggestSideValues(sampleRows, sideCol);
  if (detectedSide) {
    if (detectedSide.buyValues) buyValues = detectedSide.buyValues;
    if (detectedSide.sellValues) sellValues = detectedSide.sellValues;
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

// ── Ocena pewności mapowania (skan próbki) ───────────────────────────────────

/** Status pojedynczego pola po skanie: pewne / niepewne / brak. */
export type FieldStatus = 'ok' | 'uncertain' | 'missing';

/** Pola oceniane w trybie all-trades (wymagane do importu transakcji). */
export type ScoredField = 'date' | 'paperName' | 'quantity' | 'price' | 'currency' | 'side';

export interface DraftScore {
  /** Werdykt sterujący gałęzią kreatora. */
  verdict: 'complete' | 'near' | 'incomplete';
  /** Status każdego ocenianego pola. */
  fields: Record<ScoredField, FieldStatus>;
  /** Pola do dopytania (status ≠ 'ok'), w kolejności wyświetlania. */
  gaps: ScoredField[];
  /** Plik wygląda na operacje gotówkowe (kwota bez ilości/ceny) → tryb reguł. */
  operationsLike: boolean;
}

/** Czy wartość wygląda na liczbę (toleruje separatory PL/EN, spacje, nawiasy). */
function looksNumeric(raw: string): boolean {
  const cleaned = raw.trim().replace(/[^\d.,-]/g, '');
  if (!/\d/.test(cleaned)) return false;
  const normalized =
    cleaned.includes(',') && !cleaned.includes('.')
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '');
  return Number.isFinite(parseFloat(normalized));
}

/** Czy któraś wartość próbki pasuje do znanego wzorca daty. */
function looksLikeDate(samples: string[]): boolean {
  return samples.some((s) => DATE_FORMAT_PATTERNS.some((p) => p.re.test(s.trim())));
}

/**
 * Oceń draft heurystyki na (zredagowanej) próbce: które pola wymagane udało się
 * pewnie zmapować, a o które trzeba dopytać. Sterownik UI „prowadź wynikiem":
 *   complete   → wszystkie pola pewne → prosto do podglądu (0 pytań),
 *   near       → 1–2 luki → karta „uzupełnij brakujące pola",
 *   incomplete → ≥3 luki / brak daty / plik operacji → prowadź AI lub pełny edytor.
 * Liczy TYLKO tryb all-trades; tryb reguł obsługuje pełny edytor.
 */
export function scoreDraft(draft: ProfileDraft, sampleRows: string[][]): DraftScore {
  const t = draft.trade;
  const colVals = (idx: number): string[] =>
    idx >= 0 ? sampleRows.map((r) => (r[idx] ?? '').trim()).filter(Boolean) : [];
  const majorityOk = (vals: string[], pred: (v: string) => boolean): boolean =>
    vals.length > 0 && vals.filter(pred).length >= Math.ceil(vals.length / 2);

  const dateStatus: FieldStatus =
    t.dateCol < 0 ? 'missing' : looksLikeDate(colVals(t.dateCol)) ? 'ok' : 'uncertain';
  const paperStatus: FieldStatus =
    t.paperNameCol < 0 ? 'missing' : colVals(t.paperNameCol).length > 0 ? 'ok' : 'uncertain';
  const numStatus = (idx: number): FieldStatus => {
    if (idx < 0) return 'missing';
    const vals = colVals(idx);
    return vals.length === 0 ? 'uncertain' : majorityOk(vals, looksNumeric) ? 'ok' : 'uncertain';
  };
  const currencyStatus: FieldStatus =
    t.currencyCol >= 0
      ? colVals(t.currencyCol).some((v) => /^[A-Za-z]{3}$/.test(v))
        ? 'ok'
        : 'uncertain'
      : t.currencyFallback.trim()
        ? 'ok'
        : 'missing';

  // Strona: kolumna z rozpoznanymi tokenami K/S, albo znak liczby z ujemnymi w próbce.
  let sideStatus: FieldStatus;
  if (t.sideStrategy === 'column') {
    const vals = distinctValues(sampleRows, t.sideCol);
    const recognized = vals.some(isBuyValue) && vals.some(isSellValue);
    sideStatus = recognized ? 'ok' : t.sideCol >= 0 ? 'uncertain' : 'missing';
  } else {
    const signCol = t.sideCol >= 0 ? t.sideCol : t.quantityCol;
    sideStatus = colVals(signCol).some((v) => v.startsWith('-') || v.startsWith('('))
      ? 'ok'
      : 'uncertain';
  }

  const fields: Record<ScoredField, FieldStatus> = {
    date: dateStatus,
    paperName: paperStatus,
    quantity: numStatus(t.quantityCol),
    price: numStatus(t.priceCol),
    currency: currencyStatus,
    side: sideStatus,
  };

  const operationsLike = t.quantityCol < 0 && t.priceCol < 0 && draft.cash.amountCol >= 0;
  const ORDER: ScoredField[] = ['date', 'paperName', 'quantity', 'price', 'side', 'currency'];
  const gaps = ORDER.filter((f) => fields[f] !== 'ok');
  const REQUIRED: ScoredField[] = ['date', 'paperName', 'quantity', 'price', 'side'];
  const requiredGaps = REQUIRED.filter((f) => fields[f] !== 'ok');

  let verdict: DraftScore['verdict'];
  if (operationsLike || dateStatus === 'missing') verdict = 'incomplete';
  else if (requiredGaps.length === 0 && currencyStatus === 'ok') verdict = 'complete';
  else if (requiredGaps.length <= 2) verdict = 'near';
  else verdict = 'incomplete';

  return { verdict, fields, gaps, operationsLike };
}

// ── Sugestia reguł klasyfikacji (pliki operacji) ─────────────────────────────

/**
 * Słowa-klucze opisu → typ operacji. KOLEJNOŚĆ MA ZNACZENIE (first-match):
 * „podatek od dywidendy" musi trafić w podatek PRZED dywidendą.
 */
const RULE_KEYWORDS: Array<{ re: RegExp; emit: RowClass }> = [
  { re: /podatek|withhold|\bwht\b|\btax\b/i, emit: 'withholding_tax' },
  { re: /dywidend|dividend/i, emit: 'dividend' },
  { re: /kupon|coupon/i, emit: 'coupon' },
  { re: /odsetk|interest/i, emit: 'interest' },
  { re: /wpłat|wplat|zasilenie|deposit/i, emit: 'deposit' },
  { re: /wypłat|wyplat|withdraw/i, emit: 'withdrawal' },
  { re: /prowizj|commission|\bfee\b|opłat|oplat/i, emit: 'fee' },
];

/**
 * Zasiej reguły klasyfikacji z UNIKALNYCH wartości kolumny opisu — punkt startowy
 * dla plików operacji (gdzie heurystyka all-trades nie pomaga). Dla każdego
 * rozpoznanego słowa kluczowego tworzy regułę `opis contains <dopasowany fragment>`
 * → typ. Fragmenty brane są z danych (zachowują wielkość liter — silnik dopasowuje
 * case-sensitive). Wynik to SUGESTIA — użytkownik weryfikuje/edytuje w edytorze.
 */
export function suggestRules(
  headers: string[],
  sampleRows: string[][],
): { descriptionCol: number; rules: DraftClassifyRule[] } {
  const descriptionCol = findCol(headers, [
    /(tytuł|tytul|opis|description|comment|komentarz|operacj|rodzaj|typ|type)/,
  ]);
  if (descriptionCol < 0) return { descriptionCol: -1, rules: [] };

  const byEmit = new Map<RowClass, Set<string>>();
  for (const val of distinctValues(sampleRows, descriptionCol, 50)) {
    for (const { re, emit } of RULE_KEYWORDS) {
      const m = re.exec(val);
      if (m) {
        (byEmit.get(emit) ?? byEmit.set(emit, new Set()).get(emit)!).add(m[0]);
        break;
      }
    }
  }

  const rules: DraftClassifyRule[] = [];
  let i = 0;
  for (const [emit, matched] of byEmit) {
    rules.push({
      id: `rule-${i + 1}-${i}`,
      colIndex: descriptionCol,
      op: 'contains',
      values: [...matched].join(', '),
      emit,
    });
    i++;
  }
  return { descriptionCol, rules };
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

// ── Profil → Draft (reverse-map: edycja istniejącego mapowania) ──────────────

/** Klucze mapowania transakcji odwzorowywalne w edytorze. */
const DRAFT_TRADE_KEYS = new Set([
  'date',
  'paperName',
  'isin',
  'quantity',
  'wholeShares',
  'price',
  'value',
  'commission',
  'total',
  'currency',
  'side',
]);
/** Klucz profilu klasy gotówkowej → RowClass (odwrotność mappingKey z buildProfileFromDraft). */
const CASH_KEY_TO_CLASS: Record<string, RowClass> = {
  dividend: 'dividend',
  withholdingTax: 'withholding_tax',
  coupon: 'coupon',
  interest: 'interest',
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  fxLeg: 'fx_leg',
  fee: 'fee',
  tradeFee: 'trade_fee',
  commissionRefund: 'commission_refund',
  capitalReturn: 'capital_return',
  other: 'other',
};
const DRAFT_CASH_KEYS = new Set(['date', 'amount', 'currency', 'description', 'ticker']);
const DRAFT_TOP_KEYS = new Set([
  'specVersion',
  'brokerLabel',
  'file',
  'classify',
  'defaultClass',
  'trade',
  'pairing',
  'needsNameResolution',
  ...Object.keys(CASH_KEY_TO_CLASS),
]);
/** Operatory reguł odwzorowywalne w edytorze (oneOf === equals w silniku). */
const REVERSIBLE_OPS = new Set(['equals', 'oneOf', 'contains', 'startsWith', 'notEmpty']);

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

/** Indeks kolumny, gdy source = {kind:'column', col}; inaczej undefined (nieodwzorowywalne). */
function columnIndexOf(source: unknown): number | undefined {
  const s = asRecord(source);
  return s && s.kind === 'column' && typeof s.col === 'number' ? s.col : undefined;
}

function firstDateFormat(formats: unknown): DateFormat {
  return Array.isArray(formats) && typeof formats[0] === 'string'
    ? (formats[0] as DateFormat)
    : 'YYYY-MM-DD';
}

function defaultTradeMapping(): DraftTradeMapping {
  return {
    dateCol: -1,
    dateFormat: 'YYYY-MM-DD',
    paperNameCol: -1,
    isinCol: -1,
    quantityCol: -1,
    priceCol: -1,
    valueCol: -1,
    commissionCol: -1,
    totalCol: -1,
    currencyCol: -1,
    currencyFallback: 'PLN',
    sideStrategy: 'signedQuantity',
    sideCol: -1,
    buyValues: 'K, BUY, Kupno',
    sellValues: 'S, SELL, Sprzedaż',
    wholeShares: false,
  };
}
function defaultCashMapping(): DraftCashMapping {
  return {
    dateCol: -1,
    dateFormat: 'YYYY-MM-DD',
    amountCol: -1,
    currencyCol: -1,
    currencyFallback: 'PLN',
    descriptionCol: -1,
    tickerCol: -1,
  };
}

function optionalColumn(source: unknown, lossy: string[], label: string): number {
  if (source === undefined) return -1;
  const col = columnIndexOf(source);
  if (col === undefined) {
    lossy.push(`${label} (wyrażenie)`);
    return -1;
  }
  return col;
}

function currencyFromSource(source: unknown): { col: number; fallback: string } | null {
  const s = asRecord(source);
  if (!s) return null;
  if (s.kind === 'column' && typeof s.col === 'number') {
    return { col: s.col, fallback: typeof s.fallback === 'string' ? s.fallback : '' };
  }
  const value = s.value;
  if (s.kind === 'const' && typeof value === 'string') return { col: -1, fallback: value };
  return null;
}

function sideFromSource(source: unknown): {
  strategy: DraftTradeMapping['sideStrategy'];
  col: number;
  buyValues: string;
  sellValues: string;
} | null {
  const s = asRecord(source);
  const col = s?.col;
  if (!s || typeof col !== 'number') return null;
  if (s.strategy === 'column') {
    return {
      strategy: 'column',
      col,
      buyValues: Array.isArray(s.buyValues) ? s.buyValues.join(', ') : '',
      sellValues: Array.isArray(s.sellValues) ? s.sellValues.join(', ') : '',
    };
  }
  if (s.strategy === 'signedQuantity' || s.strategy === 'signedAmount') {
    return {
      strategy: s.strategy,
      col,
      buyValues: 'K, BUY, Kupno',
      sellValues: 'S, SELL, Sprzedaż',
    };
  }
  return null;
}

export interface ReverseMapResult {
  ok: boolean;
  draft?: ProfileDraft;
  /** Cechy profilu nieodwzorowane w edytorze — przepadną przy zapisie (ostrzeżenie). */
  lossy: string[];
  /** Gdy ok=false: profil zbyt złożony, by bezpiecznie edytować go w formularzu. */
  reason?: string;
}

/**
 * Odwrotność `buildProfileFromDraft`: wczytuje istniejący profil (z AI/biblioteki)
 * do edytowalnego `ProfileDraft`, by użytkownik mógł go PODKRĘCIĆ zamiast mapować
 * od zera. `meta` daje nagłówki/delimiter/headerRowIndex bieżącego pliku (profil
 * trzyma indeksy kolumn, nie nazwy). Trzy wyniki:
 *  - ok:true, lossy:[]        → wierne odwzorowanie (round-trip z buildProfileFromDraft),
 *  - ok:true, lossy:[…]       → przybliżenie; wymienione cechy (regex, kilka formatów
 *    daty, polityki pliku…) NIE są w formularzu i znikną przy zapisie → UI ostrzega,
 *  - ok:false, reason         → profil zbyt złożony (reguła regex/wielowarunkowa,
 *    kluczowe pole nie-kolumnowe) → UI zostaje przy heurystyce.
 */
export function draftFromProfile(
  profileJson: unknown,
  meta: { headers: string[]; delimiter: string; headerRowIndex: number },
): ReverseMapResult {
  const lossy: string[] = [];
  const p = asRecord(profileJson);
  if (!p) return { ok: false, lossy, reason: 'Profil ma nieoczekiwany format.' };

  for (const k of Object.keys(p)) {
    if (!DRAFT_TOP_KEYS.has(k)) lossy.push(`pole „${k}"`);
  }

  const file = asRecord(p.file) ?? ({} as Record<string, unknown>);
  if (typeof file.amountSignPolicy === 'string' && file.amountSignPolicy !== 'auto') {
    lossy.push('polityka znaku kwoty');
  }
  if (file.decimalSeparator) lossy.push('separator dziesiętny');
  if (file.footerStop) lossy.push('reguła stopu (footer)');
  if (Array.isArray(file.skipRows) && file.skipRows.length > 0)
    lossy.push('reguły pomijania wierszy');
  if (asRecord(file.headerRow)?.strategy === 'scan' && meta.headerRowIndex <= 0) {
    lossy.push('wykrywanie wiersza nagłówka');
  }

  // Tryb all-trades = pojedyncza reguła trade z warunkiem notEmpty (jak generuje build).
  const classify = Array.isArray(p.classify) ? (p.classify as unknown[]) : [];
  const firstRule = asRecord(classify[0]);
  const firstWhen = firstRule && Array.isArray(firstRule.when) ? (firstRule.when as unknown[]) : [];
  const isAllTrades =
    classify.length === 1 &&
    firstRule?.emit === 'trade' &&
    firstWhen.length === 1 &&
    asRecord(firstWhen[0])?.op === 'notEmpty';

  // Tryb reguł: jeden matcher na regułę, operator odwzorowywalny.
  const draftClassify: DraftClassifyRule[] = [];
  if (!isAllTrades) {
    for (let i = 0; i < classify.length; i++) {
      const r = asRecord(classify[i]);
      const when = r && Array.isArray(r.when) ? (r.when as unknown[]) : [];
      if (when.length !== 1) {
        return {
          ok: false,
          lossy,
          reason: 'Reguła łączy kilka warunków — nieobsługiwane w formularzu.',
        };
      }
      const m = asRecord(when[0]);
      const op = m?.op;
      if (typeof op !== 'string' || !REVERSIBLE_OPS.has(op)) {
        return {
          ok: false,
          lossy,
          reason: `Reguła używa operatora „${String(op)}" — nieobsługiwany w formularzu.`,
        };
      }
      if (typeof m?.col !== 'number') {
        return { ok: false, lossy, reason: 'Reguła nie wskazuje kolumny po indeksie.' };
      }
      draftClassify.push({
        id: typeof r?.id === 'string' ? r.id : `rule-${i + 1}`,
        colIndex: m.col,
        op: op === 'oneOf' ? 'equals' : (op as DraftClassifyRule['op']),
        values: Array.isArray(m.values) ? m.values.join(', ') : '',
        emit: (r?.emit as RowClass) ?? 'other',
      });
    }
  }

  // Mapowanie transakcji.
  let trade = defaultTradeMapping();
  const tradeRaw = asRecord(p.trade);
  if (tradeRaw) {
    for (const k of Object.keys(tradeRaw)) {
      if (!DRAFT_TRADE_KEYS.has(k)) lossy.push(`transakcje: pole „${k}"`);
    }
    const dateSrc = asRecord(tradeRaw.date);
    const dateFormats = dateSrc?.formats;
    const dateCol = columnIndexOf(dateSrc?.source);
    const paperCol = columnIndexOf(tradeRaw.paperName);
    const quantityCol = columnIndexOf(tradeRaw.quantity);
    const priceCol = columnIndexOf(tradeRaw.price);
    if (
      dateCol === undefined ||
      paperCol === undefined ||
      quantityCol === undefined ||
      priceCol === undefined
    ) {
      return {
        ok: false,
        lossy,
        reason: 'Kluczowe pole transakcji (data/papier/ilość/cena) nie jest zwykłą kolumną.',
      };
    }
    if (Array.isArray(dateFormats) && dateFormats.length > 1) {
      lossy.push('kilka formatów daty (transakcje)');
    }
    const currency = currencyFromSource(tradeRaw.currency);
    if (!currency)
      return { ok: false, lossy, reason: 'Waluta transakcji w nieobsługiwanej formie.' };
    const side = sideFromSource(tradeRaw.side);
    if (!side) {
      return {
        ok: false,
        lossy,
        reason: 'Sposób rozpoznania kupna/sprzedaży nieobsługiwany w formularzu.',
      };
    }
    trade = {
      dateCol,
      dateFormat: firstDateFormat(dateFormats),
      paperNameCol: paperCol,
      isinCol: optionalColumn(tradeRaw.isin, lossy, 'transakcje: ISIN'),
      quantityCol,
      priceCol,
      valueCol: optionalColumn(tradeRaw.value, lossy, 'transakcje: wartość'),
      commissionCol: optionalColumn(tradeRaw.commission, lossy, 'transakcje: prowizja'),
      totalCol: optionalColumn(tradeRaw.total, lossy, 'transakcje: kwota łączna'),
      currencyCol: currency.col,
      currencyFallback: currency.fallback,
      sideStrategy: side.strategy,
      sideCol: side.col,
      buyValues: side.buyValues,
      sellValues: side.sellValues,
      wholeShares: Boolean(tradeRaw.wholeShares),
    };
  }

  // Mapowanie operacji (wspólne) — z pierwszej obecnej klasy gotówkowej.
  let cash = defaultCashMapping();
  const cashKeys = Object.keys(CASH_KEY_TO_CLASS).filter((k) => asRecord(p[k]));
  if (cashKeys.length > 0) {
    const c = asRecord(p[cashKeys[0]])!;
    for (const k of Object.keys(c)) {
      if (!DRAFT_CASH_KEYS.has(k)) lossy.push(`operacje: pole „${k}"`);
    }
    const dateSrc = asRecord(c.date);
    const dateFormats = dateSrc?.formats;
    const dateCol = columnIndexOf(dateSrc?.source);
    const amountCol = columnIndexOf(c.amount);
    if (dateCol === undefined || amountCol === undefined) {
      return { ok: false, lossy, reason: 'Operacje: data lub kwota nie jest zwykłą kolumną.' };
    }
    const currency = currencyFromSource(c.currency);
    if (!currency) return { ok: false, lossy, reason: 'Waluta operacji w nieobsługiwanej formie.' };
    if (Array.isArray(dateFormats) && dateFormats.length > 1) {
      lossy.push('kilka formatów daty (operacje)');
    }
    let tickerCol = -1;
    for (const k of cashKeys) {
      const cc = asRecord(p[k]);
      if (cc && 'ticker' in cc) {
        const t = columnIndexOf(cc.ticker);
        if (t === undefined) lossy.push('operacje: ticker (wyrażenie)');
        else tickerCol = t;
        break;
      }
    }
    cash = {
      dateCol,
      dateFormat: firstDateFormat(dateFormats),
      amountCol,
      currencyCol: currency.col,
      currencyFallback: currency.fallback,
      descriptionCol: columnIndexOf(c.description) ?? -1,
      tickerCol,
    };
  }

  if (!tradeRaw && cashKeys.length === 0) {
    return { ok: false, lossy, reason: 'Profil nie zawiera rozpoznawalnego mapowania.' };
  }

  // Parowanie inne niż auto-regenerowane (dividendWht) — nieodwzorowane.
  const pairing = asRecord(p.pairing);
  if (pairing) {
    for (const k of Object.keys(pairing)) {
      if (k !== 'dividendWht') lossy.push(`parowanie „${k}"`);
    }
  }

  const brokerLabel =
    typeof p.brokerLabel === 'string' && p.brokerLabel !== 'Nieznany broker' ? p.brokerLabel : '';
  const draft: ProfileDraft = {
    brokerLabel,
    delimiter: typeof file.delimiter === 'string' ? file.delimiter : meta.delimiter,
    headerRowIndex: meta.headerRowIndex,
    headers: meta.headers,
    mode: isAllTrades ? 'all-trades' : 'rules',
    classify: isAllTrades ? [] : draftClassify,
    defaultClass: p.defaultClass === 'other' ? 'other' : 'skip',
    trade,
    cash,
  };
  return { ok: true, draft, lossy };
}
