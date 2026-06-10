import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSortableData } from '../useSortableData';

interface Row {
  date: string;
  ticker: string;
  amount: number | null;
}

const rows: Row[] = [
  { date: '2024-03-01', ticker: 'CDR.WA', amount: 50 },
  { date: '2024-01-15', ticker: 'AAPL', amount: 120 },
  { date: '2024-06-10', ticker: 'ŻYWIEC.WA', amount: null },
  { date: '2024-02-20', ticker: 'MSFT', amount: 80 },
];

describe('useSortableData', () => {
  it('bez initial zwraca wiersze w oryginalnej kolejności', () => {
    const { result } = renderHook(() => useSortableData(rows));
    expect(result.current.sorted).toEqual(rows);
    expect(result.current.sortKey).toBeNull();
  });

  it('pierwsze kliknięcie sortuje malejąco, drugie odwraca', () => {
    const { result } = renderHook(() => useSortableData(rows));

    act(() => result.current.toggle('date'));
    expect(result.current.sorted.map((r) => r.date)).toEqual([
      '2024-06-10',
      '2024-03-01',
      '2024-02-20',
      '2024-01-15',
    ]);
    expect(result.current.dir).toBe('desc');

    act(() => result.current.toggle('date'));
    expect(result.current.sorted[0].date).toBe('2024-01-15');
    expect(result.current.dir).toBe('asc');
  });

  it('zmiana kolumny resetuje kierunek na desc', () => {
    const { result } = renderHook(() => useSortableData(rows));
    act(() => result.current.toggle('date'));
    act(() => result.current.toggle('date')); // asc
    act(() => result.current.toggle('amount'));
    expect(result.current.dir).toBe('desc');
    expect(result.current.sortKey).toBe('amount');
  });

  it('liczby sortuje numerycznie, null zawsze na końcu', () => {
    const { result } = renderHook(() => useSortableData(rows));
    act(() => result.current.toggle('amount'));
    expect(result.current.sorted.map((r) => r.amount)).toEqual([120, 80, 50, null]);
    act(() => result.current.toggle('amount'));
    expect(result.current.sorted.map((r) => r.amount)).toEqual([50, 80, 120, null]);
  });

  it('stringi sortuje z locale pl (Ż za Z)', () => {
    const { result } = renderHook(() => useSortableData(rows));
    act(() => result.current.toggle('ticker'));
    act(() => result.current.toggle('ticker')); // asc
    expect(result.current.sorted.map((r) => r.ticker)).toEqual([
      'AAPL',
      'CDR.WA',
      'MSFT',
      'ŻYWIEC.WA',
    ]);
  });

  it('initial sortuje od pierwszego renderu', () => {
    const { result } = renderHook(() => useSortableData(rows, { key: 'date', dir: 'asc' }));
    expect(result.current.sorted[0].date).toBe('2024-01-15');
  });

  it('nie mutuje wejściowej tablicy', () => {
    const input = [...rows];
    const { result } = renderHook(() => useSortableData(input));
    act(() => result.current.toggle('date'));
    expect(input).toEqual(rows);
  });
});
