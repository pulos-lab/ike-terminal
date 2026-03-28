import { useState, useCallback } from 'react';

export function useToggleSet<T = string>() {
  const [set, setSet] = useState<Set<T>>(new Set());

  const toggle = useCallback((key: T) => {
    setSet(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const has = useCallback((key: T) => set.has(key), [set]);

  return [set, toggle, has] as const;
}
