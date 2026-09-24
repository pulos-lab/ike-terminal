import type { CashOperation, CashOperationAliasTarget, OperationType, RecordSource } from 'shared';

/** Dozwolone operationType dla aliasów cash_operation — bez typów specjalnych
 * (fx_exchange wymaga parowania nóg, corporate_action_pending logiki reconciliation). */
export const ALIAS_ALLOWED_OPERATION_TYPES = new Set<OperationType>([
  'deposit',
  'withdrawal',
  'dividend',
  'fee',
  'trade_fee',
  'commission_refund',
  'capital_return',
  'other',
]);

/**
 * Operacja gotówkowa z zatwierdzonego aliasu `cash_operation` — wspólna dla
 * parserów konsultujących aliasy (XTB, Trading 212). Zwraca null przy
 * nieparsowalnym/niedozwolonym targecie — wiersz spada wtedy do skrzynki.
 */
export function buildAliasedCashOperation(
  row: {
    date: string;
    amount: number;
    currency: string;
    description: string;
    ticker?: string;
    source: RecordSource;
    importBatch: string;
  },
  targetJson: string,
): CashOperation | null {
  let target: CashOperationAliasTarget;
  try {
    target = JSON.parse(targetJson);
  } catch {
    return null;
  }
  if (!target?.operationType || !ALIAS_ALLOWED_OPERATION_TYPES.has(target.operationType)) {
    return null;
  }
  const sign = target.sign ?? 'file';
  const amount =
    sign === 'file' ? row.amount : sign === '+' ? Math.abs(row.amount) : -Math.abs(row.amount);
  return {
    date: row.date,
    operationType: target.operationType,
    subkind: (target.subkind as CashOperation['subkind']) ?? undefined,
    description: row.description,
    amount,
    currency: row.currency,
    ticker: row.ticker || undefined,
    source: row.source,
    importBatch: row.importBatch,
  };
}
