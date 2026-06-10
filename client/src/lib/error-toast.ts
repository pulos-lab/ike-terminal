import { toast } from 'sonner';
import { ApiError } from './api-client';

/**
 * Tłumaczenie statusów HTTP na komunikaty zrozumiałe dla użytkownika.
 * Serwer zwraca `error` po polsku tylko dla walidacji domenowych — dla błędów
 * infrastrukturalnych (5xx, brak dostępu) message bywa techniczny/angielski,
 * więc status wygrywa nad treścią.
 */
const STATUS_MESSAGES: Record<number, string> = {
  400: 'Nieprawidłowe dane — sprawdź formularz',
  403: 'Brak dostępu do tego portfela',
  404: 'Nie znaleziono — odśwież stronę',
  409: 'Taki wpis już istnieje',
  413: 'Plik jest zbyt duży',
  500: 'Błąd serwera — spróbuj ponownie za chwilę',
  503: 'Serwer chwilowo niedostępny',
};

/** Statusy, dla których komunikat serwera (jeśli jest) niesie więcej informacji niż mapa. */
const PREFER_SERVER_MESSAGE = new Set([400, 409]);

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const mapped = STATUS_MESSAGES[err.status];
    if (!mapped) return err.message;
    // 400/409 to walidacje domenowe — serwer zwykle mówi konkretnie co jest nie tak
    // (np. "Sprzedaż przekracza posiadaną ilość"). Generyczny fallback tylko gdy
    // message wygląda na techniczny ("HTTP 400", po angielsku itp.).
    if (PREFER_SERVER_MESSAGE.has(err.status) && err.message && !/^HTTP \d+/.test(err.message)) {
      return err.message;
    }
    return mapped;
  }
  if (err instanceof Error) {
    // fetch() przy braku sieci rzuca TypeError z komunikatem zależnym od przeglądarki
    // (Chrome/Safari/Firefox) — tylko te tłumaczymy, żeby nie maskować realnych TypeError.
    if (/^(Failed to fetch|Load failed|NetworkError)/.test(err.message)) {
      return 'Brak połączenia z serwerem — sprawdź internet';
    }
    return err.message;
  }
  return 'Nieznany błąd';
}

/** `errorToast('Nie udało się dodać transakcji', err)` → toast z polskim opisem błędu. */
export function errorToast(prefix: string, err: unknown): void {
  toast.error(`${prefix}: ${describeError(err)}`);
}
