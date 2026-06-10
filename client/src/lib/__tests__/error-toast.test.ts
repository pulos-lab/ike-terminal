import { describe, expect, it } from 'vitest';
import { describeError } from '../error-toast';
import { ApiError } from '../api-client';

describe('describeError', () => {
  it('mapuje statusy infrastrukturalne na polskie komunikaty (ignoruje message)', () => {
    expect(describeError(new ApiError('Internal Server Error', 500))).toBe(
      'Błąd serwera — spróbuj ponownie za chwilę',
    );
    expect(describeError(new ApiError('Forbidden', 403))).toBe('Brak dostępu do tego portfela');
    expect(describeError(new ApiError('Not Found', 404))).toBe('Nie znaleziono — odśwież stronę');
    expect(describeError(new ApiError('Payload Too Large', 413))).toBe('Plik jest zbyt duży');
    expect(describeError(new ApiError('Service Unavailable', 503))).toBe(
      'Serwer chwilowo niedostępny',
    );
  });

  it('dla 400/409 preferuje konkretny komunikat serwera', () => {
    expect(describeError(new ApiError('Sprzedaż przekracza posiadaną ilość', 400))).toBe(
      'Sprzedaż przekracza posiadaną ilość',
    );
    expect(describeError(new ApiError('Taki split już istnieje', 409))).toBe(
      'Taki split już istnieje',
    );
  });

  it('dla 400/409 z technicznym message daje generyczny polski fallback', () => {
    expect(describeError(new ApiError('HTTP 400', 400))).toBe(
      'Nieprawidłowe dane — sprawdź formularz',
    );
    expect(describeError(new ApiError('', 409))).toBe('Taki wpis już istnieje');
  });

  it('niezmapowany status zachowuje message serwera', () => {
    expect(describeError(new ApiError('Teapot refuses', 418))).toBe('Teapot refuses');
  });

  it('błąd sieci (fetch) tłumaczy na komunikat o połączeniu', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toBe(
      'Brak połączenia z serwerem — sprawdź internet',
    );
  });

  it('zwykły Error przechodzi bez zmian, nie-Error daje fallback', () => {
    expect(describeError(new Error('Brak ID do edycji'))).toBe('Brak ID do edycji');
    expect(describeError('string')).toBe('Nieznany błąd');
    expect(describeError(undefined)).toBe('Nieznany błąd');
  });
});
