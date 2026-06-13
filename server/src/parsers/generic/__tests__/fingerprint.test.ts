import { describe, it, expect } from 'vitest';
import {
  computeFingerprint,
  jaccardSimilarity,
  locateHeaderCandidate,
  normalizeHeaderForFingerprint,
} from '../fingerprint.js';

describe('normalizeHeaderForFingerprint', () => {
  it('usuwa diakrytyki, BOM i normalizuje białe znaki', () => {
    expect(normalizeHeaderForFingerprint('  Tytuł   Operacji ')).toBe('tytul operacji');
    expect(normalizeHeaderForFingerprint('ilość')).toBe('ilosc');
    expect(normalizeHeaderForFingerprint('﻿data')).toBe('data');
  });
});

describe('computeFingerprint', () => {
  it('stabilny dla tych samych nagłówków, różny dla innych', () => {
    const a = computeFingerprint(['data', 'papier', 'isin'], ';');
    const b = computeFingerprint(['Data', ' Papier', 'ISIN'], ';');
    const c = computeFingerprint(['data', 'papier', 'isin', 'kwota'], ';');
    const d = computeFingerprint(['data', 'papier', 'isin'], ',');
    expect(a).toBe(b); // normalizacja: case/trim bez znaczenia
    expect(a).not.toBe(c); // dodatkowa kolumna = inny format
    expect(a).not.toBe(d); // inny delimiter = inny format
  });

  it('kolejność kolumn ma znaczenie (mapowanie po indeksach)', () => {
    const a = computeFingerprint(['data', 'papier'], ';');
    const b = computeFingerprint(['papier', 'data'], ';');
    expect(a).not.toBe(b);
  });

  it('WSTECZNA ZGODNOŚĆ: hash CSV jest niezmienny (biblioteka prod bez migracji)', () => {
    // Zahardkodowany — jakakolwiek zmiana algorytmu CSV unieważniłaby profile
    // zapisane na produkcji. Ten test ma się zepsuć, gdyby to się stało.
    expect(computeFingerprint(['data', 'papier', 'isin'], ';')).toBe(
      '050d08f8499ff3124bcba6be58df8b499839da44a45faefc31109eab33f513cb',
    );
  });

  it('XLSX: marker arkusza zamiast delimitera; różne arkusze = różne profile', () => {
    const csv = computeFingerprint(['data', 'papier', 'isin'], ';');
    const sheetA = computeFingerprint(['data', 'papier', 'isin'], ';', 'Cash Operations');
    const sheetB = computeFingerprint(['data', 'papier', 'isin'], ';', 'Closed Positions');
    expect(sheetA).not.toBe(csv); // XLSX ≠ CSV mimo tych samych nagłówków
    expect(sheetA).not.toBe(sheetB); // różne arkusze tego samego skoroszytu
  });

  it('XLSX: nazwa arkusza znormalizowana (case-insensitive)', () => {
    expect(computeFingerprint(['data'], ';', 'Cash Operations')).toBe(
      computeFingerprint(['data'], ';', 'CASH OPERATIONS'),
    );
  });
});

describe('locateHeaderCandidate', () => {
  it('znajduje nagłówek w pierwszym wierszu (Bossa)', () => {
    const csv = [
      'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta',
      '25.02.2026 09:47:27;MINERAL-NC;PLMNRLM00010;868;S;0,88;763,84;0,00;763,84;PLN',
    ].join('\n');
    const candidate = locateHeaderCandidate(csv);

    expect(candidate).not.toBeNull();
    expect(candidate!.delimiter).toBe(';');
    expect(candidate!.headerRowIndex).toBe(0);
    expect(candidate!.headers).toContain('isin');
    expect(candidate!.sampleRows).toHaveLength(1);
  });

  it('znajduje nagłówek po preludium metadanych (mBank)', () => {
    const csv = [
      'mBank eMakler',
      'Rachunek: 00 1111 2222 3333',
      'Okres: 2025-01-01 - 2025-12-31',
      '',
      'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta',
      '02.01.2025 10:30:00;KGHM;WWA-GPW;K;10;150,50;PLN;5,85;PLN;1505,00;PLN',
      '05.02.2025 11:00:00;PKN;WWA-GPW;S;20;65,00;PLN;5,00;PLN;1300,00;PLN',
    ].join('\n');
    const candidate = locateHeaderCandidate(csv);

    expect(candidate).not.toBeNull();
    expect(candidate!.delimiter).toBe(';');
    expect(candidate!.headers[0]).toBe('Czas transakcji');
  });

  it('wykrywa delimiter przecinkowy (DEGIRO)', () => {
    const csv = [
      'Data,Czas,Produkt,ISIN,Giełda referencyjna,Miejsce wykonania,Liczba,Kurs,,Wartość lokalna,,Wartość EUR,Kurs wymiany,Opłaty AutoFX,Opłata transakcyjna,Razem EUR,Identyfikator zlecenia,',
      '27-03-2024,11:41,ML SYSTEM SA,PLMLSTM00015,WSE,XWAR,-70,"43,7000",PLN,"3059,00",PLN,"709,30","4,3127","0,00",,"709,30",,94fb340e',
    ].join('\n');
    const candidate = locateHeaderCandidate(csv);

    expect(candidate).not.toBeNull();
    expect(candidate!.delimiter).toBe(',');
    expect(candidate!.headers).toContain('Produkt');
  });

  it('zwraca null dla treści bez sensownego nagłówka', () => {
    expect(locateHeaderCandidate('tylko jedna wartość')).toBeNull();
  });
});

describe('jaccardSimilarity', () => {
  it('1.0 dla identycznych zbiorów, wysokie dla formatu z dodaną kolumną', () => {
    const base = ['data', 'papier', 'isin', 'ilość', 'cena'];
    expect(jaccardSimilarity(base, base)).toBe(1);
    const extended = [...base, 'prowizja'];
    expect(jaccardSimilarity(base, extended)).toBeCloseTo(5 / 6);
    expect(jaccardSimilarity(base, ['zupełnie', 'inne'])).toBe(0);
  });
});
