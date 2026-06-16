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

/** Odwzorowanie pętli klasyfikacji operacji z classifyFile */
function detectOperationsBroker(content: string): string | null {
  return PARSER_REGISTRY.find((p) => p.detectOperations?.(content))?.id ?? null;
}

describe('PARSER_REGISTRY — detectOperations', () => {
  it('każdy broker CSV wykrywa swój plik operacji przez registry', () => {
    expect(detectOperationsBroker(DEGIRO_OPS)).toBe('degiro');
    expect(detectOperationsBroker(MBANK_OPS)).toBe('mbank');
    expect(detectOperationsBroker(BOSSA_OPS)).toBe('bossa');
  });

  it('pliki transakcji NIE łapią się na detectOperations', () => {
    expect(detectOperationsBroker(BOSSA_TX)).toBeNull();
    expect(detectOperationsBroker(MBANK_TX)).toBeNull();
    expect(detectOperationsBroker(DEGIRO_TX)).toBeNull();
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
  });

  it('priorytet rejestru rozstrzyga rolę operacji (pierwszy = właściwy)', () => {
    // mBank ma najluźniejszy detektor operacji (Data+Kwota bez Papier/Walor) i bywa
    // współ-trafieniem; kolejność rejestru (degiro→mbank→bossa) wybiera właściwy broker.
    expect(detectAllMatches(DEGIRO_OPS).operations[0]).toBe('degiro');
    expect(detectAllMatches(MBANK_OPS).operations[0]).toBe('mbank');
    expect(detectAllMatches(BOSSA_OPS).operations[0]).toBe('bossa');
  });
});
