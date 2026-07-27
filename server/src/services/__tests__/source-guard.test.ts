import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSourceGuard,
  createMemoryGuardStore,
  type GuardStateStore,
  type SourceGuardAlert,
} from '../source-guard.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Sterowany zegar + świeży guard z memory store i szpiegiem notify. */
function makeGuard(overrides: Partial<Parameters<typeof createSourceGuard>[0]> = {}) {
  const clock = { now: Date.parse('2026-07-27T10:00:00Z') };
  const notify = vi.fn<(alert: SourceGuardAlert) => void>();
  const store = overrides.store ?? createMemoryGuardStore();
  const guard = createSourceGuard({
    name: 'test-source',
    store,
    notify,
    now: () => clock.now,
    ...overrides,
  });
  return { guard, clock, notify, store };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('circuit breaker', () => {
  it('otwiera się po 3 blokadach pod rząd, zamyka po backoffie', () => {
    const { guard, clock } = makeGuard();
    guard.registerBlock();
    guard.registerBlock();
    expect(guard.isBlocked()).toBe(false);
    guard.registerBlock();
    expect(guard.isBlocked()).toBe(true);
    expect(guard.getState().blocked).toBe(true);

    clock.now += 30 * MIN + 1;
    expect(guard.isBlocked()).toBe(false); // backoff minął
  });

  it('sukces zeruje licznik blokad', () => {
    const { guard } = makeGuard();
    guard.registerBlock();
    guard.registerBlock();
    guard.registerSuccess();
    guard.registerBlock();
    guard.registerBlock();
    expect(guard.isBlocked()).toBe(false); // licznik od zera po sukcesie
    expect(guard.getState().consecutiveBlocks).toBe(2);
  });

  it('notify(blocked) dokładnie raz na przejście; kolejny epizod <24h bez maila, >24h z mailem', () => {
    const { guard, clock, notify } = makeGuard();
    for (let i = 0; i < 3; i++) guard.registerBlock();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      source: 'test-source',
      kind: 'blocked',
      consecutiveBlocks: 3,
    });

    // dalsze blokady w otwartym oknie — bez ponownego maila
    guard.registerBlock();
    expect(notify).toHaveBeenCalledTimes(1);

    // drugi epizod po backoffie, ale <24h od maila → dedup
    clock.now += HOUR;
    for (let i = 0; i < 3; i++) guard.registerBlock();
    expect(guard.isBlocked()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    // trzeci epizod >24h od pierwszego maila → mail
    clock.now += 25 * HOUR;
    for (let i = 0; i < 3; i++) guard.registerBlock();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('dedup powiadomień przeżywa restart (nowy guard na tym samym store)', () => {
    const store = createMemoryGuardStore();
    const first = makeGuard({ store });
    for (let i = 0; i < 3; i++) first.guard.registerBlock();
    expect(first.notify).toHaveBeenCalledTimes(1);

    // „Restart": świeża instancja, ten sam store, chwilę później
    const second = makeGuard({ store });
    second.clock.now = first.clock.now + HOUR;
    for (let i = 0; i < 3; i++) second.guard.registerBlock();
    expect(second.guard.isBlocked()).toBe(true);
    expect(second.notify).not.toHaveBeenCalled(); // dedup z persystencji
  });
});

describe('parse-miss / suspectedMarkupChange', () => {
  it('3 różne klucze bez świeżego sukcesu → alarm + notify(markup-change) raz', () => {
    const { guard, notify } = makeGuard();
    guard.registerParseMiss('live:AAA');
    guard.registerParseMiss('live:BBB');
    expect(guard.getState().suspectedMarkupChange).toBe(false);
    guard.registerParseMiss('live:CCC');
    expect(guard.getState().suspectedMarkupChange).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'markup-change' });
    expect(notify.mock.calls[0][0].missKeys).toEqual(['live:AAA', 'live:BBB', 'live:CCC']);

    // kolejne missy w tym samym epizodzie — bez ponownego maila
    guard.registerParseMiss('live:DDD');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('powtórki tego samego klucza NIE alarmują (delisted ticker)', () => {
    const { guard, clock } = makeGuard();
    for (let i = 0; i < 10; i++) {
      guard.registerParseMiss('live:DEAD');
      clock.now += MIN;
    }
    expect(guard.getState().suspectedMarkupChange).toBe(false);
  });

  it('świeży sukces (grace) tłumi regułę distinct', () => {
    const { guard, clock } = makeGuard();
    guard.registerSuccess('live:OK'); // parser żyje
    clock.now += 5 * MIN; // < successGraceMs (15 min)
    guard.registerParseMiss('live:AAA');
    guard.registerParseMiss('live:BBB');
    guard.registerParseMiss('live:CCC');
    expect(guard.getState().suspectedMarkupChange).toBe(false);

    // sukces się starzeje → te same missy zaczynają alarmować
    clock.now += 20 * MIN;
    guard.registerParseMiss('live:EEE');
    expect(guard.getState().suspectedMarkupChange).toBe(true);
  });

  it('sukces klucza czyści jego wpis', () => {
    const { guard } = makeGuard();
    guard.registerParseMiss('live:AAA');
    guard.registerParseMiss('live:BBB');
    guard.registerSuccess('live:AAA');
    expect(guard.getState().parseMissKeys).toEqual(['live:BBB']);
  });

  it('missy starsze niż okno 24h wygasają', () => {
    const { guard, clock } = makeGuard();
    guard.registerParseMiss('live:AAA');
    guard.registerParseMiss('live:BBB');
    clock.now += 25 * HOUR;
    guard.registerParseMiss('live:CCC');
    expect(guard.getState().parseMissKeys).toEqual(['live:CCC']);
    expect(guard.getState().suspectedMarkupChange).toBe(false);
  });

  it('klucz strukturalny: alarm po 2 KOLEJNYCH missach, nie po jednym', () => {
    const { guard, clock, notify } = makeGuard();
    guard.registerParseMiss('catalog', { structural: true });
    expect(guard.getState().suspectedMarkupChange).toBe(false);
    clock.now += HOUR;
    guard.registerParseMiss('catalog', { structural: true });
    expect(guard.getState().suspectedMarkupChange).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('sukces klucza strukturalnego zeruje jego licznik kolejnych missów', () => {
    const { guard, clock } = makeGuard();
    guard.registerParseMiss('catalog', { structural: true });
    guard.registerSuccess('catalog');
    clock.now += HOUR;
    guard.registerParseMiss('catalog', { structural: true });
    expect(guard.getState().suspectedMarkupChange).toBe(false); // consecutive znów = 1
  });

  it('klucze strukturalne nie liczą się do reguły distinct', () => {
    const { guard } = makeGuard();
    guard.registerParseMiss('catalog', { structural: true });
    guard.registerParseMiss('calendar:gpw', { structural: true });
    guard.registerParseMiss('calendar:nc', { structural: true });
    expect(guard.getState().suspectedMarkupChange).toBe(false); // 3 klucze, ale po 1 missie
  });
});

describe('odporność', () => {
  it('rzucający store → guard działa dalej (degradacja do pamięci)', () => {
    const brokenStore: GuardStateStore = {
      get: () => {
        throw new Error('db locked');
      },
      set: () => {
        throw new Error('db locked');
      },
    };
    const { guard, notify } = makeGuard({ store: brokenStore });
    for (let i = 0; i < 3; i++) guard.registerBlock();
    expect(guard.isBlocked()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1); // powiadomienie mimo martwego store'a
    guard.registerSuccess('x');
    expect(guard.getState().blocked).toBe(false);
  });

  it('rzucający notify nie wywala rejestracji', () => {
    const { guard } = makeGuard({
      notify: () => {
        throw new Error('smtp down');
      },
    });
    expect(() => {
      for (let i = 0; i < 3; i++) guard.registerBlock();
    }).not.toThrow();
    expect(guard.isBlocked()).toBe(true);
  });

  it('lastSuccessAt: zapis throttlowany, odczyt po restarcie', () => {
    const store = createMemoryGuardStore();
    const setSpy = vi.spyOn(store, 'set');
    const first = makeGuard({ store });
    first.guard.registerSuccess();
    first.clock.now += MIN;
    first.guard.registerSuccess(); // < 10 min od zapisu → bez write'u
    expect(setSpy.mock.calls.filter((c) => c[0] === 'last_success')).toHaveLength(1);

    const second = makeGuard({ store });
    expect(second.guard.getState().lastSuccessAt).toBe('2026-07-27T10:00:00.000Z');
  });
});
