import { useCallback, useState } from 'react';

export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

/**
 * Lekka walidacja formularzy bez biblioteki. Błędy są derived — komponent liczy je
 * w `useMemo` z aktualnego stanu pól; hook tylko gate'uje ich POKAZYWANIE do
 * pierwszej próby submitu (przycisk zawsze klikalny, klik na invalid odsłania
 * komunikaty zamiast wysyłać). Po odsłonięciu błędy znikają na żywo w trakcie
 * poprawiania, bo memo przelicza się przy każdej zmianie pola.
 */
export function useFormValidation<K extends string>(errors: FieldErrors<K>) {
  const [submitted, setSubmitted] = useState(false);

  const isValid = Object.keys(errors).length === 0;

  /** Owija handler submitu: przy invalid pokazuje błędy zamiast wywołać `fn`. */
  const submitGuard = useCallback(
    (fn: () => void) => () => {
      if (Object.keys(errors).length > 0) {
        setSubmitted(true);
        return;
      }
      fn();
    },
    [errors],
  );

  /** Błąd pola — `undefined` dopóki user nie spróbował submitu. */
  const fieldError = useCallback(
    (key: K): string | undefined => (submitted ? errors[key] : undefined),
    [submitted, errors],
  );

  /** Wywołać przy otwarciu dialogu (w istniejącym useEffect resetu stanu). */
  const reset = useCallback(() => setSubmitted(false), []);

  return { isValid, submitGuard, fieldError, reset };
}
