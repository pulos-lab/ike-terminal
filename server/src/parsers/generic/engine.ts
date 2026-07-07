import Papa from 'papaparse';
import type {
  CashMapping,
  CashOperation,
  ImportProfile,
  InstrumentCategory,
  OperationType,
  RowClass,
  RowTrace,
  SkippedRow,
  SkipReason,
  Transaction,
} from 'shared';
import { applyIsinAlias, isBondInstrument } from 'shared';
import type { OperationsParseResult, TransactionsParseResult } from '../registry.js';
import { computeTotal, parseNumber, roundTo2, validateTradeFields } from '../utils.js';
import { classifyRow, evalCondition } from './classification.js';
import { pairDividendsWithWht, pairFxLegs, type PendingCashRow } from './pairing.js';
import {
  ColumnResolver,
  GenericParseError,
  normalizeHeaderName,
  resolveDate,
  resolveNumber,
  resolveValueSource,
} from './value-parsers.js';

/**
 * Silnik importu generycznego — wykonuje deklaratywny ImportProfile na treści
 * CSV i zwraca wynik w kontraktach istniejących parserów (TransactionsParseResult
 * + OperationsParseResult). Silnik jest deterministyczny: cała "inteligencja"
 * mieszka w profilu; tu tylko mapowanie, walidacja i parowanie.
 *
 * Zasady:
 * - brak kolumny wymaganej przez profil = twardy błąd (GenericParseError, PL),
 * - wiersz niespełniający walidacji → skipped z powodem (nic nie ginie po cichu),
 * - cross-check wartości |value − qty×price| wyłapuje błędne mapowanie kolumn,
 * - wbudowane reguły brokerowo-niezależne: aliasy ISIN (zdarzenia korporacyjne),
 *   detekcja obligacji (kategoria 'bond'), GBX→GBP (ceny w pensach ÷100).
 */

export interface GenericParseOutput {
  transactions: TransactionsParseResult;
  operations: OperationsParseResult;
  rowTraces: RowTrace[];
  /** Ostrzeżenia silnika (PL) — łączone z warnings parserów w import-service. */
  warnings: string[];
}

/** Mapa klasa wiersza → sekcja mapowania w profilu (cash). */
const CASH_MAPPING_KEY: Partial<Record<RowClass, keyof ImportProfile>> = {
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

/** Klasa wiersza → OperationType (fx_leg dostaje typ po parowaniu). */
const CLASS_TO_OPERATION_TYPE: Partial<Record<RowClass, OperationType>> = {
  dividend: 'dividend',
  coupon: 'dividend',
  interest: 'other',
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  fx_leg: 'fx_exchange', // jednowierszowe FX (bez pairing.fxLegs)
  fee: 'fee',
  trade_fee: 'trade_fee',
  commission_refund: 'commission_refund',
  capital_return: 'capital_return',
  other: 'other',
};

/** Domyślne opisy (PL), gdy profil nie mapuje kolumny opisu. */
const CLASS_DESCRIPTION_PL: Partial<Record<RowClass, string>> = {
  dividend: 'Dywidenda',
  withholding_tax: 'Podatek u źródła',
  coupon: 'Kupon obligacji',
  interest: 'Odsetki',
  deposit: 'Wpłata',
  withdrawal: 'Wypłata',
  fx_leg: 'Wymiana walut',
  fee: 'Opłata',
  trade_fee: 'Koszt pozycji',
  commission_refund: 'Zwrot prowizji',
  capital_return: 'Zwrot kapitału',
  other: 'Operacja',
};

export function parseWithProfile(
  content: string,
  profile: ImportProfile,
  importBatch: string,
): GenericParseOutput {
  const parsed = Papa.parse<string[]>(content.trim(), {
    delimiter: profile.file.delimiter,
    quoteChar: profile.file.quoteChar,
    header: false,
    skipEmptyLines: true,
  });
  const rows = parsed.data;
  if (rows.length === 0) {
    throw new GenericParseError('Plik nie zawiera żadnych wierszy danych.');
  }

  const headerIdx = locateHeaderRow(rows, profile);
  const headers = rows[headerIdx].map((c) => String(c ?? ''));
  const resolver = new ColumnResolver(headers, profile.file.decimalSeparator);

  const transactions: Transaction[] = [];
  const operations: CashOperation[] = [];
  const skippedTx: SkippedRow[] = [];
  const skippedOps: SkippedRow[] = [];
  const rowTraces: RowTrace[] = [];
  const warnings: string[] = [];

  // Bufory parowania.
  const pendingDividends: PendingCashRow[] = [];
  const pendingWht: PendingCashRow[] = [];
  const pendingFxLegs: PendingCashRow[] = [];
  // Operacje gotówkowe finalizowane wprost (deposit/withdrawal/fee/other/…) —
  // buforowane, by po pętli ustalić, czy plik W OGÓLE używa ujemnych kwot.
  // Jeśli nie (broker eksportuje magnitudy bez znaku, np. Trading 212), znak
  // bierzemy z etykiety classify, nie reklasyfikujemy wg sprzecznego znaku.
  const pendingDirect: Array<{ cls: RowClass; pending: PendingCashRow }> = [];

  const currencyAliases = new Map(
    Object.entries(profile.file.currencyAliases).map(([k, v]) => [
      k.toUpperCase(),
      v.toUpperCase(),
    ]),
  );
  const normalizeCurrency = (raw: string | undefined): string => {
    const upper = (raw ?? '').trim().toUpperCase();
    return currencyAliases.get(upper) ?? upper;
  };

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i].map((c) => String(c ?? ''));
    const rowNum = i + 1; // 1-based w sparsowanym pliku — konwencja istniejących parserów

    if (profile.file.footerStop && evalCondition(profile.file.footerStop, row, resolver)) {
      // Stopka podsumowań — wszystko od tego wiersza w dół jest ignorowane.
      break;
    }
    if (profile.file.skipRows.some((cond) => evalCondition(cond, row, resolver))) {
      skippedOps.push({ row: rowNum, reason: 'summary_row' });
      rowTraces.push({
        row: rowNum,
        matchedRuleId: null,
        emitted: 'skip',
        skipReason: 'summary_row',
      });
      continue;
    }

    const cls = classifyRow(profile.classify, profile.defaultClass, row, resolver);

    if (cls.emit === 'skip') {
      // Jawna reguła skip → jej powód; brak dopasowania (defaultClass) → unknown_operation_type,
      // żeby w podglądzie było widać wiersze, których profil nie rozpoznał.
      const reason: SkipReason =
        cls.ruleId !== null ? (cls.skipReason ?? 'summary_row') : 'unknown_operation_type';
      skippedOps.push({ row: rowNum, reason, paperName: row[0]?.slice(0, 60) || undefined });
      rowTraces.push({
        row: rowNum,
        matchedRuleId: cls.ruleId,
        emitted: 'skip',
        skipReason: reason,
      });
      continue;
    }

    if (cls.emit === 'trade') {
      const outcome = buildTransaction(
        row,
        rowNum,
        profile,
        resolver,
        normalizeCurrency,
        importBatch,
      );
      if (outcome.ok) {
        transactions.push(outcome.transaction);
        rowTraces.push({
          row: rowNum,
          matchedRuleId: cls.ruleId,
          emitted: 'trade',
          target: 'transaction',
          preview: {
            data: outcome.transaction.date,
            papier: outcome.transaction.paperName,
            strona: outcome.transaction.side,
            ilość: outcome.transaction.quantity,
            cena: outcome.transaction.price,
            wartość: outcome.transaction.value,
            waluta: outcome.transaction.currency,
          },
        });
      } else {
        skippedTx.push(outcome.skipped);
        if (outcome.warning) warnings.push(outcome.warning);
        rowTraces.push({
          row: rowNum,
          matchedRuleId: cls.ruleId,
          emitted: 'trade',
          skipReason: outcome.skipped.reason,
        });
      }
      continue;
    }

    // Klasy gotówkowe.
    const mappingKey = CASH_MAPPING_KEY[cls.emit];
    const mapping = mappingKey ? (profile[mappingKey] as CashMapping | undefined) : undefined;
    if (!mapping) {
      // superRefine schematu tego pilnuje — defensywnie: skip zamiast crash.
      skippedOps.push({ row: rowNum, reason: 'unknown_operation_type' });
      rowTraces.push({
        row: rowNum,
        matchedRuleId: cls.ruleId,
        emitted: cls.emit,
        skipReason: 'unknown_operation_type',
      });
      continue;
    }

    const cash = buildPendingCash(
      row,
      rowNum,
      cls.emit,
      mapping,
      profile,
      resolver,
      normalizeCurrency,
    );
    if (!cash.ok) {
      skippedOps.push(cash.skipped);
      rowTraces.push({
        row: rowNum,
        matchedRuleId: cls.ruleId,
        emitted: cls.emit,
        skipReason: cash.skipped.reason,
      });
      continue;
    }

    rowTraces.push({
      row: rowNum,
      matchedRuleId: cls.ruleId,
      emitted: cls.emit,
      target: 'operation',
      preview: {
        data: cash.pending.dateIso,
        kwota: cash.pending.amount,
        waluta: cash.pending.currency,
        ...(cash.pending.ticker ? { ticker: cash.pending.ticker } : {}),
      },
    });

    if (cls.emit === 'dividend' && profile.pairing.dividendWht) {
      pendingDividends.push(cash.pending);
      continue;
    }
    if (cls.emit === 'withholding_tax') {
      pendingWht.push(cash.pending);
      continue;
    }
    if (cls.emit === 'fx_leg' && profile.pairing.fxLegs) {
      pendingFxLegs.push(cash.pending);
      continue;
    }
    // fx_leg bez pairing.fxLegs = jednowierszowa wymiana FX (kurs/para z mapowania).

    pendingDirect.push({ cls: cls.emit, pending: cash.pending });
  }

  // Czy plik niesie ZNAK w kwotach operacji (Bossa: wypłaty/IPO ujemne) — czy
  // tylko magnitudy (Trading 212: wszystko dodatnie). Decyduje, czy przy
  // niezgodności znaku z etykietą deposit/withdrawal reklasyfikować (znak
  // znaczący), czy znormalizować znak do etykiety (magnitudy bez znaku).
  //
  // Profil może to ZADEKLAROWAĆ (amountSignPolicy) — wtedy nie zgadujemy. Brak
  // pola (stare profile z biblioteki czytane bez walidacji) = 'auto' = heurystyka.
  // 'auto' eliminuje pułapkę: jeden wiersz storna z minusem w pliku-magnitudach
  // nie przełącza wtedy całego pliku w tryb signed, jeśli profil ma 'magnitude'.
  const signPolicy = profile.file.amountSignPolicy ?? 'auto';
  const signedCashAmounts =
    signPolicy === 'signed'
      ? true
      : signPolicy === 'magnitude'
        ? false
        : [
            ...pendingDirect.map((d) => d.pending),
            ...pendingDividends,
            ...pendingWht,
            ...pendingFxLegs,
          ].some((p) => p.amount < 0);

  for (const { cls, pending } of pendingDirect) {
    operations.push(finalizeCashOperation(cls, pending, importBatch, warnings, signedCashAmounts));
  }

  // ── Parowanie ──
  if (profile.pairing.dividendWht && (pendingDividends.length > 0 || pendingWht.length > 0)) {
    const paired = pairDividendsWithWht(
      pendingDividends,
      pendingWht,
      profile.pairing.dividendWht,
      importBatch,
    );
    operations.push(...paired.operations);
    warnings.push(...paired.warnings);
  } else if (pendingWht.length > 0) {
    // withholding_tax bez reguł parowania (schemat tego broni; defensywnie) → fee.
    for (const wht of pendingWht) {
      operations.push(finalizeCashOperation('fee', wht, importBatch, warnings, signedCashAmounts));
    }
  }

  if (pendingFxLegs.length > 0 && profile.pairing.fxLegs) {
    const fx = pairFxLegs(pendingFxLegs, profile.pairing.fxLegs, importBatch);
    operations.push(...fx.operations);
    skippedOps.push(...fx.skipped);
    warnings.push(...fx.warnings);
  }

  return {
    transactions: { data: transactions, skipped: skippedTx },
    operations: { data: operations, skipped: skippedOps },
    rowTraces,
    warnings,
  };
}

// ── Nagłówek ─────────────────────────────────────────────────────────────────

function locateHeaderRow(rows: string[][], profile: ImportProfile): number {
  const spec = profile.file.headerRow;
  if (spec.strategy === 'first') return 0;

  const wanted = spec.signature.map(normalizeHeaderName);
  const limit = Math.min(rows.length, spec.maxScanRows);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map((c) => normalizeHeaderName(String(c ?? '')));
    if (wanted.every((w) => cells.includes(w))) return i;
  }
  throw new GenericParseError(
    `Nie znaleziono wiersza nagłówka zawierającego kolumny: ${spec.signature.join(', ')} ` +
      `(przeskanowano ${limit} wierszy).`,
  );
}

// ── Transakcje ───────────────────────────────────────────────────────────────

type TransactionOutcome =
  | { ok: true; transaction: Transaction }
  | { ok: false; skipped: SkippedRow; warning?: string };

function buildTransaction(
  row: string[],
  rowNum: number,
  profile: ImportProfile,
  resolver: ColumnResolver,
  normalizeCurrency: (raw: string | undefined) => string,
  importBatch: string,
): TransactionOutcome {
  const trade = profile.trade!; // superRefine schematu gwarantuje obecność

  const paperNameRaw = resolveValueSource(trade.paperName, row, resolver);
  const skip = (reason: SkipReason, warning?: string): TransactionOutcome => ({
    ok: false,
    skipped: { row: rowNum, reason, paperName: paperNameRaw || undefined },
    warning,
  });

  // Data: rozróżniamy brak wartości (missing_date) od nieparsowalnej (invalid_date).
  const dateRaw = resolveValueSource(trade.date.source, row, resolver);
  if (!dateRaw) return skip('missing_date');
  const dateIso = resolveDate(trade.date, row, resolver);
  if (!dateIso) return skip('invalid_date');

  if (!paperNameRaw) return skip('missing_name');

  let isinRaw: string | undefined;
  if (trade.isin) {
    isinRaw = resolveValueSource(trade.isin, row, resolver);
    if (!isinRaw) return skip('missing_isin');
  }

  // Strona K/S wg strategii profilu.
  const side = resolveSide(trade.side, row, resolver);
  if (side === null) return skip('invalid_side');

  const quantityRaw = Math.abs(resolveNumber(trade.quantity, row, resolver));
  const quantity = trade.wholeShares ? Math.round(quantityRaw) : quantityRaw;
  if (quantity <= 0) return skip('invalid_quantity');

  // Waluta + wbudowana obsługa GBX (ceny w pensach → GBP, ÷100).
  const currencyNorm = normalizeCurrency(resolveValueSource(trade.currency, row, resolver));
  const isGbx = currencyNorm === 'GBX';
  const currency = isGbx ? 'GBP' : currencyNorm;

  const priceRaw = Math.abs(resolveNumber(trade.price, row, resolver));
  const price = isGbx ? priceRaw / 100 : priceRaw;
  if (price <= 0) return skip('invalid_price');

  // Aliasy ISIN (zdarzenia korporacyjne, np. redomiciliacja) — broker-niezależne.
  // Dla pseudo-ISIN-ów (= paperName) mapa kluczowana prawdziwymi ISIN-ami nie trafi → no-op.
  const pseudoIsin = isinRaw ?? paperNameRaw;
  const { isin, paperName } = applyIsinAlias(pseudoIsin, paperNameRaw);

  const check = validateTradeFields({ date: dateRaw, paperName, side, quantity, price });
  if (!check.ok) return skip(check.reason);

  const value = trade.value
    ? Math.abs(resolveNumber(trade.value, row, resolver))
    : roundTo2(quantity * price);
  const commission = trade.commission
    ? Math.abs(resolveNumber(trade.commission, row, resolver))
    : 0;
  const total = trade.total
    ? resolveNumber(trade.total, row, resolver)
    : computeTotal(side, value, commission);

  // Kategoria: reguły profilu → wbudowana detekcja obligacji → default.
  const category = resolveCategory(trade, row, resolver, paperName, isin);

  // Cross-check mapowania kolumn: wartość z CSV powinna odpowiadać qty×cena.
  // Pomijamy dla obligacji (kurs w % nominału — wartość liczona inaczej) oraz gdy
  // value jest wyliczane (tożsamość). Tolerancja: max(0.05, 1% wartości).
  if (trade.value && category !== 'bond') {
    const expected = quantity * price;
    if (Math.abs(value - expected) > Math.max(0.05, 0.01 * Math.max(value, expected))) {
      return skip(
        'value_mismatch',
        `Wiersz ${rowNum}: wartość ${value.toFixed(2)} odbiega od ilość×cena ` +
          `(${expected.toFixed(2)}) — sprawdź mapowanie kolumn ilości/ceny/wartości.`,
      );
    }
  }

  // Bez jawnego mapowania zakładamy rozliczenie w walucie instrumentu — każdy
  // konsument i tak robi `paymentCurrency || currency`, a jawna wartość pasuje
  // do parserów wbudowanych (Bossa PLN / DEGIRO EUR / XTB accountCurrency) i
  // znika z raportu parytetu. Rzeczywiste rozliczenie multi-walutowe (instrument
  // USD opłacony z konta PLN) nie da się wywieść z waluty wiersza — wymaga
  // symulacji salda (payment-currency-reconciler, dziś tylko ścieżka bulk).
  const explicitPaymentCurrency = trade.paymentCurrency
    ? normalizeCurrency(resolveValueSource(trade.paymentCurrency, row, resolver)) || undefined
    : undefined;
  const paymentCurrency = explicitPaymentCurrency ?? currency;
  const fxRateRaw = trade.fxRate ? resolveNumber(trade.fxRate, row, resolver) : 0;
  // Konwencja kanoniczna Transaction.fxRate = payment-per-quote; kolumny brokerów
  // w odwrotnej konwencji (DEGIRO "Kurs wymiany") profil oznacza fxRateDirection
  // i silnik odwraca — dla GBX z mnożnikiem 100 (kolumna w pensach, cena już w GBP).
  let fxRate = fxRateRaw > 0 ? fxRateRaw : undefined;
  if (fxRate !== undefined && trade.fxRateDirection === 'quotePerPayment') {
    fxRate = (isGbx ? 100 : 1) / fxRate;
  }

  return {
    ok: true,
    transaction: {
      date: dateIso,
      paperName,
      isin,
      quantity,
      side,
      price,
      value,
      commission,
      total,
      currency,
      paymentCurrency,
      fxRate,
      category,
      source: 'generic',
      importBatch,
    },
  };
}

function resolveSide(
  rule: NonNullable<ImportProfile['trade']>['side'],
  row: string[],
  resolver: ColumnResolver,
): 'K' | 'S' | null {
  switch (rule.strategy) {
    case 'column': {
      const cell = (resolver.cell(row, rule.col) ?? '').toLowerCase();
      if (rule.buyValues.some((v) => v.toLowerCase() === cell)) return 'K';
      if (rule.sellValues.some((v) => v.toLowerCase() === cell)) return 'S';
      return null;
    }
    case 'signedQuantity': {
      const qty = parseNumber(resolver.cell(row, rule.col));
      if (qty > 0) return 'K';
      if (qty < 0) return 'S';
      return null;
    }
    case 'signedAmount': {
      const amount = parseNumber(resolver.cell(row, rule.col));
      if (amount < 0) return 'K'; // wydatek = kupno
      if (amount > 0) return 'S';
      return null;
    }
  }
}

function resolveCategory(
  trade: NonNullable<ImportProfile['trade']>,
  row: string[],
  resolver: ColumnResolver,
  paperName: string,
  isin: string,
): InstrumentCategory | undefined {
  if (trade.category) {
    for (const rule of trade.category.rules) {
      const w = rule.when;
      if (w.by === 'matcher' && evalCondition(w.condition, row, resolver)) return rule.category;
      if (
        w.by === 'isinPrefix' &&
        w.prefixes.some((p) => isin.toUpperCase().startsWith(p.toUpperCase()))
      ) {
        return rule.category;
      }
      if (w.by === 'nameRegex' && new RegExp(w.pattern, 'i').test(paperName)) return rule.category;
    }
    // Sekcja jest, żadna reguła nie trafiła — wbudowana detekcja obligacji przed defaultem.
    if (isBondInstrument(paperName, isin)) return 'bond';
    return trade.category.default;
  }
  // Brak sekcji: jak parsery wbudowane — 'bond' z mapy obligacji albo undefined
  // (DB ma DEFAULT 'stock'; undefined pozwala resolverowi doprecyzować później).
  return isBondInstrument(paperName, isin) ? 'bond' : undefined;
}

// ── Operacje gotówkowe ───────────────────────────────────────────────────────

type PendingCashOutcome =
  | { ok: true; pending: PendingCashRow }
  | { ok: false; skipped: SkippedRow };

function buildPendingCash(
  row: string[],
  rowNum: number,
  cls: RowClass,
  mapping: CashMapping,
  profile: ImportProfile,
  resolver: ColumnResolver,
  normalizeCurrency: (raw: string | undefined) => string,
): PendingCashOutcome {
  const description = mapping.description
    ? resolveValueSource(mapping.description, row, resolver)
    : undefined;
  const skip = (reason: SkipReason): PendingCashOutcome => ({
    ok: false,
    skipped: { row: rowNum, reason, paperName: description || undefined },
  });

  const dateRaw = resolveValueSource(mapping.date.source, row, resolver);
  if (!dateRaw) return skip('missing_date');
  const dateIso = resolveDate(mapping.date, row, resolver);
  if (!dateIso) return skip('invalid_date');

  const amount = resolveNumber(mapping.amount, row, resolver);
  if (amount === 0) return skip('zero_amount');

  const currency = normalizeCurrency(resolveValueSource(mapping.currency, row, resolver));

  let rate = 0;
  if (cls === 'fx_leg' && profile.pairing.fxLegs?.rateSource) {
    rate = resolveNumber(profile.pairing.fxLegs.rateSource, row, resolver);
  } else if (mapping.fxRate) {
    rate = resolveNumber(mapping.fxRate, row, resolver);
  }
  const fxPair = mapping.fxPair
    ? resolveValueSource(mapping.fxPair, row, resolver) || undefined
    : undefined;
  let pairKeyValue: string | undefined;
  if (cls === 'fx_leg' && profile.pairing.fxLegs?.pairKey.by === 'column') {
    pairKeyValue = resolver.cell(row, profile.pairing.fxLegs.pairKey.col) || undefined;
  }

  return {
    ok: true,
    pending: {
      rowNum,
      dateIso,
      dateDay: dateIso.slice(0, 10),
      time: dateIso.slice(11, 19),
      amount,
      currency,
      description,
      details: mapping.details
        ? resolveValueSource(mapping.details, row, resolver) || undefined
        : undefined,
      ticker: mapping.ticker
        ? resolveValueSource(mapping.ticker, row, resolver) || undefined
        : undefined,
      isin: mapping.isin ? resolveValueSource(mapping.isin, row, resolver) || undefined : undefined,
      pairKeyValue,
      rate: rate > 0 ? rate : undefined,
      fxPair,
    },
  };
}

/**
 * PendingCashRow → CashOperation z normalizacją znaku wg klasy.
 *
 * deposit/withdrawal — kierunek zależy od tego, czy plik niesie ZNAK
 * (`signedAmounts`):
 * - plik ZE znakiem (Bossa: wypłaty ujemne): znak jest prawdą. Niezgodność
 *   etykiety ze znakiem (np. „wpłata" z kwotą ujemną) → reklasyfikacja na
 *   przeciwną operację z warningiem — znaku NIGDY nie odwracamy w ciemno, bo
 *   sfabrykowałby przepływ, którego nie było.
 * - plik BEZ znaku (Trading 212: magnitudy zawsze dodatnie): prawdą jest
 *   etykieta `classify`. Znak normalizujemy do etykiety (deposit→+, withdrawal→−)
 *   bez reklasyfikacji — dodatnia „wypłata" to po prostu konwencja magnitudy.
 *
 * dividend/coupon → wartość bezwzględna (zwroty dywidend poza zakresem v1).
 * fee/commission_refund/capital_return/other → znak z pliku.
 */
function finalizeCashOperation(
  cls: RowClass,
  pending: PendingCashRow,
  importBatch: string,
  warnings: string[],
  signedAmounts: boolean,
): CashOperation {
  let operationType = CLASS_TO_OPERATION_TYPE[cls] ?? 'other';
  let amount = pending.amount;

  if (cls === 'deposit') {
    if (amount < 0 && signedAmounts) {
      operationType = 'withdrawal';
      warnings.push(
        `Wiersz ${pending.rowNum}: wpłata z ujemną kwotą (${amount}) — ` +
          `zaimportowano jako wypłatę.`,
      );
    } else {
      amount = Math.abs(amount);
    }
  } else if (cls === 'withdrawal') {
    if (amount > 0 && signedAmounts) {
      operationType = 'deposit';
      warnings.push(
        `Wiersz ${pending.rowNum}: wypłata z dodatnią kwotą (${amount}) — ` +
          `zaimportowano jako wpłatę.`,
      );
    } else {
      amount = -Math.abs(amount);
    }
  } else if (cls === 'dividend' || cls === 'coupon') {
    amount = Math.abs(amount);
  }

  return {
    date: pending.dateIso,
    operationType,
    description: pending.description || CLASS_DESCRIPTION_PL[cls] || 'Operacja',
    details: pending.details,
    amount,
    currency: pending.currency,
    ticker: pending.ticker,
    fxRate: pending.rate,
    fxPair: pending.fxPair,
    source: 'generic',
    importBatch,
    subkind: cls === 'coupon' ? 'coupon' : cls === 'interest' ? 'interest' : undefined,
  };
}
