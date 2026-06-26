import type { CashMapping, ImportProfile, ProfileLint, SkipReason } from 'shared';
import type { GenericParseOutput } from './engine.js';

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

  return lints;
}
