import { describe, it, expect } from 'vitest';
import {
  resolveEarningsMarket,
  resolvePlSlug,
  resolveEarningsSymbol,
} from '../earnings/symbol-resolver.js';
import { normalizePolishCompanyName, compactPolishCompanyName } from 'shared';

describe('resolveEarningsMarket', () => {
  it('mapuje giełdy na rynki terminarza', () => {
    expect(resolveEarningsMarket('GPW')).toBe('PL');
    expect(resolveEarningsMarket('NC')).toBe('PL');
    expect(resolveEarningsMarket('NYSE')).toBe('US');
    expect(resolveEarningsMarket('NASDAQ')).toBe('US');
    expect(resolveEarningsMarket('XETRA')).toBe('FOREIGN');
  });

  it('odrzuca giełdy bez raportów okresowych i brak giełdy', () => {
    expect(resolveEarningsMarket('CATALYST')).toBeNull();
    expect(resolveEarningsMarket('OTHER')).toBeNull();
    expect(resolveEarningsMarket(undefined)).toBeNull();
  });
});

describe('normalizacja nazw', () => {
  it('składa diakrytyki i ścina formy prawne', () => {
    expect(normalizePolishCompanyName('Grupa Kęty S.A.')).toBe('grupa kety');
    expect(normalizePolishCompanyName('CD PROJEKT S.A.')).toBe('cd projekt');
    expect(normalizePolishCompanyName('Żywiec Spółka Akcyjna')).toBe('zywiec');
  });

  it('zbija nazwę do postaci sluga', () => {
    expect(compactPolishCompanyName('Orange Polska')).toBe('orangepolska');
    expect(compactPolishCompanyName('Woodpecker.co')).toBe('woodpeckerco');
  });
});

describe('resolvePlSlug', () => {
  it('rozwiązuje NewConnect przez statyczną mapę tickerów', () => {
    expect(resolvePlSlug('MND.WA', null)).toEqual({
      symbolKey: 'MINERAL',
      resolvedBy: 'nc-map',
      confidence: 1,
    });
  });

  it('rozpoznaje ticker będący slugiem', () => {
    expect(resolvePlSlug('PZU.WA', 'PZU')).toMatchObject({
      symbolKey: 'PZU',
      resolvedBy: 'ticker-is-slug',
    });
  });

  it('rozpoznaje brokerską nazwę będącą slugiem', () => {
    expect(resolvePlSlug('OML.WA', 'ONEMORE')).toMatchObject({
      symbolKey: 'ONEMORE',
      resolvedBy: 'name-is-slug',
    });
    expect(resolvePlSlug('WPR.WA', 'WOODPCKR')).toMatchObject({
      symbolKey: 'WOODPCKR',
      resolvedBy: 'name-is-slug',
    });
  });

  it('mapuje po pełnej nazwie spółki (tu: zbita nazwa jest slugiem)', () => {
    expect(resolvePlSlug('CDR.WA', 'CD Projekt S.A.')).toMatchObject({
      symbolKey: 'CDPROJEKT',
      resolvedBy: 'name-is-slug',
    });
  });

  it('REGRESJA: nazwa bez ogonków trafia w nazwę z ogonkami', () => {
    // Brokerzy zapisują „Grupa Kety"; mapa sektorów ma „Grupa Kęty".
    // Bez składania diakrytyków ten przypadek przepadał.
    expect(resolvePlSlug('KTY.WA', 'Grupa Kety')).toMatchObject({
      symbolKey: 'KETY',
      resolvedBy: 'name-index',
    });
  });

  it('używa mostu przez kalendarz dywidend, gdy statyczne mapy nie znają spółki', () => {
    const result = resolvePlSlug('ZZZ.WA', 'Spółka Nieznana Mapom', {
      dividendBridge: (base) => (base === 'ZZZ' ? 'ZZZTEST' : null),
    });
    expect(result).toEqual({
      symbolKey: 'ZZZTEST',
      resolvedBy: 'dividend-bridge',
      confidence: 0.9,
    });
  });

  it('zwraca null dla spółki nieznanej wszystkim źródłom', () => {
    expect(resolvePlSlug('QQQ.WA', 'Zupełnie Nieznany Byt')).toBeNull();
  });
});

describe('resolveEarningsSymbol', () => {
  it('dla US i zagranicy bierze ticker wprost', () => {
    expect(resolveEarningsSymbol('US', 'AAPL', 'Apple Inc.')).toMatchObject({
      symbolKey: 'AAPL',
    });
    expect(resolveEarningsSymbol('FOREIGN', 'ads.de', null)).toMatchObject({
      symbolKey: 'ADS.DE',
    });
  });

  it('dla PL idzie przez łańcuch slugów', () => {
    expect(resolveEarningsSymbol('PL', 'CDR.WA', 'CD Projekt')).toMatchObject({
      symbolKey: 'CDPROJEKT',
    });
  });
});
