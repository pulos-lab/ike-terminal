import { describe, it, expect } from 'vitest';
import { BROKER_LABELS, type BrokerType } from 'shared';
import {
  BROKER_TILES,
  BROKER_IMPORT_CONFIG,
  isKnownBroker,
  type KnownBroker,
} from '../broker-import-config';

/**
 * Strażnik spójności listy brokerów między serwerem a UI.
 *
 * Geneza: Trading 212 dostał parser, rejestr i typ `BrokerType`, ale nie dostał
 * kafelka ani wpisu w `isKnownBroker`. Skutek nie był kosmetyczny — plik nie dawał
 * się zaimportować ŻADNĄ drogą: kreator „Inny broker" wykrywał znanego brokera,
 * odmawiał obsługi i odsyłał „wybierz właściwego brokera w oknie importu", a tam
 * takiego kafelka nie było. Użytkownik chodził w kółko przy sprawnym backendzie.
 *
 * `BROKER_LABELS` w shared jest jedynym miejscem, które musi znać każdego brokera
 * (typ `BrokerType` wymusza kompletność), więc to z niego wyprowadzamy oczekiwania.
 */

/** Brokerzy z parserem wbudowanym — bez pseudo-wartości `auto` i `generic`. */
const BUILT_IN_BROKERS = (Object.keys(BROKER_LABELS) as BrokerType[]).filter(
  (b) => b !== 'auto' && b !== 'generic',
);

describe('spójność listy brokerów w imporcie', () => {
  it('każdy broker z BrokerType ma kafelek w oknie importu', () => {
    const tiles = new Set(BROKER_TILES.map((t) => t.id));
    const missing = BUILT_IN_BROKERS.filter((b) => !tiles.has(b));
    expect(missing).toEqual([]);
  });

  it('każdy broker z BrokerType ma instrukcję eksportu i definicję plików', () => {
    const missing = BUILT_IN_BROKERS.filter((b) => !(b in BROKER_IMPORT_CONFIG));
    expect(missing).toEqual([]);
  });

  it('isKnownBroker rozpoznaje każdego brokera z konfiguracji', () => {
    // Bez tego kreator generyczny odsyła użytkownika po kafelek i blokuje import.
    const unrecognised = BUILT_IN_BROKERS.filter((b) => !isKnownBroker(b));
    expect(unrecognised).toEqual([]);
  });

  it('isKnownBroker odrzuca wartości spoza konfiguracji', () => {
    expect(isKnownBroker('generic')).toBe(false);
    expect(isKnownBroker('auto')).toBe(false);
    expect(isKnownBroker(null)).toBe(false);
  });

  it('Trading 212 jest w komplecie (regresja)', () => {
    expect(isKnownBroker('trading212')).toBe(true);
    expect(BROKER_TILES.some((t) => t.id === 'trading212')).toBe(true);
    const cfg = BROKER_IMPORT_CONFIG['trading212' as KnownBroker];
    expect(cfg.files).toHaveLength(1); // jeden plik CSV niesie wszystko
    expect(cfg.files[0].accept).toBe('.csv');
    expect(cfg.files[0].role).toBe('transactions');
  });

  it('każdy kafelek poza „generic" ma konfigurację (brak martwych kafelków)', () => {
    const dead = BROKER_TILES.filter((t) => t.id !== 'generic' && !(t.id in BROKER_IMPORT_CONFIG));
    expect(dead).toEqual([]);
  });
});
