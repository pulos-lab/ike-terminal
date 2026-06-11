import { Badge } from '@/components/ui/badge';
import type { OperationType } from 'shared';
import { OPERATION_TYPE_LABELS } from '@/lib/import-labels';

const VARIANT: Partial<Record<OperationType, 'success' | 'warning' | 'info' | 'muted'>> = {
  deposit: 'success',
  withdrawal: 'warning',
  dividend: 'info',
  fx_exchange: 'info',
  fee: 'muted',
  trade_fee: 'muted',
  commission_refund: 'success',
  capital_return: 'info',
  other: 'muted',
};

export function OperationTypeBadge({ type }: { type: OperationType }) {
  return <Badge variant={VARIANT[type] ?? 'muted'}>{OPERATION_TYPE_LABELS[type] ?? type}</Badge>;
}
