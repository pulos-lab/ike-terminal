import { describe, it, expect } from 'vitest';
import { CFD_TICKER_MAP } from 'shared';
import { inferExchange } from '../isin-resolver.js';
import { offlineExchangeGuess, shouldSkipTicker } from '../../scripts/backfill-ticker-exchange.js';

describe('inferExchange', () => {
  it('rozpoznaje giełdę po sufiksie tickera', () => {
    expect(inferExchange('CDR.WA')).toBe('GPW');
    expect(inferExchange('SAP.DE')).toBe('XETRA');
    expect(inferExchange('CSU.TO')).toBe('TSX');
  });

  it('rozpoznaje giełdę po kodzie Yahoo', () => {
    expect(inferExchange('AAPL', 'NMS')).toBe('NASDAQ');
    expect(inferExchange('FIG', 'NYQ')).toBe('NYSE');
    expect(inferExchange('ALV', 'GER')).toBe('XETRA');
  });

  it('bez przesłanek zwraca OTHER — i to jest stan REALNY, nie błąd', () => {
    // Konsumenci nie mogą traktować listy giełd jak zamkniętej: ręcznie dodany
    // ticker siedzi w 'OTHER' dopóki ktoś nie pozna jego giełdy.
    expect(inferExchange('AAPL')).toBe('OTHER');
    expect(inferExchange('XYZ', 'NIEZNANY')).toBe('OTHER');
  });
});

describe('backfill giełdy — guard instrumentów syntetycznych', () => {
  it('REGRESJA: CFD nie może dostać giełdy akcji', () => {
    // Wyszukiwarka Yahoo na „GOLD" zwraca Barrick Gold (NYSE), a na „OIL"
    // Marathon Oil — wykryte na realnych danych podczas dry-runu backfillu.
    expect(shouldSkipTicker('GOLD')).toBe(true);
    expect(shouldSkipTicker('OIL')).toBe(true);
    expect(shouldSkipTicker('gold')).toBe(true);
    // Kontrola: prawdziwa akcja nie jest pomijana.
    expect(shouldSkipTicker('AAPL')).toBe(false);
    expect(shouldSkipTicker('FIG')).toBe(false);
  });

  it('guard opiera się na tej samej mapie co backfill nazw', () => {
    expect(Object.keys(CFD_TICKER_MAP).length).toBeGreaterThan(0);
  });
});

describe('offlineExchangeGuess', () => {
  const row = (over: Partial<Parameters<typeof offlineExchangeGuess>[0]> = {}) => ({
    isin: 'AUTO_X',
    ticker: 'X',
    name: 'X',
    currency: 'USD',
    country: null,
    ...over,
  });

  it('sufiks notowania wystarcza bez sieci', () => {
    expect(offlineExchangeGuess(row({ ticker: 'CDR.WA' }))).toBe('GPW');
    expect(offlineExchangeGuess(row({ ticker: 'SAP.DE' }))).toBe('XETRA');
  });

  it('polski kraj siedziby kieruje na GPW', () => {
    expect(offlineExchangeGuess(row({ ticker: 'ABC', country: 'Poland' }))).toBe('GPW');
  });

  it('nie zgaduje NYSE vs NASDAQ z samej waluty', () => {
    // Bez kodu z Yahoo nie ma jak ich rozróżnić — wolimy zostawić OTHER
    // niż wpisać do bazy zmyśloną giełdę.
    expect(offlineExchangeGuess(row({ ticker: 'AAPL', currency: 'USD' }))).toBeNull();
  });

  it('nie dotyka instrumentów syntetycznych', () => {
    expect(offlineExchangeGuess(row({ ticker: 'EURPLN=X', currency: 'PLN' }))).toBeNull();
    expect(offlineExchangeGuess(row({ ticker: 'CL=F' }))).toBeNull();
    expect(offlineExchangeGuess(row({ ticker: 'BTC-USD' }))).toBeNull();
  });

  it('nieznany sufiks zostaje nietknięty', () => {
    expect(offlineExchangeGuess(row({ ticker: 'ASML.AS' }))).toBeNull();
  });
});
