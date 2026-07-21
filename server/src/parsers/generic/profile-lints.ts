import type { CashMapping, ColRef, ImportProfile, ProfileLint, SkipReason, ValueSource } from 'shared';
import { parseNumber } from '../utils.js';
import type { GenericParseOutput } from './engine.js';
import { normalizeHeaderName } from './value-parsers.js';

/**
 * Linty podglądu — diagnostyka profilu, który PRZECHODZI walidację i self-check,
 * ale może mapować subtelnie źle (cichy błąd niewidoczny w liczbach). Czysta
 * funkcja: część reguł statyczna (z kształtu profilu), część agregatowa (ze
 * scalonego wyniku silnika, liczona PRZED przycięciem podglądu). Linty są
 * doradcze — NIE blokują commitu; uwidaczniają ryzyko do weryfikacji przez
 * człowieka w kreatorze i w panelu kuracji admina.
 *
 * NIE duplikuje free-text `warnings` silnika (reklasyfikacje znaku, value_mismatch).
 */

/** Powody pominięcia „łagodne" — celowe, nie błąd mapowania (= SkipClassReasonSchema). */
const GENTLE_SKIP_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  'summary_row',
  'settlement_record',
  'corporate_action',
  'zero_amount',
]);

/** Sekcje gotówkowe, w których ticker bywa wyłuskiwany regexem z opisu. */
type CashSectionKey =
  | 'dividend'
  | 'coupon'
  | 'interest'
  | 'fee'
  | 'tradeFee'
  | 'capitalReturn'
  | 'other';

const CASH_TICKER_SECTIONS: readonly CashSectionKey[] = [
  'dividend',
  'coupon',
  'interest',
  'fee',
  'tradeFee',
  'capitalReturn',
  'other',
];

const SECTION_LABEL_PL: Record<CashSectionKey, string> = {
  dividend: 'dywidendy',
  coupon: 'kupony',
  interest: 'odsetki',
  fee: 'opłaty',
  tradeFee: 'koszty pozycji',
  capitalReturn: 'zwrot kapitału',
  other: 'inne',
};

const SKIP_REASON_LABEL_PL: Partial<Record<SkipReason, string>> = {
  missing_date: 'brak daty',
  invalid_date: 'błędna data',
  missing_name: 'brak nazwy',
  missing_isin: 'brak ISIN',
  invalid_side: 'nierozpoznana strona',
  invalid_quantity: 'błędna ilość',
  invalid_price: 'błędna cena',
  value_mismatch: 'wartość ≠ ilość×cena',
  unknown_operation_type: 'nierozpoznany wiersz',
};

/** Próg: udział problematycznych pominięć powyżej którego pokazujemy lint. */
const HIGH_SKIP_RATE = 0.05;
/** Próg: udział operacji bez godziny powyżej którego pokazujemy lint. */
const NO_TIME_RATE = 0.5;

const skipReasonLabel = (r: SkipReason): string => SKIP_REASON_LABEL_PL[r] ?? r;

/** Czas „00:00:00" w ISO oznacza brak godziny (resolveDate domyśla 00:00:00). */
const hasNoTime = (iso: string): boolean => iso.slice(11, 19) === '00:00:00';

// ── Pomocnicze dla lintów strukturalnych (kształt kolumn vs. mapowanie) ──

/** ISIN: 2 litery kraju + 9 alfanumerycznych + cyfra kontrolna. */
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
/** Nagłówek wyglądający na prowizję/opłatę (po normalizeHeaderName = lowercase). */
const FEE_HEADER_RE = /(prowizj|commission|opłat|oplat|\bfee\b|\bfees\b|\bcharge\b|koszt)/;
/** Udział kwot z pliku na wierszach odrzuconych, powyżej którego ostrzegamy. */
const UNACCOUNTED_RATE = 0.1;

/** ColRef → indeks kolumny (null gdy brak) — lustro ColumnResolver.resolve, bez rzucania. */
function resolveColIndex(col: ColRef, headers: string[]): number | null {
  if (typeof col === 'number') return col >= 0 && col < headers.length ? col : null;
  const wanted = normalizeHeaderName(col.name);
  const occurrence = col.occurrence ?? 0;
  let seen = 0;
  for (let i = 0; i < headers.length; i++) {
    if (normalizeHeaderName(headers[i]) === wanted) {
      if (seen === occurrence) return i;
      seen++;
    }
  }
  return null;
}

/** Indeks kolumny źródła wartości (column/regexExtract); null dla const/braku. */
function sourceColIndex(vs: ValueSource | undefined, headers: string[]): number | null {
  if (!vs) return null;
  if (vs.kind === 'column' || vs.kind === 'regexExtract') return resolveColIndex(vs.col, headers);
  return null;
}

/** Kolumny zajęte przez mapowanie 'trade' — wykluczane w heurystykach szukających
 *  kolumn NIEUŻYTYCH (prowizja, kwota). */
function tradeMappedCols(profile: ImportProfile, headers: string[]): Set<number> {
  const s = new Set<number>();
  const t = profile.trade;
  if (!t) return s;
  const add = (vs: ValueSource | undefined): void => {
    const i = sourceColIndex(vs, headers);
    if (i !== null) s.add(i);
  };
  add(t.date.source);
  add(t.paperName);
  add(t.isin);
  add(t.quantity);
  add(t.price);
  add(t.value);
  add(t.commission);
  add(t.total);
  add(t.currency);
  add(t.paymentCurrency);
  add(t.fxRate);
  const sideIdx = resolveColIndex(t.side.col, headers);
  if (sideIdx !== null) s.add(sideIdx);
  return s;
}

/** Etykieta kolumny do komunikatu: ` „Nagłówek"` lub pusto (kolumna bez nazwy). */
function colLabel(c: number, headers: string[]): string {
  const h = (headers[c] ?? '').trim();
  return h ? ` „${h}"` : '';
}

/** Kolumna „kwoty" operacji: najpierw jawne mapowanie 'amount' w sekcjach gotówkowych,
 *  w razie braku — kolumna liczbowa o największej sumie |wartości| spoza kolumn 'trade'. */
function detectAmountColumn(
  profile: ImportProfile,
  headers: string[],
  sample: string[][],
): number | null {
  const CASH_KEYS: Array<keyof ImportProfile> = [
    'deposit',
    'withdrawal',
    'fee',
    'other',
    'dividend',
    'coupon',
    'interest',
    'capitalReturn',
    'commissionRefund',
    'tradeFee',
    'fxLeg',
  ];
  for (const key of CASH_KEYS) {
    const mapping = profile[key] as CashMapping | undefined;
    const i = sourceColIndex(mapping?.amount, headers);
    if (i !== null) return i;
  }
  const mapped = tradeMappedCols(profile, headers);
  let best: number | null = null;
  let bestSum = 0;
  for (let c = 0; c < headers.length; c++) {
    if (mapped.has(c)) continue;
    let sum = 0;
    let numericCells = 0;
    for (const row of sample) {
      const v = (row[c] ?? '').trim();
      if (!v || !/\d/.test(v)) continue;
      const n = parseNumber(v);
      if (n !== 0) {
        sum += Math.abs(n);
        numericCells++;
      }
    }
    if (numericCells >= 2 && sum > bestSum) {
      bestSum = sum;
      best = c;
    }
  }
  return best;
}

export function lintProfile(
  profile: ImportProfile,
  output: GenericParseOutput,
  sheet?: string,
): ProfileLint[] {
  const lints: ProfileLint[] = [];
  const push = (l: Omit<ProfileLint, 'sheet'>): void => {
    lints.push(sheet ? { ...l, sheet } : l);
  };

  // ── Statyczne (z kształtu profilu) ──

  if (profile.trade) {
    const pc = profile.trade.paymentCurrency;
    if (!pc) {
      push({
        code: 'payment-currency-assumed',
        severity: 'warning',
        message:
          'Waluta rozliczenia nie jest mapowana z pliku — przyjęto walutę instrumentu. ' +
          'Dla rachunku w innej walucie (np. instrument USD opłacony z PLN) przeliczenia ' +
          'FX/MWR będą błędne.',
      });
    } else if (pc.kind === 'const') {
      push({
        code: 'payment-currency-const',
        severity: 'info',
        message: `Waluta rozliczenia zahardkodowana na „${pc.value}" — upewnij się, że pasuje do rachunku.`,
      });
    }
  }

  const regexTickerSections = CASH_TICKER_SECTIONS.filter(
    (key) => (profile[key] as CashMapping | undefined)?.ticker?.kind === 'regexExtract',
  );
  if (regexTickerSections.length > 0) {
    push({
      code: 'ticker-via-regex',
      severity: 'warning',
      message: `Ticker wyłuskiwany regexem z opisu (${regexTickerSections
        .map((k) => SECTION_LABEL_PL[k])
        .join(', ')}) — bywa pusty lub łapie zły token; zweryfikuj na próbce.`,
    });
  }

  if (profile.needsNameResolution) {
    push({
      code: 'needs-name-resolution',
      severity: 'info',
      message: 'Brak ISIN w pliku — instrumenty rozpoznawane po nazwie (mniej pewne niż ISIN).',
    });
  }

  if (profile.defaultClass !== 'skip') {
    push({
      code: 'non-skip-default',
      severity: 'info',
      message:
        `Wiersze bez dopasowanej reguły trafiają do „${profile.defaultClass}", nie są pomijane ` +
        '— sprawdź, czy nic tam nie wpada błędnie.',
    });
  }

  // ── Agregatowe (ze scalonego wyniku silnika) ──

  const allDates = [
    ...output.transactions.data.map((t) => t.date),
    ...output.operations.data.map((o) => o.date),
  ];
  if (allDates.length > 0) {
    const noTime = allDates.filter(hasNoTime).length;
    if (noTime / allDates.length > NO_TIME_RATE) {
      const fxByDatetime = profile.pairing?.fxLegs?.pairKey?.by === 'datetime';
      push({
        code: 'no-trade-time',
        severity: 'warning',
        count: noTime,
        message:
          `Brak godziny w ${noTime} z ${allDates.length} operacji (czas 00:00) — wpływa na ` +
          `kolejność intraday${
            fxByDatetime ? ' i parowanie nóg FX po (data, czas), które może się skleić.' : '.'
          }`,
      });
    }
  }

  // Ticker pusty mimo zadeklarowanego mapowania na dywidendach/kuponach.
  const expectsDivTicker = Boolean(profile.dividend?.ticker || profile.coupon?.ticker);
  if (expectsDivTicker) {
    const divOps = output.operations.data.filter((o) => o.operationType === 'dividend');
    const empty = divOps.filter((o) => !o.ticker || o.ticker.trim() === '').length;
    if (divOps.length > 0 && empty > 0) {
      push({
        code: 'ticker-empty',
        severity: 'warning',
        count: empty,
        message: `Ticker pusty w ${empty} z ${divOps.length} dywidend/kuponów — przypisanie do spółki będzie niepełne.`,
      });
    }
  }

  const skipped = [...output.transactions.skipped, ...output.operations.skipped];
  const problematic = skipped.filter((s) => !GENTLE_SKIP_REASONS.has(s.reason));
  const emitted = output.transactions.data.length + output.operations.data.length;
  const denom = emitted + problematic.length;
  if (denom > 0 && problematic.length / denom > HIGH_SKIP_RATE) {
    const byReason = new Map<SkipReason, number>();
    for (const s of problematic) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    const breakdown = [...byReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${skipReasonLabel(r)} ×${n}`)
      .join(', ');
    const pct = Math.round((problematic.length / denom) * 100);
    push({
      code: 'high-skip-rate',
      severity: 'warning',
      count: problematic.length,
      message: `Pominięto ${problematic.length} wierszy (${pct}%) z powodów: ${breakdown} — te dane nie wejdą do portfela.`,
    });
  }

  // Akcje korporacyjne celowo pominięte (split/transfer/przydział) — łagodne dla
  // pewności, ale ZMIENIAJĄ liczbę akcji, więc użytkownik musi o nich wiedzieć.
  const corpActions = skipped.filter((s) => s.reason === 'corporate_action');
  if (corpActions.length > 0) {
    push({
      code: 'corporate-action-skipped',
      severity: 'warning',
      count: corpActions.length,
      message:
        `Pominięto ${corpActions.length} wierszy jako akcje korporacyjne (split, transfer, ` +
        'przydział akcji) — nie wchodzą do portfela, więc sprawdź, czy liczba akcji się zgadza.',
    });
  }

  // ── Strukturalne: kolumny obecne w pliku, ale nieużyte w mapowaniu ──
  // Chwytają cichą wadę profilu „śmietnika" (jedna reguła 'trade' na zawsze-obecnej
  // kolumnie) zanim admin zatwierdzi profil: zignorowany ISIN, porzucona prowizja,
  // wiersze gotówkowe wpadające w 'trade', kwoty przepadające na wierszach odrzuconych.

  const headers = output.headers;
  const sample = output.sampleCells;

  // 1) Kolumna z ISIN-ami obecna, ale trade.isin niezmapowany (rozpoznanie po nazwie).
  if (profile.trade && !profile.trade.isin && sample.length > 0) {
    let isinCol: number | null = null;
    for (let c = 0; c < headers.length; c++) {
      let nonEmpty = 0;
      let isinLike = 0;
      for (const row of sample) {
        const v = (row[c] ?? '').trim();
        if (!v) continue;
        nonEmpty++;
        if (ISIN_RE.test(v.toUpperCase())) isinLike++;
      }
      if (nonEmpty >= 3 && isinLike >= 3 && isinLike / nonEmpty >= 0.6) {
        isinCol = c;
        break;
      }
    }
    if (isinCol !== null) {
      push({
        code: 'isin-column-unused',
        severity: 'warning',
        message:
          `Plik zawiera kolumnę z ISIN-ami (kol. ${isinCol}${colLabel(isinCol, headers)}), ale ` +
          `„trade.isin" nie jest zmapowany — instrumenty rozpoznawane po nazwie. Zmapuj tę ` +
          `kolumnę na ISIN: to najpewniejszy identyfikator, szczególnie dla ETF-ów i papierów ` +
          `bez notowań w PL.`,
      });
    }
  }

  // 2) Kolumna z prowizją/opłatą obecna, ale trade.commission (ani total) niezmapowany.
  //    DORADCZE (info), nie warning: pominięcie prowizji BYWA celowe — opłaty mogą być
  //    w osobnym pliku (wzorzec DEGIRO: Transactions.csv ma kolumny opłat, ale nalicza
  //    je Account.csv) albo w osobnych wierszach. Nie ostrzegamy, gdy: zmapowany 'total'
  //    (po prowizji, np. Bossa) lub profil klasyfikuje opłaty jako osobne wiersze ('fee').
  const feesAsRows =
    profile.classify.some((r) => r.emit === 'fee' || r.emit === 'trade_fee') ||
    Boolean(profile.fee) ||
    Boolean(profile.tradeFee);
  if (
    profile.trade &&
    !profile.trade.commission &&
    !profile.trade.total &&
    !feesAsRows &&
    sample.length > 0
  ) {
    const mapped = tradeMappedCols(profile, headers);
    let feeCol: number | null = null;
    for (let c = 0; c < headers.length; c++) {
      if (mapped.has(c)) continue;
      if (!FEE_HEADER_RE.test(normalizeHeaderName(headers[c] ?? ''))) continue;
      const hasNumeric = sample.some((row) => {
        const v = (row[c] ?? '').trim();
        return v !== '' && /\d/.test(v) && parseNumber(v) !== 0;
      });
      if (hasNumeric) {
        feeCol = c;
        break;
      }
    }
    if (feeCol !== null) {
      push({
        code: 'fee-column-unused',
        severity: 'info',
        message:
          `Plik ma kolumnę „${(headers[feeCol] ?? '').trim()}" (kol. ${feeCol}) wyglądającą na ` +
          `prowizję/opłatę, a „trade.commission" nie jest zmapowany — jeśli to prowizja per ` +
          `transakcja, zmapuj ją (inaczej koszty nie wejdą do portfela). Zignoruj, gdy opłaty ` +
          `są w osobnym pliku lub osobnych wierszach.`,
      });
    }
  }

  // 3) Wiersze złapane regułą 'trade', ale odrzucone jako nierozpoznana strona/ilość —
  //    prawdopodobnie operacje gotówkowe wpadające w zbyt ogólną regułę 'trade'.
  const invalidSide = output.transactions.skipped.filter((s) => s.reason === 'invalid_side').length;
  const invalidQty = output.transactions.skipped.filter(
    (s) => s.reason === 'invalid_quantity',
  ).length;
  if (invalidSide > 0) {
    const qtyNote = invalidQty > 0 ? ` (+${invalidQty} z pustą/zerową ilością)` : '';
    push({
      code: 'cash-rows-routed-to-trade',
      severity: 'warning',
      count: invalidSide + invalidQty,
      message:
        `${invalidSide} wierszy trafiło do klasy „trade", ale kolumna strony nie ma wartości ` +
        `kupna/sprzedaży${qtyNote} — to zwykle operacje gotówkowe (wpłaty, wypłaty, bonusy) ` +
        `błędnie złapane zbyt ogólną regułą „trade". Dodaj dla nich reguły classify ` +
        `(deposit/withdrawal/other), inaczej znikną z portfela.`,
    });
  }

  // 4) Znacząca część kwot z pliku trafiła na wiersze ODRZUCONE (nie weszła do portfela).
  const hasProblematicSkip = [
    ...output.transactions.skipped,
    ...output.operations.skipped,
  ].some((s) => !GENTLE_SKIP_REASONS.has(s.reason));
  if (hasProblematicSkip && sample.length > 0) {
    const amountCol = detectAmountColumn(profile, headers, sample);
    if (amountCol !== null) {
      const traceByRow = new Map(output.rowTraces.map((t) => [t.row, t]));
      let totalMag = 0;
      let droppedMag = 0;
      let droppedRows = 0;
      for (let j = 0; j < sample.length; j++) {
        const trace = traceByRow.get(output.headerRowIndex + 2 + j);
        if (!trace) continue; // wiersz poza przetwarzaniem (np. za footerStop)
        const amount = Math.abs(parseNumber(sample[j][amountCol] ?? ''));
        if (!Number.isFinite(amount) || amount === 0) continue;
        totalMag += amount;
        if (trace.skipReason !== undefined && !GENTLE_SKIP_REASONS.has(trace.skipReason)) {
          droppedMag += amount;
          droppedRows++;
        }
      }
      if (totalMag > 0 && droppedRows > 0 && droppedMag / totalMag >= UNACCOUNTED_RATE) {
        const pct = Math.round((droppedMag / totalMag) * 100);
        push({
          code: 'unaccounted-cashflow',
          severity: 'warning',
          count: droppedRows,
          message:
            `Około ${pct}% kwot z pliku (kol. „${(headers[amountCol] ?? '').trim()}") trafiło na ` +
            `${droppedRows} wierszy ODRZUCONYCH — te pieniądze nie wejdą do portfela. Zwykle to ` +
            `operacja gotówkowa bez pasującej reguły classify (np. wpłata). Sprawdź pominięte ` +
            `wiersze i uzupełnij mapowanie.`,
        });
      }
    }
  }

  return lints;
}
