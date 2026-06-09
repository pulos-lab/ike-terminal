import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getTheme, setTheme, toggleTheme, subscribeTheme } from '../use-theme';

// W środowisku testowym window.localStorage bywa niefunkcjonalnym stubem
// (Node --localstorage-file) — podstawiamy działający in-memory mock.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('use-theme store', () => {
  beforeEach(() => {
    store.clear();
    // Deterministyczny punkt startowy dla każdego testu.
    setTheme('dark');
  });

  it('setTheme aktualizuje stan, klasę na <html> i localStorage', () => {
    setTheme('light');
    expect(getTheme()).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem('theme')).toBe('light');

    setTheme('dark');
    expect(getTheme()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem('theme')).toBe('dark');
  });

  it('toggleTheme przełącza dark ↔ light', () => {
    expect(getTheme()).toBe('dark');
    toggleTheme();
    expect(getTheme()).toBe('light');
    toggleTheme();
    expect(getTheme()).toBe('dark');
  });

  it('powiadamia subskrybentów przy zmianie motywu', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);

    setTheme('light');
    expect(listener).toHaveBeenCalledTimes(1);

    // Ustawienie tej samej wartości nie powiadamia (brak zmiany).
    setTheme('light');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setTheme('dark');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('nie powiadamia gdy motyw się nie zmienia', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);
    setTheme('dark'); // już dark
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
