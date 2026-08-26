import { describe, it, expect } from 'vitest';
import { PARSER_REGISTRY, detectBroker, detectAllMatches } from '../registry.js';

/**
 * Testy registry parserów — detekcja transakcji vs operacji.
 *
 * classifyFile (import-service) klasyfikuje plik czystą pętlą po PARSER_REGISTRY:
 * najpierw detectOperations (degiro → mbank → bossa), potem detect (transakcje).
 * Te testy pilnują, że precedence i pokrycie hooków się nie rozjeżdżają
 * (w szczególności: Bossa operations MUSI być wykrywana przez registry,
 * bez special-case'a w import-service).
 */

const BOSSA_TX = 'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta\n';
const BOSSA_OPS = 'data;tytuł operacji;szczegóły;kwota;waluta\n';
const MBANK_TX =
  'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta\n';
const MBANK_OPS = 'Data,Opis,Kwota\n';
const DEGIRO_TX =
  'Data,Czas,Produkt,ISIN,Giełda referencyjna,Miejsce wykonania,Liczba,Kurs,,' +
  'Wartość lokalna,,Wartość EUR,Kurs wymiany,Opłaty AutoFX,' +
  'Opłata transakcyjna DEGIRO i/lub opłata stron,Razem EUR,Identyfikator zlecenia\n';
const DEGIRO_OPS = 'Data,Czas,Data,Produkt,ISIN,Opis,Kurs,Zmiana,,Saldo,,Identyfikator zlecenia\n';
// ING nie ma nagłówków — fixtures to wiersze DANYCH (detekcja po kształcie treści).
const ING_TX =
  '29-08-2023 14:25:33;843790613;ETFSP500;Kupno;35;190,20;6 657,00;24.63;6 681,63\n' +
  '25-09-2023 09:05:00;847466225;ETFSP500;Sprzedaż;75;194,50;14 587,50;53.97;14 533,53\n';
const ING_OPS =
  '1;24-08-2026;;Saldo końcowe;;0.00;PLN\n' +
  '2;27-11-2024;Wpłaty/wypłaty;WPL/3977466/Zasilenie rachunku;58000.00;82052.22;PLN\n';

/** Odwzorowanie pętli klasyfikacji operacji z classifyFile */
function detectOperationsBroker(content: string): string | null {
  return PARSER_REGISTRY.find((p) => p.detectOperations?.(content))?.id ?? null;
}

describe('PARSER_REGISTRY — detectOperations', () => {
  it('każdy broker CSV wykrywa swój plik operacji przez registry', () => {
    expect(detectOperationsBroker(DEGIRO_OPS)).toBe('degiro');
    expect(detectOperationsBroker(MBANK_OPS)).toBe('mbank');
    expect(detectOperationsBroker(BOSSA_OPS)).toBe('bossa');
    expect(detectOperationsBroker(ING_OPS)).toBe('ing');
  });

  it('pliki transakcji NIE łapią się na detectOperations', () => {
    expect(detectOperationsBroker(BOSSA_TX)).toBeNull();
    expect(detectOperationsBroker(MBANK_TX)).toBeNull();
    expect(detectOperationsBroker(DEGIRO_TX)).toBeNull();
    expect(detectOperationsBroker(ING_TX)).toBeNull();
  });

  it('Bossa ma zarejestrowane oba hooki operacji (detect + parse)', () => {
    const bossa = PARSER_REGISTRY.find((p) => p.id === 'bossa');
    expect(bossa?.detectOperations).toBeDefined();
    expect(bossa?.parseOperations).toBeDefined();
  });
});

describe('detectBroker — detekcja transakcji', () => {
  it('rozpoznaje formaty wszystkich brokerów CSV', () => {
    expect(detectBroker(BOSSA_TX)?.id).toBe('bossa');
    expect(detectBroker(MBANK_TX)?.id).toBe('mbank');
    expect(detectBroker(DEGIRO_TX)?.id).toBe('degiro');
    expect(detectBroker(ING_TX)?.id).toBe('ing');
  });

  it('zwraca null dla nierozpoznanej zawartości', () => {
    expect(detectBroker('foo;bar;baz\n1;2;3\n')).toBeNull();
  });
});

describe('detekcja odporna na diakrytyki (P3)', () => {
  it('Bossa operacje bez polskich znaków: "Tytul operacji" → bossa', () => {
    const bossaOpsAscii = 'data;tytul operacji;szczegoly;kwota;waluta\n';
    expect(detectOperationsBroker(bossaOpsAscii)).toBe('bossa');
  });

  it('DEGIRO transakcje bez polskich znaków: "Oplaty AutoFX" (bez ł) → degiro', () => {
    const degiroTxAscii =
      'Data,Czas,Produkt,ISIN,Liczba,Kurs,Wartosc,Oplaty AutoFX,Razem,Identyfikator zlecenia\n';
    expect(detectBroker(degiroTxAscii)?.id).toBe('degiro');
  });
});

describe('guard niejednoznaczności (P3) — detectAllMatches', () => {
  it('pliki transakcji: dokładnie jeden broker (brak nakładania ról)', () => {
    expect(detectAllMatches(BOSSA_TX).transactions).toEqual(['bossa']);
    expect(detectAllMatches(MBANK_TX).transactions).toEqual(['mbank']);
    expect(detectAllMatches(DEGIRO_TX).transactions).toEqual(['degiro']);
    expect(detectAllMatches(ING_TX).transactions).toEqual(['ing']);
  });

  it('priorytet rejestru rozstrzyga rolę operacji (pierwszy = właściwy)', () => {
    // mBank ma najluźniejszy detektor operacji (Data+Kwota bez Papier/Walor) i bywa
    // współ-trafieniem; kolejność rejestru (degiro→mbank→bossa) wybiera właściwy broker.
    expect(detectAllMatches(DEGIRO_OPS).operations[0]).toBe('degiro');
    expect(detectAllMatches(MBANK_OPS).operations[0]).toBe('mbank');
    expect(detectAllMatches(BOSSA_OPS).operations[0]).toBe('bossa');
  });

  it('bezgłówkowe pliki ING trafiają w dokładnie jednego brokera per rola', () => {
    // Detektory treściowe ING są ostatnie w rejestrze — nie mogą współ-trafiać
    // z nagłówkowymi i odwrotnie (fixtures innych brokerów nie pasują do ING).
    expect(detectAllMatches(ING_OPS).operations).toEqual(['ing']);
    for (const fixture of [BOSSA_TX, MBANK_TX, DEGIRO_TX, BOSSA_OPS, MBANK_OPS, DEGIRO_OPS]) {
      expect(detectAllMatches(fixture).transactions).not.toContain('ing');
      expect(detectAllMatches(fixture).operations).not.toContain('ing');
    }
  });
});
