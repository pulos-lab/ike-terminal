import { parseOccTicker } from 'shared';

/**
 * Etykieta tickera do tabel: zwykłe tickery bez zmian, kontrakty opcyjne w dwóch
 * zwartych liniach ("OKLO 15 PUT" + drobne "wygasa 17.12.2027"). Jednoliniowa pełna
 * forma (displayOptionTicker) rozpychała kolumnę Ticker i wypychała kolumnę akcji
 * ("Sprzedaj") poza viewport.
 */
export function TickerLabel({ ticker, className }: { ticker: string; className?: string }) {
  const parsed = parseOccTicker(ticker);
  if (!parsed) return <span className={className}>{ticker}</span>;
  const [y, m, d] = parsed.expiry.split('-');
  return (
    <span className={`inline-flex flex-col leading-tight ${className ?? ''}`}>
      <span className="whitespace-nowrap">
        {parsed.underlying} {parsed.strike} {parsed.optionType === 'C' ? 'CALL' : 'PUT'}
      </span>
      <span className="text-[10px] font-normal text-muted-foreground whitespace-nowrap">
        wygasa {d}.{m}.{y}
      </span>
    </span>
  );
}
