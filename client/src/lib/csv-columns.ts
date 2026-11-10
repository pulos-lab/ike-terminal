import type { ClosedTrade, DividendRecord, Position, TransactionWithMeta } from 'shared';
import { csvDate, type CsvColumn } from './csv-export';

/**
 * Definicje kolumn eksportu — osobno od stron, żeby dało się je przetestować
 * bez renderowania i żeby każda tabela miała JEDEN opis tego, co trafia do pliku.
 * Kwoty zostają w walucie wiersza, z walutą w osobnej kolumnie: zsumowanie
 * kolumny mieszającej PLN z USD dałoby liczbę bez znaczenia.
 */

export const POSITION_COLUMNS: CsvColumn<Position>[] = [
  { header: 'Ticker', value: (p) => p.ticker },
  { header: 'Nazwa', value: (p) => p.paperName },
  { header: 'ISIN', value: (p) => p.isin },
  { header: 'Kategoria', value: (p) => p.category ?? 'stock' },
  { header: 'Ilość', value: (p) => p.shares },
  { header: 'Średnia cena', value: (p) => p.avgBuyPrice },
  { header: 'Kurs', value: (p) => p.currentPrice },
  { header: 'Waluta', value: (p) => p.currency },
  { header: 'Zmiana dzienna %', value: (p) => p.dailyChangePct },
  { header: 'Wartość', value: (p) => p.currentValue },
  { header: 'Wartość PLN', value: (p) => p.currentValuePln },
  { header: 'Zysk/strata', value: (p) => p.profitLoss },
  { header: 'Zysk/strata PLN', value: (p) => p.profitLossPln },
  { header: 'Zysk/strata %', value: (p) => p.profitLossPct },
  { header: 'Udział %', value: (p) => p.weight },
  { header: 'Giełda', value: (p) => p.exchange ?? '' },
  { header: 'Sektor', value: (p) => p.sector ?? '' },
  { header: 'Kraj', value: (p) => p.country ?? '' },
  // Cena z ostatniej transakcji lub zapisanego notowania — w pliku nie widać
  // ikonki ostrzeżenia z tabeli, więc mówimy to wprost.
  { header: 'Cena niepotwierdzona', value: (p) => (p.priceManual ? 'tak' : '') },
];

export const TRANSACTION_COLUMNS: CsvColumn<TransactionWithMeta>[] = [
  { header: 'Data', value: (t) => csvDate(t.date) },
  { header: 'Ticker', value: (t) => t.ticker },
  { header: 'Nazwa', value: (t) => t.name || t.paperName },
  { header: 'ISIN', value: (t) => t.isin },
  { header: 'Strona', value: (t) => (t.side === 'K' ? 'Kupno' : 'Sprzedaż') },
  { header: 'Ilość', value: (t) => t.quantity },
  { header: 'Cena', value: (t) => t.price },
  { header: 'Waluta', value: (t) => t.currency },
  { header: 'Wartość', value: (t) => t.value },
  { header: 'Prowizja', value: (t) => t.commission },
  { header: 'Razem', value: (t) => t.total },
  { header: 'Waluta rozliczenia', value: (t) => t.paymentCurrency || t.currency },
  { header: 'Kurs rozliczenia', value: (t) => t.fxRate ?? null },
  { header: 'Kategoria', value: (t) => t.category ?? 'stock' },
  { header: 'Giełda', value: (t) => t.exchange ?? '' },
];

export const DIVIDEND_COLUMNS: CsvColumn<DividendRecord>[] = [
  { header: 'Data', value: (d) => csvDate(d.date) },
  { header: 'Ticker', value: (d) => d.ticker },
  { header: 'Rodzaj', value: (d) => (d.subkind === 'coupon' ? 'Kupon' : 'Dywidenda') },
  { header: 'Kwota netto', value: (d) => d.amount },
  { header: 'Waluta', value: (d) => d.currency },
  { header: 'Kwota PLN', value: (d) => d.amountPln ?? null },
  { header: 'Opis', value: (d) => d.description },
  { header: 'Źródło', value: (d) => d.source },
  { header: 'ISIN', value: (d) => d.isin ?? '' },
];

export const CLOSED_TRADE_COLUMNS: CsvColumn<ClosedTrade>[] = [
  { header: 'Ticker', value: (t) => t.ticker },
  { header: 'Nazwa', value: (t) => t.paperName },
  { header: 'ISIN', value: (t) => t.isin },
  { header: 'Kierunek', value: (t) => (t.isShort ? 'Short' : 'Long') },
  { header: 'Ilość', value: (t) => t.quantity },
  { header: 'Data otwarcia', value: (t) => csvDate(t.buyDate) },
  { header: 'Cena otwarcia', value: (t) => t.buyPrice },
  { header: 'Prowizja otwarcia', value: (t) => t.buyCommission },
  { header: 'Waluta otwarcia', value: (t) => t.buyCurrency ?? t.currency },
  { header: 'Data zamknięcia', value: (t) => csvDate(t.sellDate) },
  { header: 'Cena zamknięcia', value: (t) => t.sellPrice },
  { header: 'Prowizja zamknięcia', value: (t) => t.sellCommission },
  { header: 'Waluta', value: (t) => t.currency },
  { header: 'Zysk/strata', value: (t) => t.profitLoss },
  { header: 'Zysk/strata %', value: (t) => t.profitLossPct },
  { header: 'Dni w pozycji', value: (t) => t.holdingDays },
  { header: 'Kategoria', value: (t) => t.category ?? 'stock' },
];
