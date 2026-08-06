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

  it('odrzuca obligacje i całkowity brak przesłanek', () => {
    expect(resolveEarningsMarket('CATALYST')).toBeNull();
    expect(
      resolveEarningsMarket({ exchange: 'CATALYST', currency: 'PLN', ticker: 'BST0728' }),
    ).toBeNull();
    expect(resolveEarningsMarket(undefined)).toBeNull();
    expect(resolveEarningsMarket({ exchange: 'OTHER' })).toBeNull();
  });

  it('REGRESJA: akcja z nierozpoznaną giełdą trafia na rynek po kraju i walucie', () => {
    // Figma w „Moje IKE": resolver ISIN-ów nie sklasyfikował świeżego debiutu
    // i zostawił pseudo-ISIN AUTO_FIG z exchange='OTHER'. Wcześniej taka pozycja
    // wypadała z kalendarza wyników razem z opcjami i NIGDY nie dostawała ikony.
    expect(
      resolveEarningsMarket({
        exchange: 'OTHER',
        country: 'United States',
        currency: 'USD',
        ticker: 'FIG',
      }),
    ).toBe('US');
    // To samo dotyczyło AAPL w tym samym portfelu.
    expect(
      resolveEarningsMarket({
        exchange: 'OTHER',
        country: 'United States',
        currency: 'USD',
        ticker: 'AAPL',
      }),
    ).toBe('US');
  });

  it('sama waluta USD wystarcza, gdy kraju brak (ADR-y i luki w backfillu)', () => {
    expect(resolveEarningsMarket({ exchange: 'OTHER', currency: 'USD', ticker: 'PLTR' })).toBe(
      'US',
    );
  });

  it('ticker z sufiksem giełdowym idzie torem zagranicznym, nie do Nasdaqa', () => {
    // Kalendarz Nasdaq jest kluczowany czystymi symbolami, więc „NOVO-B.CO" i tak
    // by nie trafił; kierowanie go do Yahoo jest jedyną sensowną opcją.
    for (const ticker of ['NOVO-B.CO', '2696.HK', 'ASML.AS', 'SPCE.MX']) {
      expect(resolveEarningsMarket({ exchange: 'OTHER', ticker }), ticker).toBe('FOREIGN');
    }
  });

  it('polski papier rozpoznaje po sufiksie notowania albo po kraju', () => {
    expect(resolveEarningsMarket({ exchange: 'OTHER', ticker: 'CDR.WA' })).toBe('PL');
    expect(resolveEarningsMarket({ exchange: 'OTHER', country: 'Poland', ticker: 'XYZ' })).toBe(
      'PL',
    );
  });

  it('giełda ma pierwszeństwo przed podpowiedziami', () => {
    expect(
      resolveEarningsMarket({
        exchange: 'GPW',
        country: 'United States',
        currency: 'USD',
        ticker: 'CDR.WA',
      }),
    ).toBe('PL');
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
