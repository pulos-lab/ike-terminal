import { useState, useEffect } from 'react';

/**
 * Synchronizes React state with localStorage.
 * Returns a tuple identical to useState, but the value persists across reloads.
 *
 * Safely handles SSR and serialization errors — falls back to defaultValue if
 * localStorage is unavailable or stored JSON is malformed.
 */
export function useLocalStorage<T>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore quota / serialization errors
    }
  }, [key, value]);

  return [value, setValue] as const;
}
