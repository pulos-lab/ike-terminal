import Papa from 'papaparse';
import type { Transaction, CashOperation, SkippedRow } from 'shared';
import type { CombinedParseOutput } from '../registry.js';
// Marker splitu jest wspólny dla wszystkich parserów combined (nazwa historyczna
// po IBKR) — `CombinedParseOutput.splits` przyjmuje dokładnie ten typ.
import type { IbkrSplitMarker } from '../ibkr/index.js';
import {
  parseNumber,
  roundTo2,
  roundFxRate,
  computeTotal,
  validateTradeFields,
  detectColumnShift,
  columnShiftWarning,
  rawRowForWarning,
} from '../utils.js';
import { mapT212Columns, parseT212Time, type T212Columns } from './t212-columns.js';
import { classifyT212Action } from './t212-actions.js';

/**
 * Parser eksportu Trading 212 (CSV, UTF-8).
 *
 * JEDEN plik zawiera transakcje, operacje gotówkowe ORAZ splity, dlatego
 * parser żyje w `COMBINED_PARSER_REGISTRY` obok XTB i IBKR, a nie w rejestrze
 * plików CSV (tam jeden plik pełni jedną rolę).
 *
 * Konwencje walutowe (potwierdzone na 27 realnych próbkach):
 * - `Price / share` + `Currency (Price / share)` = notowanie instrumentu (quote);
 * - `Total` + `Currency (Total)` = kwota rozliczenia w walucie KONTA (payment),
 *   przy czym dla kupna zawiera już opłatę za przewalutowanie — dlatego
 *   `value` liczymy z ilości i ceny, a nie z `Total`;
 * - `Exchange rate` to kurs quote-per-payment (jak „Kurs wymiany" DEGIRO),
 *   więc kanoniczny `Transaction.fxRate` (payment-per-quote) to jego odwrotność;
 * - opłaty i podatki transakcyjne mają WŁASNE kolumny waluty i bywają w walucie
 *   konta, a nie notowania — przeliczamy je na walutę notowania, żeby `total`
 *   pozostał jednowalutowy (ta sama zasada co w parserze mBanku).
 */

const SOURCE = 'trading212' as const;

/** Wiersze bez instrumentu nie mają czego walidować pod kątem przesunięcia kolumn. */
type RowKind = ReturnType<typeof classifyT212Action>;

export function isT212Format(buffer: Buffer): boolean {
  const head = buffer.toString('utf8', 0, 4096).replace(/^﻿/, '');
  const firstLine = head.split(/\r?\n/)[0];
  if (!firstLine) return false;
  const parsed = Papa.parse<string[]>(firstLine, { delimiter: ',' });
  const headers = parsed.data[0];
  return Array.isArray(headers) && mapT212Columns(headers) !== null;
}

export function parseT212File(
  buffer: Buffer,
  importBatch: string,
  _fileName?: string,
): Promise<CombinedParseOutput> {
  const content = buffer.toString('utf8').replace(/^﻿/, '');
  const parsed = Papa.parse<string[]>(content.trim(), { delimiter: ',', skipEmptyLines: true });
  const rows = parsed.data;

  const transactions: Transaction[] = [];
  const operations: CashOperation[] = [];
  const txSkipped: SkippedRow[] = [];
  const opsSkipped: SkippedRow[] = [];
  const warnings: string[] = [];
  const splits: IbkrSplitMarker[] = [];

  const cols = rows.length > 0 ? mapT212Columns(rows[0]) : null;
  if (!cols)
    return Promise.resolve({
      transactions: { data: [], skipped: [] },
      operations: { data: [], skipped: [] },
    });

  /** Nogi splitu czekające na parę (klucz: ISIN + dzień). */
  const splitLegs = new Map<
    string,
    { open?: number; close?: number; ticker: string; date: string }
  >();
  let unconvertibleFees = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1; // 1-based z nagłówkiem
    const at = (idx: number): string | undefined => (idx >= 0 ? row[idx] : undefined);

    const rawAction = at(cols.action)?.trim();
    const action = classifyT212Action(rawAction);
    const name = at(cols.name)?.trim();

    if (!action) {
      // Nieznany typ → kwarantanna. NIE zgadujemy po prefiksie: "Market look"
      // wygląda jak "Market buy", a nim nie jest.
      opsSkipped.push({
        row: rowNum,
        reason: 'unknown_operation_type',
        paperName: rawAction || name,
      });
      continue;
    }

    const isoDate = parseT212Time(at(cols.time));
    if (!isoDate) {
      const bucket =
        action.kind === 'trade' || action.kind === 'share_grant' ? txSkipped : opsSkipped;
      bucket.push({ row: rowNum, reason: 'invalid_date', paperName: name });
      continue;
    }

    // Wiersze z instrumentem: ochrona przed przesunięciem kolumn. Plik z jednego
    // ze źródeł publicznych ma wiersze sklejone z INNEGO wariantu nagłówka —
    // liczba pól się zgadza, ale w kolumnie ceny siedzi identyfikator zlecenia.
    if (hasInstrument(action)) {
      const problems = detectColumnShift([
        { label: 'Time', value: at(cols.time), kind: 'date' },
        { label: 'No. of shares', value: at(cols.shares), kind: 'number' },
        { label: 'Price / share', value: at(cols.price), kind: 'number' },
        { label: 'Currency (Price / share)', value: at(cols.priceCurrency), kind: 'currency' },
      ]);
      if (problems.length > 0) {
        txSkipped.push({ row: rowNum, reason: 'column_shift', paperName: name });
        warnings.push(columnShiftWarning(rowNum, problems, rawRowForWarning(row, ',')));
        continue;
      }
    }

    const isin = at(cols.isin)?.trim();
    const ticker = at(cols.ticker)?.trim();
    const quantity = parseNumber(at(cols.shares));
    const price = parseNumber(at(cols.price));
    const quoteCurrency = at(cols.priceCurrency)?.trim() || 'EUR';
    const totalAmount = parseNumber(at(cols.total));
    const paymentCurrency = at(cols.totalCurrency)?.trim() || quoteCurrency;
    const notes = at(cols.notes)?.trim();

    // "Not available" przy dywidendach — nie parsujemy na siłę.
    const rawRate = at(cols.exchangeRate)?.trim();
    const exchangeRate =
      rawRate && /^\d/.test(rawRate) && parseNumber(rawRate) > 0 ? parseNumber(rawRate) : undefined;
    const fxRate =
      quoteCurrency !== paymentCurrency && exchangeRate ? roundFxRate(1 / exchangeRate) : undefined;

    switch (action.kind) {
      case 'trade':
      case 'share_grant': {
        const side = action.kind === 'trade' ? action.side : 'K';
        // Przydział akcji (dywidenda w akcjach, dystrybucja) ma cenę 0 —
        // wspólna walidacja odrzuciłaby go jako invalid_price.
        if (action.kind === 'trade') {
          const check = validateTradeFields({
            date: isoDate,
            paperName: name,
            isin,
            side,
            quantity,
            price,
          });
          if (!check.ok) {
            txSkipped.push({ row: rowNum, reason: check.reason, paperName: name });
            continue;
          }
        } else if (!isin || !(quantity > 0)) {
          txSkipped.push({
            row: rowNum,
            reason: !isin ? 'missing_isin' : 'invalid_quantity',
            paperName: name,
          });
          continue;
        }

        const { commission, unconvertible } = sumFees(
          cols,
          at,
          quoteCurrency,
          paymentCurrency,
          exchangeRate,
        );
        if (unconvertible) unconvertibleFees++;
        const value = roundTo2(quantity * price);

        transactions.push({
          date: isoDate,
          paperName: name || ticker || isin!,
          isin: isin!,
          quantity,
          side,
          price,
          value,
          commission,
          total: computeTotal(side, value, commission),
          currency: quoteCurrency,
          paymentCurrency,
          fxRate,
          source: SOURCE,
          importBatch,
        });
        break;
      }

      case 'transfer_out': {
        // Papier opuszcza rachunek. Domykamy pozycję syntetyczną sprzedażą po
        // cenie z pliku (T212 ją podaje) i RÓWNOWAŻĄCĄ WYPŁATĄ na tę samą
        // kwotę — sama sprzedaż dopisałaby gotówkę, która nigdy nie wpłynęła.
        if (!isin || !(quantity > 0) || !(price > 0)) {
          txSkipped.push({ row: rowNum, reason: 'invalid_quantity', paperName: name });
          continue;
        }
        const value = roundTo2(quantity * price);
        transactions.push({
          date: isoDate,
          paperName: name || ticker || isin,
          isin,
          quantity,
          side: 'S',
          price,
          value,
          commission: 0,
          total: value,
          currency: quoteCurrency,
          paymentCurrency,
          fxRate,
          source: SOURCE,
          importBatch,
          syntheticOrigin: 'transfer_out',
        });
        operations.push({
          date: isoDate,
          operationType: 'withdrawal',
          description: `Transfer papierów: ${name || ticker || isin}`,
          amount: -Math.abs(totalAmount || roundTo2(value * (fxRate ?? 1))),
          currency: paymentCurrency,
          source: SOURCE,
          importBatch,
        });
        break;
      }

      case 'split': {
        const key = `${isin}|${isoDate.slice(0, 10)}`;
        const entry = splitLegs.get(key) ?? { ticker: ticker || '', date: isoDate.slice(0, 10) };
        entry[action.leg] = quantity;
        splitLegs.set(key, entry);
        break;
      }

      case 'dividend':
      case 'dividend_adjustment': {
        operations.push({
          date: isoDate,
          operationType: 'dividend',
          description:
            action.kind === 'dividend_adjustment'
              ? `Korekta dywidendy${notes ? `: ${notes}` : ''}`
              : `Dywidenda ${ticker || name || ''}`.trim(),
          amount: totalAmount,
          currency: paymentCurrency,
          ticker: ticker || undefined,
          source: SOURCE,
          importBatch,
        });
        // Podatek u źródła bywa w INNEJ walucie niż kwota, która wpłynęła
        // (0,01 USD przy dywidendzie 0,03 EUR) — księgujemy osobno, z własną
        // walutą, wzorem parsera XTB.
        const wht = parseNumber(at(cols.withholdingTax));
        if (wht > 0) {
          operations.push({
            date: isoDate,
            operationType: 'fee',
            description: `Podatek u źródła ${ticker || name || ''}`.trim(),
            amount: -Math.abs(wht),
            currency: at(cols.withholdingTaxCurrency)?.trim() || paymentCurrency,
            ticker: ticker || undefined,
            source: SOURCE,
            importBatch,
          });
        }
        break;
      }

      case 'cash': {
        // Znak wymuszamy z TYPU, nie z pliku: T212 raz eksportuje wypłatę jako
        // -1000.00, a raz jako magnitudę bez znaku.
        const magnitude = Math.abs(totalAmount);
        if (!(magnitude > 0)) {
          opsSkipped.push({ row: rowNum, reason: 'zero_amount', paperName: rawAction });
          continue;
        }
        operations.push({
          date: isoDate,
          operationType: action.direction === 'in' ? 'deposit' : 'withdrawal',
          description: describeCash(rawAction, notes, at(cols.id)),
          amount: action.direction === 'in' ? magnitude : -magnitude,
          currency: paymentCurrency,
          source: SOURCE,
          importBatch,
        });
        break;
      }

      case 'interest': {
        operations.push({
          date: isoDate,
          operationType: 'other',
          description: notes || rawAction || 'Odsetki',
          amount: totalAmount,
          currency: paymentCurrency,
          subkind: 'interest',
          source: SOURCE,
          importBatch,
        });
        break;
      }

      case 'fx': {
        const legs = readFxLegs(cols, at, notes);
        if (!legs) {
          opsSkipped.push({
            row: rowNum,
            reason: 'unparseable_comment',
            paperName: notes || rawAction,
          });
          continue;
        }
        const rate =
          legs.to.amount !== 0 ? roundFxRate(legs.to.amount / legs.from.amount) : undefined;
        const fxPair = `${legs.from.currency}/${legs.to.currency}`;
        const description = `Wymiana ${fxPair}`;
        operations.push({
          date: isoDate,
          operationType: 'fx_exchange',
          description,
          amount: -Math.abs(legs.from.amount),
          currency: legs.from.currency,
          fxRate: rate,
          fxPair,
          source: SOURCE,
          importBatch,
        });
        operations.push({
          date: isoDate,
          operationType: 'fx_exchange',
          description,
          amount: Math.abs(legs.to.amount),
          currency: legs.to.currency,
          fxRate: rate,
          fxPair,
          source: SOURCE,
          importBatch,
        });
        break;
      }
    }
  }

  // Split = para wierszy open+close na tym samym ISIN i dniu; ratio to stosunek
  // ilości PO do ilości PRZED (konwencja IbkrSplitMarker).
  for (const [key, legs] of splitLegs) {
    const isin = key.split('|')[0];
    if (!legs.open || !legs.close) {
      warnings.push(
        `Trading 212: niesparowana noga splitu dla ${legs.ticker || isin} (${legs.date}) — split nie został zastosowany.`,
      );
      continue;
    }
    splits.push({
      isin,
      ticker: legs.ticker,
      exDate: legs.date,
      ratio: roundFxRate(legs.open / legs.close),
    });
  }

  if (unconvertibleFees > 0) {
    warnings.push(
      `Trading 212: w ${unconvertibleFees} transakcjach pominięto opłatę podaną w walucie, ` +
        `której nie da się przeliczyć na walutę notowania (brak kursu w pliku).`,
    );
  }

  return Promise.resolve({
    transactions: { data: transactions, skipped: txSkipped },
    operations: { data: operations, skipped: opsSkipped },
    warnings: warnings.length > 0 ? warnings : undefined,
    splits: splits.length > 0 ? splits : undefined,
  });
}

function hasInstrument(action: NonNullable<RowKind>): boolean {
  return (
    action.kind === 'trade' ||
    action.kind === 'share_grant' ||
    action.kind === 'split' ||
    action.kind === 'transfer_out'
  );
}

/** Funt i pens to ta sama waluta w dwóch jednostkach: 1 GBP = 100 GBX. */
function gbpGbxFactor(from: string, to: string): number | null {
  if (from === 'GBP' && to === 'GBX') return 100;
  if (from === 'GBX' && to === 'GBP') return 0.01;
  return null;
}

/**
 * Suma opłat i podatków transakcyjnych, przeliczona na walutę NOTOWANIA
 * (żeby `total` pozostał jednowalutowy — ta sama zasada co w parserze mBanku).
 *
 * Opłata bywa w TRZECIEJ walucie: realny plik ma podatek „Stamp duty reserve
 * tax" w GBP przy notowaniu w GBX i rozliczeniu w EUR. `Exchange rate` przelicza
 * wyłącznie walutę rozliczenia na walutę notowania, więc użycie go do GBP dałoby
 * wynik zaniżony ~17×. Kolejność: ta sama waluta → funt/pens → waluta
 * rozliczenia przez kurs z pliku → pominięcie z ostrzeżeniem.
 */
function sumFees(
  cols: T212Columns,
  at: (idx: number) => string | undefined,
  quoteCurrency: string,
  paymentCurrency: string,
  exchangeRate: number | undefined,
): { commission: number; unconvertible: boolean } {
  let commission = 0;
  let unconvertible = false;
  for (const fee of cols.fees) {
    const amount = parseNumber(at(fee.amount));
    if (!(amount > 0)) continue;
    const currency = at(fee.currency)?.trim() || quoteCurrency;
    const factor = gbpGbxFactor(currency, quoteCurrency);
    if (currency === quoteCurrency) {
      commission += amount;
    } else if (factor !== null) {
      commission += amount * factor;
    } else if (currency === paymentCurrency && exchangeRate) {
      commission += amount * exchangeRate;
    } else {
      unconvertible = true;
    }
  }
  return { commission: roundTo2(commission), unconvertible };
}

interface FxLeg {
  amount: number;
  currency: string;
}

/**
 * Kwoty wymiany walut: nowszy wariant ma własne kolumny, starszy podaje je
 * WYŁĄCZNIE w opisie („0.01 GBP -> 0.01 EUR"), stąd fallback regexem.
 */
function readFxLegs(
  cols: T212Columns,
  at: (idx: number) => string | undefined,
  notes: string | undefined,
): { from: FxLeg; to: FxLeg } | null {
  const fromAmount = parseNumber(at(cols.fxFromAmount));
  const toAmount = parseNumber(at(cols.fxToAmount));
  const fromCurrency = at(cols.fxFromCurrency)?.trim();
  const toCurrency = at(cols.fxToCurrency)?.trim();
  if (fromAmount > 0 && toAmount > 0 && fromCurrency && toCurrency) {
    return {
      from: { amount: fromAmount, currency: fromCurrency },
      to: { amount: toAmount, currency: toCurrency },
    };
  }

  const m = notes ? /([\d.,]+)\s*([A-Z]{3})\s*->\s*([\d.,]+)\s*([A-Z]{3})/.exec(notes) : null;
  if (!m) return null;
  return {
    from: { amount: parseNumber(m[1]), currency: m[2] },
    to: { amount: parseNumber(m[3]), currency: m[4] },
  };
}

/** Opis operacji gotówkowej — `Notes` bywa puste, wtedy zostaje sam typ. */
function describeCash(
  action: string | undefined,
  notes: string | undefined,
  id: string | undefined,
): string {
  if (notes) return notes;
  if (action) return id ? `${action} (${id})` : action;
  return 'Operacja gotówkowa';
}
