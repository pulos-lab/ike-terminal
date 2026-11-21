import { describe, it, expect, beforeEach } from 'vitest';
import {
  POST_LOGIN_TTL_MS,
  consumePostLoginPath,
  isDeepAppPath,
  rememberPostLoginPath,
  sanitizeNextPath,
  takePostLoginTarget,
} from '../post-login-redirect';

const NOW = 1_800_000_000_000;

describe('sanitizeNextPath', () => {
  it.each([
    ['/app', '/app'],
    ['/app/dividends', '/app/dividends'],
    ['/app/instrument/US0378331005', '/app/instrument/US0378331005'],
    ['/app/trades?year=2025#top', '/app/trades?year=2025#top'],
    ['/app/a/../portfolio', '/app/portfolio'],
  ])('przepuszcza ścieżkę aplikacji %s', (input, expected) => {
    expect(sanitizeNextPath(input)).toBe(expected);
  });

  it.each([
    ['adres absolutny', 'https://evil.example/app'],
    ['protocol-relative', '//evil.example/app'],
    ['backslash jako ukośnik', '/\\evil.example/app'],
    ['backslash w środku', '/app\\..\\..\\evil'],
    ['schemat javascript', 'javascript:alert(1)'],
    ['schemat data', 'data:text/html,<script>1</script>'],
    ['ścieżka względna', 'app/dividends'],
    ['poza aplikacją', '/login'],
    ['strona główna', '/'],
    ['prefiks udający /app', '/application'],
    ['wyjście przez ..', '/app/../login'],
    ['wyjście przez .. do roota', '/app/../../'],
    ['znak nowej linii', '/app/\nSet-Cookie: x'],
    ['tabulator', '/app/\tx'],
    ['pusty', ''],
    ['null', null],
    ['undefined', undefined],
    ['za długi', `/app/${'a'.repeat(3000)}`],
  ])('odrzuca: %s', (_name, input) => {
    expect(sanitizeNextPath(input as string | null | undefined)).toBeNull();
  });
});

describe('isDeepAppPath', () => {
  it('sam /app nie jest wart zapamiętania', () => {
    expect(isDeepAppPath('/app')).toBe(false);
    expect(isDeepAppPath('/app/')).toBe(false);
    expect(isDeepAppPath('/app/cash')).toBe(true);
    expect(isDeepAppPath('/login')).toBe(false);
  });
});

describe('remember / consume', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('zapamiętany cel wraca raz i znika', () => {
    rememberPostLoginPath('/app/dividends?year=2025', NOW);
    expect(consumePostLoginPath(NOW + 1000)).toBe('/app/dividends?year=2025');
    expect(consumePostLoginPath(NOW + 2000)).toBeNull();
  });

  it('wygasa po 30 minutach', () => {
    rememberPostLoginPath('/app/cash', NOW);
    expect(consumePostLoginPath(NOW + POST_LOGIN_TTL_MS + 1)).toBeNull();
    // wygasły wpis też jest sprzątany
    expect(window.sessionStorage.length).toBe(0);
  });

  it('nie zapamiętuje ścieżek spoza aplikacji ani samego /app', () => {
    rememberPostLoginPath('https://evil.example/app', NOW);
    rememberPostLoginPath('/login', NOW);
    rememberPostLoginPath('/app', NOW);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('wpis podmieniony w storage przez obcy skrypt nie wyprowadza poza aplikację', () => {
    for (const path of ['https://evil.example/', '//evil.example', '/\\evil.example']) {
      window.sessionStorage.setItem('tix.postLoginPath', JSON.stringify({ path, at: NOW }));
      expect(consumePostLoginPath(NOW)).toBeNull();
    }
  });

  it('śmieci w storage nie wywracają logowania', () => {
    for (const junk of [
      '{',
      '"x"',
      'null',
      '{"path":"/app/x"}',
      '{"path":"/app/x","at":"wczoraj"}',
    ]) {
      window.sessionStorage.setItem('tix.postLoginPath', junk);
      expect(consumePostLoginPath(NOW)).toBeNull();
    }
  });

  it('znacznik czasu z przyszłości jest odrzucany', () => {
    window.sessionStorage.setItem(
      'tix.postLoginPath',
      JSON.stringify({ path: '/app/cash', at: NOW + 60_000 }),
    );
    expect(consumePostLoginPath(NOW)).toBeNull();
  });

  it('takePostLoginTarget: cel albo dashboard', () => {
    expect(takePostLoginTarget(NOW)).toBe('/app');
    rememberPostLoginPath('/app/trades', NOW);
    expect(takePostLoginTarget(NOW)).toBe('/app/trades');
    expect(takePostLoginTarget(NOW)).toBe('/app');
  });
});
