import { useSyncExternalStore } from 'react';

/**
 * Centralny store motywu (dark / light).
 *
 * Pojedyncze źródło prawdy dla całej aplikacji — wcześniej AppShell przełączał
 * klasę `dark` na <html> imperatywnie, a wykresy (lightweight-charts) i palety
 * SVG czytały `document.documentElement.classList` raz przy montowaniu, przez
 * co przełączenie motywu nie przekolorowywało ich aż do niezwiązanego
 * re-renderu. Store + useSyncExternalStore daje reaktywność bez kontekstu.
 *
 * Inicjalizacja (w tej kolejności):
 * 1. wartość zapisana w localStorage,
 * 2. aktualna klasa na <html> (index.html bootstrapuje `class="dark"`),
 * 3. preferencja systemowa (prefers-color-scheme).
 * Persystowany motyw aplikowany jest na DOM już przy imporcie modułu, żeby
 * zminimalizować flash przy starcie.
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'theme';

function readInitialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* Safari Private / brak localStorage */
  }
  if (typeof document !== 'undefined') {
    if (document.documentElement.classList.contains('dark')) return 'dark';
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  }
  return 'dark';
}

function applyThemeToDom(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

let currentTheme: Theme = readInitialTheme();
// Synchronizacja DOM z persystowaną wartością — index.html ma na sztywno
// class="dark", więc po zapisanym 'light' trzeba klasę zdjąć od razu.
applyThemeToDom(currentTheme);

const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return currentTheme;
}

export function setTheme(theme: Theme) {
  if (theme === currentTheme) return;
  currentTheme = theme;
  applyThemeToDom(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore quota / Safari Private */
  }
  for (const listener of listeners) listener();
}

export function toggleTheme() {
  setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hook reaktywnego motywu. Każdy komponent korzystający z hooka re-renderuje
 * się przy przełączeniu motywu (toggle w AppShell), więc wykresy i palety
 * mogą bezpiecznie zależeć od `theme` / `isDark` w useEffect / useMemo.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  return { theme, isDark: theme === 'dark', setTheme, toggleTheme };
}
