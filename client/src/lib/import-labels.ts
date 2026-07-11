import type { OperationType, SkipReason } from 'shared';

/**
 * Etykiety PL dla importu — współdzielone przez ImportDialog i kreator
 * importu uniwersalnego (osobny plik: komponenty nie mogą eksportować stałych
 * bez psucia fast-refresh).
 */

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  missing_date: 'brak daty',
  missing_isin: 'brak ISIN',
  missing_name: 'brak nazwy',
  invalid_side: 'nieprawidłowa strona (K/S)',
  invalid_quantity: 'nieprawidłowa ilość',
  invalid_price: 'nieprawidłowa cena',
  invalid_date: 'nieprawidłowy format daty',
  corporate_action: 'akcja korporacyjna',
  short_row: 'niekompletny wiersz',
  zero_amount: 'kwota zerowa',
  settlement_record: 'rozliczenie transakcji',
  summary_row: 'wiersz podsumowania',
  unparseable_comment: 'nierozpoznany format komentarza',
  close_trade_entry: 'wpis P/L (pominięty)',
  missing_description: 'brak opisu operacji',
  unmatched_fx_credit: 'niesparowana wymiana walut',
  duplicate: 'duplikat (już zaimportowano)',
  redemption_reconciled: 'wykup/wezwanie (domknięte syntetyczną sprzedażą)',
  capital_return_reconciled: 'zwrot kapitału (widoczny w Zdarzeniach korporacyjnych)',
  unknown_operation_type: 'nierozpoznany typ operacji',
  unknown_type: 'nieznany typ operacji',
  unparseable_fx_comment: 'Transfer XTB — nie udało się odczytać pary walut/kursu',
  invalid_fx_rate: 'Transfer XTB — nieprawidłowy kurs wymiany',
  fx_currency_mismatch: 'Transfer XTB — waluta niezgodna z kontem',
  value_mismatch: 'wartość odbiega od ilość×cena (sprawdź mapowanie kolumn)',
  column_shift: 'wartości nie pasują do kolumn (podejrzane przesunięcie kolumn)',
};

export const OPERATION_TYPE_LABELS: Record<OperationType, string> = {
  deposit: 'Wpłata',
  withdrawal: 'Wypłata',
  dividend: 'Dywidenda',
  fx_exchange: 'Wymiana walut',
  fee: 'Opłata',
  trade_fee: 'Koszt pozycji',
  commission_refund: 'Zwrot prowizji',
  capital_return: 'Zwrot kapitału',
  corporate_action_pending: 'Zdarzenie korporacyjne',
  other: 'Inna',
};
