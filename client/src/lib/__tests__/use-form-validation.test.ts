import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFormValidation, type FieldErrors } from '../use-form-validation';

type Keys = 'date' | 'amount';

describe('useFormValidation', () => {
  it('nie pokazuje błędów przed pierwszą próbą submitu', () => {
    const errors: FieldErrors<Keys> = { date: 'Podaj datę' };
    const { result } = renderHook(() => useFormValidation(errors));

    expect(result.current.isValid).toBe(false);
    expect(result.current.fieldError('date')).toBeUndefined();
  });

  it('submitGuard na invalid odsłania błędy i NIE wywołuje fn', () => {
    const errors: FieldErrors<Keys> = { date: 'Podaj datę' };
    const { result } = renderHook(() => useFormValidation(errors));
    const fn = vi.fn();

    act(() => result.current.submitGuard(fn)());

    expect(fn).not.toHaveBeenCalled();
    expect(result.current.fieldError('date')).toBe('Podaj datę');
  });

  it('submitGuard na valid wywołuje fn bez pokazywania błędów', () => {
    const { result } = renderHook(() => useFormValidation({} as FieldErrors<Keys>));
    const fn = vi.fn();

    act(() => result.current.submitGuard(fn)());

    expect(fn).toHaveBeenCalledOnce();
    expect(result.current.isValid).toBe(true);
  });

  it('błędy znikają na żywo gdy user poprawia pole (errors są derived)', () => {
    let errors: FieldErrors<Keys> = { amount: 'Kwota musi być większa od 0' };
    const { result, rerender } = renderHook(() => useFormValidation(errors));

    act(() => result.current.submitGuard(vi.fn())());
    expect(result.current.fieldError('amount')).toBe('Kwota musi być większa od 0');

    errors = {}; // user wpisał poprawną kwotę
    rerender();
    expect(result.current.fieldError('amount')).toBeUndefined();
    expect(result.current.isValid).toBe(true);
  });

  it('reset ukrywa błędy do następnej próby submitu (ponowne otwarcie dialogu)', () => {
    const errors: FieldErrors<Keys> = { date: 'Podaj datę' };
    const { result } = renderHook(() => useFormValidation(errors));

    act(() => result.current.submitGuard(vi.fn())());
    expect(result.current.fieldError('date')).toBe('Podaj datę');

    act(() => result.current.reset());
    expect(result.current.fieldError('date')).toBeUndefined();
  });
});
