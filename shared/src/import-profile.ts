import { z } from 'zod';
import type {
  BrokerType,
  CashOperation,
  ImportResult,
  SkipReason,
  SkippedRow,
  Transaction,
} from './types.js';

/**
 * ImportProfile — deklaratywny opis formatu CSV brokera dla uniwersalnego importu.
 *
 * Profil opisuje STRUKTURĘ formatu (mapowanie kolumn, reguły klasyfikacji wierszy,
 * formaty dat, reguły parowania) — nie zawiera żadnych danych użytkownika, więc może
 * być współdzielony globalnie (biblioteka profili keyed by fingerprint nagłówków).
 *
 * Wykonawcą profilu jest deterministyczny silnik `server/src/parsers/generic/engine.ts`
 * (parseWithProfile). Profil może pochodzić z trzech źródeł: LLM (generacja z próbki),
 * ręczny kreator mapowania w UI, edycja admina — wszystkie przechodzą przez ten sam
 * schemat walidacji.
 *
 * Zasady projektowe:
 * - zamknięte enumy zamiast dowolnych wzorców (formaty dat, operatory matcherów) —
 *   ograniczają przestrzeń błędów LLM i są w pełni walidowalne;
 * - parsowanie liczb NIE jest konfigurowalne — silnik używa parseNumber() z utils,
 *   który sam wykrywa separatory ("1 234,56" / "1.234,56" / "1,234.56");
 * - `z.toJSONSchema(ImportProfileSchema)` służy jako structured-output schema dla LLM.
 */

export const IMPORT_PROFILE_SPEC_VERSION = 1;

// ── Referencje kolumn ────────────────────────────────────────────────────────

/**
 * Wskazanie kolumny: indeks 0-based LUB nazwa nagłówka z numerem wystąpienia.
 * `occurrence` rozwiązuje zduplikowane nazwy (mBank ma 3× kolumnę "Waluta"):
 * occurrence=0 → pierwsze wystąpienie, 1 → drugie itd.
 */
export const ColRefSchema = z.union([
  z.number().int().nonnegative(),
  z.object({
    name: z.string().min(1).max(80),
    occurrence: z.number().int().nonnegative().default(0),
  }),
]);
export type ColRef = z.infer<typeof ColRefSchema>;

// ── Źródła wartości ──────────────────────────────────────────────────────────

/** Skąd silnik bierze wartość pola docelowego. */
export const ValueSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('column'),
    col: ColRefSchema,
    /** Wartość zastępcza, gdy komórka jest pusta (np. waluta: pusta → 'PLN'). */
    fallback: z.string().max(80).optional(),
  }),
  z.object({ kind: z.literal('const'), value: z.string().max(80) }),
  /** Ekstrakcja regexem z komórki — np. ticker z opisu "Wypłata dywidendy PLAYWAY". */
  z.object({
    kind: z.literal('regexExtract'),
    col: ColRefSchema,
    pattern: z.string().min(1).max(500),
    group: z.number().int().min(0).max(9).default(1),
    /** Wartość zastępcza, gdy komórka pusta lub regex nie pasuje. */
    fallback: z.string().max(80).optional(),
  }),
]);
export type ValueSource = z.infer<typeof ValueSourceSchema>;

// ── Matchery / warunki ───────────────────────────────────────────────────────

export const MatcherOpSchema = z.enum([
  'equals', // komórka === jedna z values (case wg caseInsensitive)
  'oneOf', // alias equals z wieloma values (czytelniejsze dla LLM)
  'contains', // komórka zawiera substring z values
  'startsWith', // komórka zaczyna się od jednego z values
  'regex', // komórka pasuje do pattern
  'signPositive', // parseNumber(komórka) > 0
  'signNegative', // parseNumber(komórka) < 0
  'zeroNumber', // parseNumber(komórka) === 0 (uwaga: też dla pustych)
  'nonzeroNumber', // parseNumber(komórka) !== 0
  'empty', // komórka pusta / whitespace
  'notEmpty',
]);

export const MatcherSchema = z
  .object({
    col: ColRefSchema,
    op: MatcherOpSchema,
    /** Dla equals/oneOf/contains/startsWith. */
    values: z.array(z.string().max(200)).max(50).optional(),
    /** Dla op='regex'. */
    pattern: z.string().max(500).optional(),
    caseInsensitive: z.boolean().default(true),
  })
  .check((ctx) => {
    const m = ctx.value;
    const needsValues = ['equals', 'oneOf', 'contains', 'startsWith'].includes(m.op);
    if (needsValues && (!m.values || m.values.length === 0)) {
      ctx.issues.push({
        code: 'custom',
        message: `Operator '${m.op}' wymaga niepustej listy 'values'`,
        input: m,
      });
    }
    if (m.op === 'regex' && !m.pattern) {
      ctx.issues.push({
        code: 'custom',
        message: `Operator 'regex' wymaga pola 'pattern'`,
        input: m,
      });
    }
  });
export type Matcher = z.infer<typeof MatcherSchema>;

/** Lista matcherów łączona AND-em. */
export const ConditionSchema = z.array(MatcherSchema).min(1).max(8);
export type Condition = z.infer<typeof ConditionSchema>;

// ── Klasyfikacja wierszy ─────────────────────────────────────────────────────

/**
 * Klasa wiersza — pośrednia taksonomia profilu, mapowana przez silnik na
 * Transaction / CashOperation:
 *   trade            → Transaction (K/S)
 *   dividend         → CashOperation 'dividend'
 *   withholding_tax  → parowane z dividend (netto) lub importowane jako 'fee'
 *   coupon           → 'dividend' + subkind 'coupon' (kupon obligacji)
 *   interest         → 'other' + subkind 'interest' (odsetki od salda gotówki)
 *   deposit          → 'deposit' (kwota normalizowana do dodatniej)
 *   withdrawal       → 'withdrawal' (kwota normalizowana do ujemnej)
 *   fx_leg           → noga wymiany walutowej; parowanie → 2× 'fx_exchange'
 *   fee              → 'fee' (znak kwoty zachowany)
 *   trade_fee        → 'trade_fee' (koszt przypięty do pozycji: swap/rollover/tax IFTT)
 *   commission_refund→ 'commission_refund'
 *   capital_return   → 'capital_return'
 *   other            → 'other' (zachowuje cashflow nierozpoznanych operacji)
 *   skip             → wiersz pominięty (podsumowania, rozliczenia techniczne)
 */
export const RowClassSchema = z.enum([
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
]);
export type RowClass = z.infer<typeof RowClassSchema>;

/** Powody pominięcia dla emit='skip' — podzbiór SkipReason z shared/types. */
export const SkipClassReasonSchema = z.enum([
  'summary_row',
  'settlement_record',
  'corporate_action',
  'zero_amount',
]);

export const ClassificationRuleSchema = z.object({
  /** Identyfikator reguły — trafia do RowTrace (podgląd "Reguła: …" w UI). */
  id: z.string().min(1).max(60),
  when: ConditionSchema,
  emit: RowClassSchema,
  /** Wymagane tylko dla emit='skip'. */
  skipReason: SkipClassReasonSchema.optional(),
});
export type ClassificationRule = z.infer<typeof ClassificationRuleSchema>;

// ── Daty ─────────────────────────────────────────────────────────────────────

/**
 * Zamknięty enum formatów dat. Silnik toleruje opcjonalny sufiks czasu
 * (HH:MM lub HH:MM:SS) w tej samej komórce — np. Bossa "25.02.2026 09:47:27".
 * Warianty z rokiem 2-cyfrowym (pivot 00–69 → 20xx, 70–99 → 19xx) oraz z nazwą
 * miesiąca (EN: Jan/January, PL: sty/stycznia) — typowe dla brokerów zagranicznych.
 */
export const DateFormatSchema = z.enum([
  'YYYY-MM-DD',
  'DD.MM.YYYY',
  'DD-MM-YYYY',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'YYYY.MM.DD',
  'YYYY/MM/DD',
  // Rok 2-cyfrowy:
  'DD.MM.YY',
  'DD/MM/YY',
  // Nazwa miesiąca:
  'DD-MMM-YYYY',
  'DD MMM YYYY',
  'MMM DD, YYYY',
]);
export type DateFormat = z.infer<typeof DateFormatSchema>;

export const DateSpecSchema = z.object({
  source: ValueSourceSchema,
  /** Formaty próbowane po kolei — pierwszy pasujący wygrywa. */
  formats: z.array(DateFormatSchema).min(1).max(4),
  /** Osobna kolumna czasu (HH:MM / HH:MM:SS) — np. DEGIRO "Czas". */
  timeSource: ValueSourceSchema.optional(),
});
export type DateSpec = z.infer<typeof DateSpecSchema>;

// ── Strona transakcji (K/S) ──────────────────────────────────────────────────

export const SideRuleSchema = z.discriminatedUnion('strategy', [
  /** Jawna kolumna strony: wartości kupna i sprzedaży (np. K/S, BUY/SELL, Kupno/Sprzedaż). */
  z.object({
    strategy: z.literal('column'),
    col: ColRefSchema,
    buyValues: z.array(z.string().max(40)).min(1).max(10),
    sellValues: z.array(z.string().max(40)).min(1).max(10),
  }),
  /** Znak ilości: +qty=K, −qty=S (DEGIRO "Liczba"). */
  z.object({ strategy: z.literal('signedQuantity'), col: ColRefSchema }),
  /** Znak kwoty rozliczenia: wydatek(−)=K, wpływ(+)=S. */
  z.object({ strategy: z.literal('signedAmount'), col: ColRefSchema }),
]);
export type SideRule = z.infer<typeof SideRuleSchema>;

// ── Kategoria instrumentu ────────────────────────────────────────────────────

export const InstrumentCategorySchema = z.enum(['stock', 'etf', 'cfd', 'bond']);

export const CategoryRuleSchema = z.object({
  when: z.discriminatedUnion('by', [
    z.object({ by: z.literal('matcher'), condition: ConditionSchema }),
    /** Prefiks ISIN-u — np. obligacje skarbowe PL0 (heurystyka per broker). */
    z.object({ by: z.literal('isinPrefix'), prefixes: z.array(z.string().max(12)).min(1).max(10) }),
    /** Regex na nazwie papieru — np. /ETF|UCITS/ → etf. */
    z.object({ by: z.literal('nameRegex'), pattern: z.string().min(1).max(300) }),
  ]),
  category: InstrumentCategorySchema,
});

export const CategoryRulesSchema = z.object({
  rules: z.array(CategoryRuleSchema).max(10).default([]),
  default: InstrumentCategorySchema.default('stock'),
});
export type CategoryRules = z.infer<typeof CategoryRulesSchema>;

// ── Mapowania pól per klasa wiersza ──────────────────────────────────────────

export const TradeMappingSchema = z.object({
  date: DateSpecSchema,
  paperName: ValueSourceSchema,
  /** Brak → pseudo-ISIN = paperName (wzorzec mBank) + wymagane needsNameResolution. */
  isin: ValueSourceSchema.optional(),
  quantity: ValueSourceSchema,
  /**
   * Czy ilość zaokrąglać do pełnych sztuk (GPW/NC — usuwa szum floating-point CSV).
   * false = zachowaj fractional shares (DEGIRO/XTB zagranica).
   */
  wholeShares: z.boolean().default(false),
  price: ValueSourceSchema,
  /** Brak → value = roundTo2(qty × price). */
  value: ValueSourceSchema.optional(),
  /** Brak → 0 (broker liczy prowizje osobno — wzorzec DEGIRO/mBank). */
  commission: ValueSourceSchema.optional(),
  /** Brak → computeTotal(side, value, commission). Bossa podaje total wprost ("po prowizji"). */
  total: ValueSourceSchema.optional(),
  /** Waluta kwotowania (kolumna lub const). */
  currency: ValueSourceSchema,
  /** Waluta faktycznego rozliczenia (np. const 'PLN' dla rachunków IKE/IKZE). */
  paymentCurrency: ValueSourceSchema.optional(),
  /** Kurs wymiany broker'a — silnik pomija wartości ≤ 0 (brak przewalutowania). */
  fxRate: ValueSourceSchema.optional(),
  side: SideRuleSchema,
  category: CategoryRulesSchema.optional(),
});
export type TradeMapping = z.infer<typeof TradeMappingSchema>;

export const CashMappingSchema = z.object({
  date: DateSpecSchema,
  /** Kwota ze znakiem — silnik normalizuje znak wg klasy (deposit→+, withdrawal→−). */
  amount: ValueSourceSchema,
  currency: ValueSourceSchema,
  /** Brak → opis = nazwa klasy wiersza. */
  description: ValueSourceSchema.optional(),
  details: ValueSourceSchema.optional(),
  /** Ticker instrumentu (dywidendy/kupony) — często regexExtract z opisu. */
  ticker: ValueSourceSchema.optional(),
  /**
   * ISIN — używany WYŁĄCZNIE jako klucz parowania dywidenda↔WHT (matchBy 'isin');
   * CashOperation nie ma kolumny ISIN. Pewniejszy niż ticker, gdy broker zapisuje
   * nazwę produktu niespójnie między wierszem dywidendy a podatku.
   */
  isin: ValueSourceSchema.optional(),
  /**
   * Kurs wymiany dla jednowierszowych operacji FX (Bossa: "Wymiana waluty PLN/USD 3.5713"
   * — kurs w tytule przez regexExtract). Dla nóg parowanych kurs bierze pairing.fxLegs.rateSource.
   */
  fxRate: ValueSourceSchema.optional(),
  /** Para walutowa (np. "PLN/USD") dla jednowierszowych operacji FX. */
  fxPair: ValueSourceSchema.optional(),
  /**
   * Podatek u źródła (WHT) w KOLUMNIE tego samego wiersza dywidendy — odejmowany
   * od kwoty (netto) gdy w tej samej walucie. Wyklucza się z pairing.dividendWht
   * (parowanie osobnym wierszem), inaczej podatek zostałby odjęty dwa razy.
   */
  tax: ValueSourceSchema.optional(),
  /** Waluta podatku inline; gdy inna niż waluta kwoty → NIE odejmujemy, tylko adnotacja. */
  taxCurrency: ValueSourceSchema.optional(),
});
export type CashMapping = z.infer<typeof CashMappingSchema>;

// ── Parowanie wierszy ────────────────────────────────────────────────────────

export const DividendWhtPairingSchema = z.object({
  /** Klucze parowania dywidendy z podatkiem u źródła. */
  matchBy: z
    .array(z.enum(['isin', 'ticker', 'date', 'time']))
    .min(1)
    .max(4)
    .default(['ticker', 'date']),
  /** Maks. odstęp dni między dywidendą a podatkiem (0 = ten sam dzień). */
  windowDays: z.number().int().min(0).max(7).default(0),
  /**
   * subtract → jedna operacja dividend z kwotą netto i dopiskiem "(podatek X%)";
   * fee_row  → dywidenda brutto + podatek jako osobny 'fee'.
   */
  handling: z.enum(['subtract', 'fee_row']).default('subtract'),
});

export const FxLegsPairingSchema = z.object({
  /** Jak sparować nogę debetową z kredytową jednej wymiany. */
  pairKey: z.discriminatedUnion('by', [
    /** Wspólny identyfikator zlecenia (DEGIRO "Identyfikator zlecenia"). */
    z.object({ by: z.literal('column'), col: ColRefSchema }),
    /** Ta sama data+czas obu nóg. */
    z.object({ by: z.literal('datetime') }),
  ]),
  /** Kolumna kursu wymiany (np. DEGIRO "Kurs") — brak → kurs = |credit|/|debit|. */
  rateSource: ValueSourceSchema.optional(),
});

export const PairingRulesSchema = z.object({
  dividendWht: DividendWhtPairingSchema.optional(),
  fxLegs: FxLegsPairingSchema.optional(),
});
export type PairingRules = z.infer<typeof PairingRulesSchema>;

// ── Plik ─────────────────────────────────────────────────────────────────────

export const HeaderRowSpecSchema = z.discriminatedUnion('strategy', [
  /** Nagłówek w pierwszym niepustym wierszu. */
  z.object({ strategy: z.literal('first') }),
  /**
   * Skanuj pierwsze maxScanRows wierszy w poszukiwaniu wiersza zawierającego
   * wszystkie nazwy z signature (mBank: ~34 linie metadanych przed nagłówkiem).
   */
  z.object({
    strategy: z.literal('scan'),
    signature: z.array(z.string().min(1).max(80)).min(2).max(6),
    maxScanRows: z.number().int().min(1).max(200).default(60),
  }),
]);

export const FileSpecSchema = z.object({
  delimiter: z.enum([';', ',', '\t', '|']),
  quoteChar: z.string().length(1).default('"'),
  /**
   * Nazwa arkusza XLSX, z którego pochodzi ten profil. Obecność tego pola JEST
   * markerem formatu XLSX (brak osobnego dyskryminatora). Skoroszyt XLSX jest
   * serializowany do CSV (średnik), więc profile XLSX mają delimiter ';'; do
   * dopasowania liczy się arkusz, nie delimiter (zob. computeFingerprint).
   */
  sheet: z.string().max(120).optional(),
  headerRow: HeaderRowSpecSchema,
  /** Wiersz STOP — od pierwszego dopasowania wszystko dalej jest ignorowane (stopki podsumowań). */
  footerStop: ConditionSchema.optional(),
  /** Wiersze pomijane w całym pliku (sumy częściowe itp.) → skip 'summary_row'. */
  skipRows: z.array(ConditionSchema).max(5).default([]),
  /**
   * Normalizacja kodów walut (np. {"NO":"NOK"}). GBX/GBp (pensy) silnik obsługuje
   * wbudowanie: cena ÷100 → GBP, niezależnie od aliasów.
   */
  currencyAliases: z.record(z.string().max(8), z.string().max(8)).default({}),
  /**
   * Polityka znaku kwot operacji gotówkowych (deposit/withdrawal):
   * - 'signed'    — plik niesie znaczący ZNAK (Bossa: wypłaty/IPO ujemne);
   *                 niezgodność etykiety ze znakiem → reklasyfikacja (np. „wpłata"
   *                 z kwotą ujemną → wypłata),
   * - 'magnitude' — kwoty to magnitudy bez znaku (Trading 212); znak bierzemy z
   *                 etykiety classify, bez reklasyfikacji,
   * - 'auto'      — heurystyka (domyślnie): jeśli JAKAKOLWIEK kwota w pliku jest
   *                 ujemna → traktuj jak 'signed', inaczej jak 'magnitude'.
   * Stare profile bez tego pola silnik traktuje jak 'auto' (?? w engine).
   */
  amountSignPolicy: z.enum(['auto', 'signed', 'magnitude']).default('auto'),
  /**
   * Jawny separator dziesiętny (locale liczb). Gdy ustawiony, silnik parsuje
   * liczby deterministycznie (drugi znak oraz spacje = separator tysięczny)
   * zamiast auto-wykrywać — usuwa niejednoznaczność „1.234" (1234 vs 1,234).
   * Brak → auto-detekcja jak dotąd (parseNumber z utils).
   */
  decimalSeparator: z.enum(['.', ',']).optional(),
});
export type FileSpec = z.infer<typeof FileSpecSchema>;

// ── Profil ───────────────────────────────────────────────────────────────────

/** Klasy wierszy wymagające sekcji mapowania w profilu. */
const CLASS_TO_MAPPING_KEY = {
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
} as const;

export const ImportProfileSchema = z
  .object({
    specVersion: z.literal(IMPORT_PROFILE_SPEC_VERSION),
    /** Etykieta brokera (PL UI) — tylko do wyświetlania, nie wpływa na parsowanie. */
    brokerLabel: z.string().min(1).max(60),
    file: FileSpecSchema,
    /** Reguły klasyfikacji — ordered, first-match-wins. */
    classify: z.array(ClassificationRuleSchema).min(1).max(30),
    /** Klasa wiersza bez dopasowanej reguły. */
    defaultClass: RowClassSchema.default('skip'),
    trade: TradeMappingSchema.optional(),
    dividend: CashMappingSchema.optional(),
    withholdingTax: CashMappingSchema.optional(),
    coupon: CashMappingSchema.optional(),
    interest: CashMappingSchema.optional(),
    deposit: CashMappingSchema.optional(),
    withdrawal: CashMappingSchema.optional(),
    fxLeg: CashMappingSchema.optional(),
    fee: CashMappingSchema.optional(),
    tradeFee: CashMappingSchema.optional(),
    commissionRefund: CashMappingSchema.optional(),
    capitalReturn: CashMappingSchema.optional(),
    other: CashMappingSchema.optional(),
    pairing: PairingRulesSchema.default({}),
    /** true → brak ISIN w pliku; import-service uruchamia resolucję nazwa→ISIN (mBank path). */
    needsNameResolution: z.boolean().default(false),
  })
  .check((ctx) => {
    const p = ctx.value;

    // Każda klasa emitowana przez classify/defaultClass musi mieć sekcję mapowania.
    const emitted = new Set<string>(p.classify.map((r) => r.emit));
    if (p.defaultClass !== 'skip') emitted.add(p.defaultClass);
    for (const cls of emitted) {
      if (cls === 'skip') continue;
      const key = CLASS_TO_MAPPING_KEY[cls as keyof typeof CLASS_TO_MAPPING_KEY];
      if (!(p as Record<string, unknown>)[key]) {
        ctx.issues.push({
          code: 'custom',
          message: `Klasyfikacja emituje '${cls}', ale w profilu brakuje sekcji mapowania '${key}'`,
          input: p,
        });
      }
    }

    // trade bez ISIN wymaga needsNameResolution (pseudo-ISIN = paperName).
    if (p.trade && !p.trade.isin && !p.needsNameResolution) {
      ctx.issues.push({
        code: 'custom',
        message: `Mapowanie 'trade' nie ma źródła ISIN — ustaw needsNameResolution=true`,
        input: p,
      });
    }

    // fx_leg BEZ pairing.fxLegs = jednowierszowe operacje FX (kurs/para z mapowania fxLeg);
    // Z pairing.fxLegs = nogi debet/kredyt parowane przez silnik. Oba warianty poprawne.

    // withholding_tax bez reguł parowania → podatki wpadną w fee; wymagamy jawnej decyzji.
    if (emitted.has('withholding_tax') && !p.pairing.dividendWht) {
      ctx.issues.push({
        code: 'custom',
        message:
          `Klasyfikacja emituje 'withholding_tax', ale brakuje 'pairing.dividendWht' — ` +
          `sklasyfikuj podatek jako 'fee' albo dodaj reguły parowania`,
        input: p,
      });
    }

    // Podatek inline (kolumna na wierszu) wyklucza się z parowaniem osobnym wierszem.
    if (p.dividend?.tax && p.pairing.dividendWht) {
      ctx.issues.push({
        code: 'custom',
        message:
          `'dividend.tax' (podatek w kolumnie wiersza) wyklucza się z 'pairing.dividendWht' ` +
          `(podatek osobnym wierszem) — wybierz jedno, inaczej odejmiesz podatek dwukrotnie`,
        input: p,
      });
    }

    // Walidacja kompilowalności wszystkich regexów w profilu.
    const tryRegex = (pattern: string | undefined, where: string) => {
      if (!pattern) return;
      try {
        new RegExp(pattern);
      } catch {
        ctx.issues.push({
          code: 'custom',
          message: `Niepoprawny regex w ${where}: ${pattern}`,
          input: p,
        });
      }
    };
    p.classify.forEach((r, i) =>
      r.when.forEach((m) => tryRegex(m.pattern, `classify[${i}] (${r.id})`)),
    );
    p.file.skipRows.forEach((cond, i) =>
      cond.forEach((m) => tryRegex(m.pattern, `file.skipRows[${i}]`)),
    );
    p.file.footerStop?.forEach((m) => tryRegex(m.pattern, 'file.footerStop'));
    const checkValueSource = (vs: ValueSource | undefined, where: string) => {
      if (vs?.kind === 'regexExtract') tryRegex(vs.pattern, where);
    };
    for (const key of Object.values(CLASS_TO_MAPPING_KEY)) {
      const mapping = (p as Record<string, unknown>)[key];
      if (!mapping || typeof mapping !== 'object') continue;
      for (const [field, vs] of Object.entries(mapping)) {
        if (vs && typeof vs === 'object' && 'kind' in (vs as object)) {
          checkValueSource(vs as ValueSource, `${key}.${field}`);
        }
      }
    }
    p.trade?.category?.rules.forEach((r, i) => {
      if (r.when.by === 'nameRegex') tryRegex(r.when.pattern, `trade.category.rules[${i}]`);
      if (r.when.by === 'matcher')
        r.when.condition.forEach((m) => tryRegex(m.pattern, `trade.category.rules[${i}]`));
    });
  });

export type ImportProfile = z.infer<typeof ImportProfileSchema>;

/** Walidacja profilu z czytelnym (PL) komunikatem zbiorczym. */
export function validateImportProfile(
  raw: unknown,
): { ok: true; profile: ImportProfile } | { ok: false; errors: string[] } {
  const result = ImportProfileSchema.safeParse(raw);
  if (result.success) return { ok: true, profile: result.data };
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
  return { ok: false, errors };
}

// ── Typy API importu generycznego (/api/import/generic/*) ────────────────────

/** Ślad klasyfikacji wiersza — emitowany przez silnik, podstawa tabeli podglądu w UI. */
export interface RowTrace {
  /** 1-based indeks wiersza w sparsowanym pliku (po skipEmptyLines). */
  row: number;
  /** id reguły classify, która dopasowała wiersz; null = defaultClass. */
  matchedRuleId: string | null;
  emitted: RowClass;
  target?: 'transaction' | 'operation';
  skipReason?: SkipReason;
  /** Kluczowe zmapowane pola — do tabeli podglądu. */
  preview?: Record<string, string | number>;
}

export type ImportProfileStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

/** Skrót profilu z biblioteki — bez JSON-a profilu (ten idzie osobno, bywa duży). */
export interface GenericProfileSummary {
  id: string;
  fingerprint: string;
  version: number;
  status: ImportProfileStatus;
  brokerLabel: string | null;
  specVersion: number;
  usageCount: number;
  createdAt: string;
}

/**
 * Analiza pojedynczej tabeli: CSV = cały plik, XLSX = jeden arkusz. Te same
 * pola płaskie co dawniej + nazwa arkusza (gdy XLSX).
 */
export interface GenericSheetAnalysis {
  /** Nazwa arkusza XLSX; brak dla CSV. */
  sheet?: string;
  /** Nazwa pliku źródłowego (import multi-plik); brak = pojedynczy plik (legacy). */
  file?: string;
  fingerprint: string;
  delimiter: string;
  headerRowIndex: number;
  headers: string[];
  /** ZREDAGOWANE wiersze próbki (sample-redactor). */
  sampleRows: string[][];
  /** Profil z biblioteki dla dokładnego fingerprinta (approved > pending). */
  profile?: { summary: GenericProfileSummary; profileJson: unknown };
  /** Podobne formaty (Jaccard ≥ 0.75) — szablony startowe dla edytora/LLM. */
  suggestions?: Array<{ summary: GenericProfileSummary; similarity: number; profileJson: unknown }>;
}

/** POST /api/import/generic/analyze */
export interface GenericAnalyzeResult {
  /** true = plik obsługuje parser WBUDOWANY — używaj zwykłego /api/import/bulk. */
  known: boolean;
  broker?: BrokerType | null;
  fileRole?: 'transactions' | 'operations' | 'unknown';
  /** Format pliku (gdy known=false). */
  format?: 'csv' | 'xlsx';
  /** Pola płaskie — TYLKO dla CSV (wsteczna zgodność). Dla XLSX patrz `sheets`. */
  fingerprint?: string;
  delimiter?: string;
  headerRowIndex?: number;
  headers?: string[];
  sampleRows?: string[][];
  profile?: { summary: GenericProfileSummary; profileJson: unknown };
  suggestions?: Array<{ summary: GenericProfileSummary; similarity: number; profileJson: unknown }>;
  /** Arkusze z danymi — TYLKO dla XLSX (≥1). Każdy = osobna tabela/profil. */
  sheets?: GenericSheetAnalysis[];
  /** Arkusze pominięte (okładki/puste/jednokolumnowe) — informacyjnie. */
  skippedSheets?: string[];
  /** Multi-plik: zunifikowana lista dokumentów (tabel) ze WSZYSTKICH wgranych plików. */
  documents?: GenericSheetAnalysis[];
  /** Pliki obsługiwane przez parser WBUDOWANY — do zaimportowania przez kafel brokera. */
  knownFiles?: Array<{ file: string; broker: BrokerType }>;
  /** Pliki/arkusze bez tabeli danych (informacyjnie). */
  skippedDocuments?: Array<{ file: string; sheet?: string }>;
  /** Błąd analizy (PL) — np. nie znaleziono nagłówka. */
  error?: string;
}

/**
 * Lint podglądu — strukturalne ostrzeżenie o profilu, który PRZECHODZI walidację
 * i self-check, ale może mapować subtelnie źle (cichy błąd niewidoczny w liczbach).
 * Doradcze: NIE blokują commitu, podświetlają ryzyko do weryfikacji przez człowieka.
 */
export interface ProfileLint {
  code:
    | 'payment-currency-assumed'
    | 'payment-currency-const'
    | 'no-trade-time'
    | 'ticker-via-regex'
    | 'ticker-empty'
    | 'high-skip-rate'
    | 'corporate-action-skipped'
    | 'needs-name-resolution'
    | 'non-skip-default';
  severity: 'info' | 'warning';
  /** Treść PL gotowa do wyświetlenia (z wplecionymi licznikami). */
  message: string;
  /** Atrybucja tabeli (XLSX/multi-plik); brak dla pojedynczego CSV. */
  sheet?: string;
  /** Licznik dla lintów agregatowych (np. ile wierszy bez godziny). */
  count?: number;
}

/** POST /api/import/generic/preview — bez zapisu. */
export interface GenericPreviewResult {
  ok: boolean;
  /** Błędy walidacji profilu lub wykonania (PL). */
  errors?: string[];
  transactions?: { total: number; sample: Transaction[]; skipped: SkippedRow[] };
  operations?: { total: number; sample: CashOperation[]; skipped: SkippedRow[] };
  rowTraces?: RowTrace[];
  /** true gdy rowTraces/sample zostały przycięte (duży plik). */
  truncated?: boolean;
  warnings?: string[];
  /** Linty doradcze o profilu (ciche błędy) — render w kreatorze i panelu admina. */
  lints?: ProfileLint[];
  /** Wkład per arkusz (XLSX) — do zakładek w podglądzie. Brak dla CSV. */
  sheetSummaries?: Array<{
    sheet?: string;
    transactions: number;
    operations: number;
    skipped: number;
  }>;
}

/** Profil dla jednego arkusza XLSX w żądaniu preview/commit. */
export interface GenericSheetProfileInput {
  /** Nazwa arkusza; brak/undefined → CSV (jeden dokument). */
  sheet?: string;
  /** Nazwa pliku źródłowego (multi-plik) — dopasowanie dokumentu po (file, sheet). */
  file?: string;
  /** Profil z biblioteki… */
  profileId?: string;
  /** …albo inline (edycja w kreatorze). */
  profileJson?: unknown;
}

/** POST /api/import/generic/commit — ImportResult + metadane użytego profilu. */
export interface GenericCommitResult extends ImportResult {
  profileId?: string;
  profileVersion?: number;
  profileStatus?: ImportProfileStatus;
  brokerLabel?: string | null;
}

/** POST /api/import/generic/generate-profile — profil wygenerowany przez LLM. */
export interface GenericGenerateProfileResult {
  summary: GenericProfileSummary;
  profileJson: unknown;
  /** Wynik deterministycznego self-checku na realnym pliku (0–1). */
  confidence: number;
  attempts: number;
  /** Arkusz, dla którego wygenerowano profil (XLSX) — echo żądania. */
  sheet?: string;
}

/** GET /api/import/generic/batches */
export interface GenericBatchInfo {
  importBatch: string;
  fileName: string | null;
  profileId: string;
  profileVersion: number;
  brokerLabel: string | null;
  /** Nazwa arkusza XLSX (z profilu) — do etykiety; brak dla CSV. */
  sheet?: string | null;
  needsReimport: boolean;
  importedAt: string;
}

// ── API kuracji admina (Faza 5) — /api/admin/import-profiles ────────────────

/** Wiersz listy/kolejki review (GET /api/admin/import-profiles). */
export interface AdminProfileSummary {
  id: string;
  fingerprint: string;
  version: number;
  status: ImportProfileStatus;
  specVersion: number;
  brokerLabel: string | null;
  headerNames: string[];
  delimiter: string;
  generatedBy: 'llm' | 'manual' | 'admin';
  createdByUserId: string | null;
  createdAt: string;
  usageCount: number;
  llmModel: string | null;
  llmConfidence: number | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Batche zaimportowane dowolną wersją tego fingerprinta. */
  batchCount: number;
  needsReimportCount: number;
}

/** GET /api/admin/import-profiles/:id — szczegóły do review. */
export interface AdminProfileDetailResponse {
  profile: AdminProfileSummary & { profile: unknown; sampleRows: string[][] | null };
  /** Dry-run profilu na ZREDAGOWANEJ próbce (null gdy próbki nie zapisano). */
  dryRun: GenericPreviewResult | null;
  /** Różnice względem aktualnie zatwierdzonej wersji (null gdy brak innej approved). */
  diff: { againstId: string; againstVersion: number; changedSections: string[] } | null;
  audit: Array<{
    id: number;
    profileId: string;
    action: string;
    actorUserId: string | null;
    diff: unknown;
    createdAt: string;
  }>;
}
