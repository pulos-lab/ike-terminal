/**
 * Czyste helpery do widoku review profilu importu (admin): rozbicie klasyfikacji
 * i tabela mapowań kolumna→pole, liczone z danych, które backend JUŻ zwraca
 * (`dryRun.rowTraces` + JSON profilu). Bez zmian na serwerze/silniku.
 */
import type { ImportProfile, RowClass, RowTrace, SkipReason } from 'shared';
import { ROW_CLASS_LABELS } from '@/lib/generic-profile-builder';

export type FieldStatus = 'ok' | 'uncertain' | 'missing';

// ── Rozbicie klasyfikacji (typ wiersza → licznik) ────────────────────────────

export interface ClassCount {
  emitted: RowClass;
  label: string;
  target: 'transaction' | 'operation' | 'skip';
  count: number;
}

export function buildClassBreakdown(rowTraces: RowTrace[]): ClassCount[] {
  const map = new Map<RowClass, { target: ClassCount['target']; count: number }>();
  for (const t of rowTraces) {
    const cur = map.get(t.emitted) ?? { target: t.target ?? 'skip', count: 0 };
    cur.count += 1;
    map.set(t.emitted, cur);
  }
  return [...map.entries()]
    .map(([emitted, v]) => ({
      emitted,
      label: ROW_CLASS_LABELS[emitted] ?? emitted,
      target: v.target,
      count: v.count,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Adnotacja każdego wiersza próbki klasą (po pozycji: rowTraces[k] ↔ sampleRows[k]).
 * Do tabeli próbki: „Typ" per wiersz + wyróżnienie pominiętych z powodem.
 */
export interface RowAnnotation {
  emitted: RowClass;
  label: string;
  isSkip: boolean;
  skipReason?: SkipReason;
}

export function rowAnnotations(rowTraces: RowTrace[]): RowAnnotation[] {
  return rowTraces.map((t) => ({
    emitted: t.emitted,
    label: ROW_CLASS_LABELS[t.emitted] ?? t.emitted,
    isSkip: t.emitted === 'skip',
    skipReason: t.skipReason,
  }));
}

// ── Tabela mapowań kolumna→pole ──────────────────────────────────────────────

export interface MappingField {
  field: string;
  source: string;
  examples: string[];
  status: FieldStatus;
}

export interface ClassMapping {
  emitted: RowClass;
  label: string;
  fields: MappingField[];
}

type ColRef = number | { name: string; occurrence?: number };
type ValueSourceLike =
  | { kind: 'column'; col: ColRef }
  | { kind: 'const'; value: string }
  | { kind: 'regexExtract'; col: ColRef }
  | undefined;

interface FieldSpec {
  label: string;
  required: boolean;
  /** Powody skipu wskazujące na to pole (→ status „uncertain"). */
  reasons: SkipReason[];
  getVs: (m: Record<string, unknown>) => ValueSourceLike;
  /** Nadpisanie etykiety źródła (np. dla strategii znaku przy stronie). */
  sourceOverride?: (m: Record<string, unknown>) => string | undefined;
}

// Powody skipu współdzielone przez trade i cash (Data) — nie flagują cross-class.
const SHARED_REASONS = new Set<SkipReason>(['missing_date', 'invalid_date']);

/** RowClass (snake_case) → klucz sekcji mapowania w profilu (camelCase). */
const CLASS_TO_KEY: Partial<Record<RowClass, string>> = {
  trade: 'trade',
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

const dateSource = (m: Record<string, unknown>): ValueSourceLike => {
  const d = m.date as { source?: ValueSourceLike } | undefined;
  return d?.source;
};

const TRADE_FIELDS: FieldSpec[] = [
  { label: 'Data', required: true, reasons: ['missing_date', 'invalid_date'], getVs: dateSource },
  {
    label: 'Nazwa',
    required: true,
    reasons: ['missing_name'],
    getVs: (m) => m.paperName as ValueSourceLike,
  },
  {
    label: 'ISIN',
    required: false,
    reasons: ['missing_isin'],
    getVs: (m) => m.isin as ValueSourceLike,
  },
  {
    label: 'Ilość',
    required: true,
    reasons: ['invalid_quantity'],
    getVs: (m) => m.quantity as ValueSourceLike,
  },
  {
    label: 'Cena',
    required: true,
    reasons: ['invalid_price', 'value_mismatch'],
    getVs: (m) => m.price as ValueSourceLike,
  },
  { label: 'Waluta', required: true, reasons: [], getVs: (m) => m.currency as ValueSourceLike },
  {
    label: 'Strona (K/S)',
    required: true,
    reasons: ['invalid_side'],
    getVs: (m) => {
      const s = m.side as { col?: ColRef } | undefined;
      return s?.col !== undefined ? { kind: 'column', col: s.col } : undefined;
    },
    sourceOverride: (m) => {
      const s = m.side as { strategy?: string } | undefined;
      if (s?.strategy === 'signedQuantity') return 'znak kolumny ilości (− = sprzedaż)';
      if (s?.strategy === 'signedAmount') return 'znak kolumny kwoty (wydatek = kupno)';
      return undefined;
    },
  },
];

const CASH_FIELDS: FieldSpec[] = [
  { label: 'Data', required: true, reasons: ['missing_date', 'invalid_date'], getVs: dateSource },
  {
    label: 'Kwota',
    required: true,
    reasons: ['zero_amount'],
    getVs: (m) => m.amount as ValueSourceLike,
  },
  { label: 'Waluta', required: true, reasons: [], getVs: (m) => m.currency as ValueSourceLike },
  { label: 'Ticker', required: false, reasons: [], getVs: (m) => m.ticker as ValueSourceLike },
  { label: 'Opis', required: false, reasons: [], getVs: (m) => m.description as ValueSourceLike },
];

function resolveColIndex(col: ColRef, headers: string[]): number | null {
  if (typeof col === 'number') return col;
  if (col && typeof col.name === 'string') {
    let occ = col.occurrence ?? 0;
    for (let i = 0; i < headers.length; i++) {
      if (headers[i] === col.name) {
        if (occ === 0) return i;
        occ -= 1;
      }
    }
  }
  return null;
}

function colLabel(col: ColRef, headers: string[]): string {
  if (typeof col === 'object' && col?.name) return `«${col.name}»`;
  const idx = resolveColIndex(col, headers);
  if (idx != null) return headers[idx] ? `«${headers[idx]}»` : `[${idx}]`;
  return '?';
}

interface SourceInfo {
  kind: 'none' | 'column' | 'const' | 'regex';
  label: string;
  colIndex: number | null;
  constValue?: string;
}

function describeSource(vs: ValueSourceLike, headers: string[]): SourceInfo {
  if (!vs) return { kind: 'none', label: '— (brak)', colIndex: null };
  if (vs.kind === 'column')
    return {
      kind: 'column',
      label: `kolumna ${colLabel(vs.col, headers)}`,
      colIndex: resolveColIndex(vs.col, headers),
    };
  if (vs.kind === 'const')
    return { kind: 'const', label: `stała: „${vs.value}"`, colIndex: null, constValue: vs.value };
  if (vs.kind === 'regexExtract')
    return {
      kind: 'regex',
      label: `regex z ${colLabel(vs.col, headers)}`,
      colIndex: resolveColIndex(vs.col, headers),
    };
  return { kind: 'none', label: '—', colIndex: null };
}

function columnExamples(colIndex: number | null, sampleRows: string[][]): string[] {
  if (colIndex == null) return [];
  const seen = new Set<string>();
  for (const r of sampleRows) {
    const v = (r[colIndex] ?? '').trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      if (seen.size >= 3) break;
    }
  }
  return [...seen];
}

function fieldStatus(
  required: boolean,
  src: SourceInfo,
  examples: string[],
  reasons: SkipReason[],
  globalReasons: Set<SkipReason>,
): FieldStatus {
  if (src.kind === 'none') return required ? 'missing' : 'ok';
  if (src.kind === 'const') return 'ok';
  if (examples.length === 0) return 'uncertain';
  if (examples.some((e) => e.includes('***'))) return 'uncertain';
  // Tylko powody UNIKALNE dla klasy (współdzielone, jak data, nie flagują cross-class).
  if (reasons.some((r) => !SHARED_REASONS.has(r) && globalReasons.has(r))) return 'uncertain';
  return 'ok';
}

/**
 * Tabela mapowań per klasa obecna w dry-run (mająca sekcję mapowania w profilu).
 * Źródła pól ze statycznego JSON-a profilu; przykłady z wierszy próbki; status
 * z obecności pola + przykładów + powodów skipu w `rowTraces`.
 */
export function buildMappingTables(
  profile: ImportProfile,
  headerNames: string[],
  sampleRows: string[][],
  rowTraces: RowTrace[],
): ClassMapping[] {
  const present = new Set<RowClass>(rowTraces.map((t) => t.emitted).filter((c) => c !== 'skip'));
  const globalReasons = new Set<SkipReason>(
    rowTraces.map((t) => t.skipReason).filter((r): r is SkipReason => Boolean(r)),
  );
  const prof = profile as unknown as Record<string, Record<string, unknown> | undefined>;

  // Wiersze próbki pogrupowane po klasie — po POZYCJI: k-ty rowTrace odpowiada
  // k-temu wierszowi próbki (silnik produkuje jeden trace na wiersz, w kolejności).
  // Dzięki temu przykłady pól pokazują wartości TEJ klasy, nie całej próbki.
  const rowsByClass = new Map<RowClass, string[][]>();
  rowTraces.forEach((t, k) => {
    const row = sampleRows[k];
    if (!row) return;
    const arr = rowsByClass.get(t.emitted);
    if (arr) arr.push(row);
    else rowsByClass.set(t.emitted, [row]);
  });

  const out: ClassMapping[] = [];
  for (const emitted of present) {
    const key = CLASS_TO_KEY[emitted];
    const mapping = key ? prof[key] : undefined;
    if (!mapping) continue;
    const classRows = rowsByClass.get(emitted) ?? sampleRows;
    const specs = emitted === 'trade' ? TRADE_FIELDS : CASH_FIELDS;
    const fields: MappingField[] = [];
    for (const spec of specs) {
      const vs = spec.getVs(mapping);
      if (!vs && !spec.required) continue; // pole opcjonalne i niemapowane — pomiń
      const src = describeSource(vs, headerNames);
      const examples =
        src.constValue !== undefined ? [src.constValue] : columnExamples(src.colIndex, classRows);
      fields.push({
        field: spec.label,
        source: spec.sourceOverride?.(mapping) ?? src.label,
        examples,
        status: fieldStatus(spec.required, src, examples, spec.reasons, globalReasons),
      });
    }
    out.push({ emitted, label: ROW_CLASS_LABELS[emitted] ?? emitted, fields });
  }
  return out;
}

// ── Akcje na skipach ─────────────────────────────────────────────────────────

export type SkipCategory = 'unknown' | 'mapping' | 'gentle';

const UNKNOWN_REASONS: SkipReason[] = ['unknown_operation_type', 'unknown_type'];
const GENTLE_REASONS: SkipReason[] = [
  'summary_row',
  'settlement_record',
  'corporate_action',
  'zero_amount',
  'duplicate',
  'redemption_reconciled',
  'capital_return_reconciled',
  'close_trade_entry',
];

export function skipCategory(reason: SkipReason): SkipCategory {
  if (UNKNOWN_REASONS.includes(reason)) return 'unknown';
  if (GENTLE_REASONS.includes(reason)) return 'gentle';
  return 'mapping';
}

export interface SkipGroup {
  reason: SkipReason;
  count: number;
  category: SkipCategory;
}

export function buildSkipGroups(rowTraces: RowTrace[]): SkipGroup[] {
  const map = new Map<SkipReason, number>();
  for (const t of rowTraces) {
    if (t.emitted === 'skip' && t.skipReason)
      map.set(t.skipReason, (map.get(t.skipReason) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([reason, count]) => ({ reason, count, category: skipCategory(reason) }))
    .sort((a, b) => b.count - a.count);
}

/** Najczęściej używana kolumna w regułach classify — kandydat na dyskryminator typu. */
export function inferDiscriminatorCol(profile: ImportProfile): ColRef | null {
  const tally = new Map<string, { col: ColRef; n: number }>();
  for (const rule of profile.classify ?? []) {
    for (const m of (rule.when ?? []) as Array<{ col: ColRef }>) {
      const key = JSON.stringify(m.col);
      const e = tally.get(key) ?? { col: m.col, n: 0 };
      e.n += 1;
      tally.set(key, e);
    }
  }
  let best: { col: ColRef; n: number } | null = null;
  for (const e of tally.values()) if (!best || e.n > best.n) best = e;
  return best?.col ?? null;
}

/** RowClasses, które mają sekcję mapowania (reguła emitująca je będzie walidna). */
export function mappedClasses(profile: ImportProfile): RowClass[] {
  const prof = profile as unknown as Record<string, unknown>;
  return (Object.keys(CLASS_TO_KEY) as RowClass[]).filter((c) => {
    const key = CLASS_TO_KEY[c];
    return key ? Boolean(prof[key]) : false;
  });
}

/**
 * Wartości kolumny-dyskryminatora obecne w próbce, których NIE pokrywa żadna
 * reguła classify (heurystyka po podciągu, by złapać contains/startsWith). To
 * kandydaci na „nierozpoznane typy operacji" do dołożenia reguły.
 */
export function unhandledDiscriminatorValues(
  profile: ImportProfile,
  headerNames: string[],
  sampleRows: string[][],
): string[] {
  const col = inferDiscriminatorCol(profile);
  if (col == null) return [];
  const idx = resolveColIndex(col, headerNames);
  if (idx == null) return [];

  // Matchery na kolumnie-dyskryminatorze z operatorem — dopasowanie zgodne z
  // semantyką classify (per-op), nie po podciągu (krótka wartość reguły „k" nie
  // „zjada" już nierozpoznanych wartości).
  const matchers: Array<{ op: string; values: string[] }> = [];
  for (const rule of profile.classify ?? []) {
    for (const m of (rule.when ?? []) as Array<{ col: ColRef; op?: string; values?: string[] }>) {
      if (JSON.stringify(m.col) === JSON.stringify(col)) {
        matchers.push({
          op: m.op ?? '',
          values: Array.isArray(m.values) ? m.values.map((v) => v.toLowerCase()) : [],
        });
      }
    }
  }
  const isHandled = (cell: string) => {
    const lc = cell.toLowerCase();
    return matchers.some(({ op, values }) => {
      switch (op) {
        case 'equals':
        case 'oneOf':
          return values.includes(lc);
        case 'startsWith':
          return values.some((v) => v && lc.startsWith(v));
        case 'contains':
          return values.some((v) => v && lc.includes(v));
        case 'notEmpty':
          return lc.length > 0;
        default:
          return false; // regex i inne — nie uznajemy za obsłużone
      }
    });
  };

  const out = new Set<string>();
  for (const r of sampleRows) {
    const v = (r[idx] ?? '').trim();
    if (v && !isHandled(v)) out.add(v);
  }
  return [...out];
}

export interface AppendRuleInput {
  col: ColRef;
  values: string[];
  emit: RowClass;
  skipReason?: 'summary_row';
}

/** Nowy profil (deep clone) z dołożoną regułą classify na końcu. Czyste. */
export function appendClassifyRule(profile: ImportProfile, input: AppendRuleInput): ImportProfile {
  const next = JSON.parse(JSON.stringify(profile)) as ImportProfile & {
    classify: Array<Record<string, unknown>>;
  };
  const id = `usr_${input.emit}_${next.classify.length}`.slice(0, 60);
  const rule: Record<string, unknown> = {
    id,
    when: [{ col: input.col, op: 'oneOf', values: input.values }],
    emit: input.emit,
  };
  if (input.skipReason) rule.skipReason = input.skipReason;
  next.classify.push(rule);
  return next as ImportProfile;
}
