import { describe, it, expect, beforeEach } from 'vitest';
import {
  getHistoryTailStatus,
  lastExpectedCloseDate,
  noteHistoryTailChecked,
  resetHistoryTailChecks,
} from '../history-tail-freshness.js';

// Tydzień odniesienia: pon 2026-11-16 … pt 2026-11-20, weekend 21–22, pon 23.
const at = (iso: string) => new Date(iso);

beforeEach(() => resetHistoryTailChecks());

describe('lastExpectedCloseDate', () => {
  it('w dzień roboczy = poprzedni dzień roboczy', () => {
    expect(lastExpectedCloseDate('2026-11-18')).toBe('2026-11-17'); // śr → wt
    expect(lastExpectedCloseDate('2026-11-20')).toBe('2026-11-19'); // pt → czw
  });

  it('w sobotę, niedzielę i poniedziałek = piątek', () => {
    expect(lastExpectedCloseDate('2026-11-21')).toBe('2026-11-20');
    expect(lastExpectedCloseDate('2026-11-22')).toBe('2026-11-20');
    expect(lastExpectedCloseDate('2026-11-23')).toBe('2026-11-20');
  });

  it('przechodzi przez granicę miesiąca i roku', () => {
    expect(lastExpectedCloseDate('2026-06-01')).toBe('2026-05-29'); // pon → pt
    expect(lastExpectedCloseDate('2027-01-01')).toBe('2026-12-31'); // pt → czw
  });
});

describe('getHistoryTailStatus — część datowa', () => {
  it('REGRESJA: cache do poniedziałku jest w środę NIEAKTUALNY (stary próg ≤3 dni mówił „świeży")', () => {
    const status = getHistoryTailStatus('yahoo:CDR.WA', '2026-11-16', at('2026-11-18T10:00:00Z'));
    expect(status.fresh).toBe(false);
  });

  it('cache do wczorajszej sesji jest aktualny', () => {
    const status = getHistoryTailStatus('yahoo:CDR.WA', '2026-11-17', at('2026-11-18T10:00:00Z'));
    expect(status).toEqual({ fresh: true, cacheTtlSeconds: 12 * 3600 });
  });

  it('cache do piątku jest aktualny przez cały weekend i w poniedziałek', () => {
    for (const now of ['2026-11-21T09:00:00Z', '2026-11-22T23:59:00Z', '2026-11-23T15:00:00Z']) {
      expect(getHistoryTailStatus('yahoo:CDR.WA', '2026-11-20', at(now)).fresh).toBe(true);
    }
    // …a we wtorek brakuje już poniedziałkowego zamknięcia.
    expect(
      getHistoryTailStatus('yahoo:CDR.WA', '2026-11-20', at('2026-11-24T00:30:00Z')).fresh,
    ).toBe(false);
  });

  it('cache sięgający dziś (punkt live benchmarku) jest aktualny', () => {
    expect(getHistoryTailStatus('stooq:wig', '2026-11-18', at('2026-11-18T10:00:00Z')).fresh).toBe(
      true,
    );
  });

  it('pusty cache nigdy nie jest aktualny', () => {
    noteHistoryTailChecked('yahoo:NEW', at('2026-11-18T10:00:00Z'));
    expect(getHistoryTailStatus('yahoo:NEW', null, at('2026-11-18T10:01:00Z')).fresh).toBe(false);
  });
});

describe('getHistoryTailStatus — pamięć sprawdzenia', () => {
  // Święto: w czwartek 12.11 oczekujemy zamknięcia ze środy 11.11, którego nie ma.
  const KEY = 'yahoo:PKN.WA';
  const LAST = '2026-11-10';

  it('po sprawdzeniu bez nowych danych ogon jest „aktualny" do końca okna', () => {
    noteHistoryTailChecked(KEY, at('2026-11-12T08:00:00Z'));

    const soon = getHistoryTailStatus(KEY, LAST, at('2026-11-12T09:00:00Z'));
    expect(soon.fresh).toBe(true);
    // TTL wpisu pamięciowego kończy się razem z oknem (5 h), nie po 12 h.
    expect(soon.cacheTtlSeconds).toBe(5 * 3600);

    const after = getHistoryTailStatus(KEY, LAST, at('2026-11-12T14:00:01Z'));
    expect(after.fresh).toBe(false);
  });

  it('TTL tuż przed końcem okna ma podłogę 60 s', () => {
    noteHistoryTailChecked(KEY, at('2026-11-12T08:00:00Z'));
    const status = getHistoryTailStatus(KEY, LAST, at('2026-11-12T13:59:59Z'));
    expect(status).toEqual({ fresh: true, cacheTtlSeconds: 60 });
  });

  it('sprawdzenie jednego tickera nie wycisza innego', () => {
    noteHistoryTailChecked(KEY, at('2026-11-12T08:00:00Z'));
    expect(getHistoryTailStatus('yahoo:CDR.WA', LAST, at('2026-11-12T08:05:00Z')).fresh).toBe(
      false,
    );
    // …ani tego samego tickera w innym źródle.
    expect(getHistoryTailStatus('stooq:pkn', LAST, at('2026-11-12T08:05:00Z')).fresh).toBe(false);
  });
});
