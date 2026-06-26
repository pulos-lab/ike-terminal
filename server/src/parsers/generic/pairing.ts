import type { CashOperation, PairingRules, SkippedRow } from 'shared';
import { roundTo2 } from '../utils.js';

/**
 * Parowanie wierszy importu generycznego:
 * - dywidenda ↔ podatek u źródła (WHT) — netto na dywidendzie lub osobny fee,
 * - nogi wymiany walutowej (debet + kredyt) → operacje fx_exchange.
 *
 * Zasada: NIC nie ginie. Niesparowany WHT trafia jako 'fee' + warning;
 * niesparowana noga FX jest importowana samodzielnie jako fx_exchange
 * (poprawność salda gotówki ważniejsza od kompletu pary — wzorzec DEGIRO).
 */

/** Wiersz gotówkowy zbuforowany do parowania (po zmapowaniu pól, przed emisją). */
export interface PendingCashRow {
  rowNum: number;
  /** Pełne ISO 8601 z czasem. */
  dateIso: string;
  /** YYYY-MM-DD — do dopasowań z oknem dni. */
  dateDay: string;
  /** HH:MM:SS — do dopasowań po czasie. */
  time: string;
  /** Kwota ze znakiem, jak w pliku. */
  amount: number;
  currency: string;
  description?: string;
  details?: string;
  ticker?: string;
  /** ISIN — wyłącznie klucz parowania dywidenda↔WHT (nie trafia do CashOperation). */
  isin?: string;
  /** fx_leg: wartość kolumny klucza parowania (np. id zlecenia). */
  pairKeyValue?: string;
  /** Kurs wymiany (z pairing.fxLegs.rateSource lub mapowania fxRate). */
  rate?: number;
  /** Para walutowa z mapowania fxPair (jednowierszowe operacje FX). */
  fxPair?: string;
  /** Podatek u źródła z KOLUMNY tego wiersza (inline WHT) — wartość bezwzględna. */
  tax?: number;
  /** Waluta podatku inline (gdy inna niż waluta kwoty → nie odejmujemy). */
  taxCurrency?: string;
}

const dayDiff = (a: string, b: string): number =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

export interface DividendPairingResult {
  operations: CashOperation[];
  warnings: string[];
}

/**
 * Paruje dywidendy z podatkami u źródła wg kluczy z profilu. Każdy wiersz
 * podatku może być zużyty tylko raz (dwie dywidendy o tym samym kluczu nie
 * odejmą tego samego podatku dwukrotnie — wzorzec DEGIRO).
 */
export function pairDividendsWithWht(
  dividends: PendingCashRow[],
  whtRows: PendingCashRow[],
  rules: NonNullable<PairingRules['dividendWht']>,
  importBatch: string,
): DividendPairingResult {
  const operations: CashOperation[] = [];
  const warnings: string[] = [];
  const usedWht = new Set<number>();

  const matches = (div: PendingCashRow, wht: PendingCashRow): boolean => {
    for (const key of rules.matchBy) {
      if (key === 'isin' && (div.isin ?? '') !== (wht.isin ?? '')) return false;
      if (key === 'ticker' && (div.ticker ?? '') !== (wht.ticker ?? '')) return false;
      if (key === 'date' && dayDiff(div.dateDay, wht.dateDay) > rules.windowDays) return false;
      if (key === 'time' && div.time !== wht.time) return false;
    }
    return true;
  };

  for (const div of dividends) {
    const wht = whtRows.find((t) => !usedWht.has(t.rowNum) && matches(div, t));
    if (wht) usedWht.add(wht.rowNum);

    const gross = Math.abs(div.amount);
    const tax = wht ? Math.abs(wht.amount) : 0;

    if (rules.handling === 'subtract') {
      const taxPct = gross > 0 ? Math.round((tax / gross) * 100) : 0;
      const baseDesc = div.description || 'Dywidenda';
      operations.push({
        date: div.dateIso,
        operationType: 'dividend',
        description: taxPct > 0 ? `${baseDesc} (podatek ${taxPct}%)` : baseDesc,
        details: div.details,
        amount: roundTo2(gross - tax),
        currency: div.currency,
        ticker: div.ticker,
        source: 'generic',
        importBatch,
      });
    } else {
      operations.push({
        date: div.dateIso,
        operationType: 'dividend',
        description: div.description || 'Dywidenda',
        details: div.details,
        amount: gross,
        currency: div.currency,
        ticker: div.ticker,
        source: 'generic',
        importBatch,
      });
      if (wht) {
        operations.push({
          date: wht.dateIso,
          operationType: 'fee',
          description: wht.description || `Podatek u źródła${div.ticker ? ` ${div.ticker}` : ''}`,
          amount: -tax,
          currency: wht.currency,
          ticker: wht.ticker,
          source: 'generic',
          importBatch,
        });
      }
    }
  }

  // Niesparowane podatki — importowane jako fee, żeby cashflow się zgadzał.
  for (const wht of whtRows) {
    if (usedWht.has(wht.rowNum)) continue;
    operations.push({
      date: wht.dateIso,
      operationType: 'fee',
      description: wht.description || 'Podatek u źródła (niesparowany)',
      amount: -Math.abs(wht.amount),
      currency: wht.currency,
      ticker: wht.ticker,
      source: 'generic',
      importBatch,
    });
    warnings.push(
      `Wiersz ${wht.rowNum}: podatek u źródła${wht.ticker ? ` (${wht.ticker})` : ''} bez ` +
        `pasującej dywidendy — zaimportowano jako opłatę.`,
    );
  }

  return { operations, warnings };
}

export interface FxPairingResult {
  operations: CashOperation[];
  skipped: SkippedRow[];
  warnings: string[];
}

/**
 * Paruje nogi wymiany walutowej: ujemna (sprzedaż waluty) + dodatnia (kupno).
 * Para → DWIE operacje fx_exchange (po jednej na walutę) ze wspólnym fxRate
 * i fxPair "FROM/TO". Kurs: rateSource z nogi kredytowej → debetowej →
 * wyliczony |credit|/|debit|.
 */
export function pairFxLegs(
  legs: PendingCashRow[],
  rules: NonNullable<PairingRules['fxLegs']>,
  importBatch: string,
): FxPairingResult {
  const operations: CashOperation[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: string[] = [];

  const credits = legs.filter((l) => l.amount > 0);
  const debits = legs.filter((l) => l.amount < 0);
  const zeroLegs = legs.filter((l) => l.amount === 0);
  for (const leg of zeroLegs) {
    skipped.push({ row: leg.rowNum, reason: 'zero_amount', paperName: leg.description });
  }

  const usedDebits = new Set<number>();

  const emitPair = (debit: PendingCashRow, credit: PendingCashRow) => {
    // Kurs wyliczany ma 6 miejsc — zaokrąglenie do 2 zniekształcałoby pary typu 3.5713.
    const computedRate = Number((Math.abs(credit.amount) / Math.abs(debit.amount)).toFixed(6));
    const fxRate = credit.rate || debit.rate || computedRate || undefined;
    const fxPair = `${debit.currency}/${credit.currency}`;
    const description = `Wymiana ${fxPair}`;
    operations.push({
      date: debit.dateIso,
      operationType: 'fx_exchange',
      description,
      amount: debit.amount,
      currency: debit.currency,
      fxRate,
      fxPair,
      source: 'generic',
      importBatch,
    });
    operations.push({
      date: credit.dateIso,
      operationType: 'fx_exchange',
      description,
      amount: credit.amount,
      currency: credit.currency,
      fxRate,
      fxPair,
      source: 'generic',
      importBatch,
    });
  };

  for (const credit of credits) {
    let debit: PendingCashRow | undefined;
    if (rules.pairKey.by === 'column') {
      if (credit.pairKeyValue) {
        debit = debits.find(
          (d) => !usedDebits.has(d.rowNum) && d.pairKeyValue === credit.pairKeyValue,
        );
      }
      // Fallback dla nóg bez klucza (ręczne wymiany) — po dacie i czasie.
      if (!debit) {
        debit = debits.find(
          (d) =>
            !usedDebits.has(d.rowNum) && d.dateDay === credit.dateDay && d.time === credit.time,
        );
      }
    } else {
      debit = debits.find(
        (d) => !usedDebits.has(d.rowNum) && d.dateDay === credit.dateDay && d.time === credit.time,
      );
    }

    if (debit) {
      usedDebits.add(debit.rowNum);
      emitPair(debit, credit);
    } else {
      // Niesparowany kredyt — importuj samodzielnie (saldo gotówki musi się zgadzać).
      operations.push({
        date: credit.dateIso,
        operationType: 'fx_exchange',
        description: `${credit.description || 'Wymiana walut'} ${credit.currency}`.trim(),
        amount: credit.amount,
        currency: credit.currency,
        source: 'generic',
        importBatch,
      });
      warnings.push(
        `Wiersz ${credit.rowNum}: niesparowana noga wymiany walutowej ` +
          `(+${Math.abs(credit.amount)} ${credit.currency}) — zaimportowano bez pary.`,
      );
    }
  }

  for (const debit of debits) {
    if (usedDebits.has(debit.rowNum)) continue;
    operations.push({
      date: debit.dateIso,
      operationType: 'fx_exchange',
      description: `${debit.description || 'Wymiana walut'} ${debit.currency}`.trim(),
      amount: debit.amount,
      currency: debit.currency,
      source: 'generic',
      importBatch,
    });
    warnings.push(
      `Wiersz ${debit.rowNum}: niesparowana noga wymiany walutowej ` +
        `(−${Math.abs(debit.amount)} ${debit.currency}) — zaimportowano bez pary.`,
    );
  }

  return { operations, skipped, warnings };
}
