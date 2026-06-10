import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';

/**
 * Sortowanie tabel po kliknięciu nagłówka. Bez `initial` zwraca wiersze w oryginalnej
 * kolejności do pierwszego kliknięcia. Pierwsze kliknięcie kolumny sortuje malejąco
 * (najczęstszy przypadek: najnowsze daty / największe kwoty na górze), drugie odwraca.
 * Wartości null/undefined zawsze lądują na końcu. Stringi porównujemy locale 'pl',
 * daty ISO (YYYY-MM-DD) sortują się poprawnie leksykograficznie.
 */
export function useSortableData<T>(rows: T[], initial?: { key: keyof T & string; dir: SortDir }) {
  const [sortKey, setSortKey] = useState<(keyof T & string) | null>(initial?.key ?? null);
  const [dir, setDir] = useState<SortDir>(initial?.dir ?? 'desc');

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), 'pl');
      return dir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, dir]);

  const toggle = (key: keyof T & string) => {
    if (sortKey === key) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setDir('desc');
    }
  };

  return { sorted, sortKey, dir, toggle };
}
