/**
 * Powrót pod zamierzony adres po zalogowaniu.
 *
 * Gość otwierający np. zapisany link `/app/dividends` był odsyłany na stronę
 * główną i po logowaniu lądował na dashboardzie — cel przepadał. Zapamiętujemy
 * go w sessionStorage (przeżywa pełne przeładowania, przejście przez kod OTP
 * i rundę przez Google; żyje tylko w tej karcie) i konsumujemy przy pierwszym
 * przekierowaniu po udanym logowaniu.
 *
 * Adres NIGDY nie pochodzi z parametru URL ani z serwera — wyłącznie z bieżącej
 * lokalizacji tej karty — a mimo to przechodzi przez `sanitizeNextPath` przy
 * zapisie i przy odczycie: sessionStorage jest zapisywalny dla każdego skryptu
 * na stronie, więc traktujemy go jak dane niezaufane (open redirect).
 */

const STORAGE_KEY = 'tix.postLoginPath';
/** Po tym czasie zapamiętany cel wygasa — stary link nie powinien porywać nowej sesji. */
export const POST_LOGIN_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_POST_LOGIN_PATH = '/app';

/**
 * Zwraca bezpieczną ścieżkę wewnątrz aplikacji (`/app` lub `/app/...` wraz
 * z query i hashem) albo null. Odrzuca wszystko, co mogłoby wyprowadzić poza
 * origin: adresy absolutne, `//host`, backslashe (przeglądarki traktują `\`
 * jak `/`), znaki sterujące oraz ścieżki, które po normalizacji (`..`)
 * wychodzą poza `/app`.
 */
export function sanitizeNextPath(
  raw: string | null | undefined,
  origin = 'http://localhost',
): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  if (url.pathname !== '/app' && !url.pathname.startsWith('/app/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Czy ścieżka jest „głęboka”, tj. warta zapamiętania (sam `/app` to i tak cel domyślny). */
export function isDeepAppPath(path: string): boolean {
  const safe = sanitizeNextPath(path);
  return safe !== null && safe !== '/app' && safe !== '/app/';
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    // Tryb prywatny / zablokowane dane witryny — funkcja po prostu nie działa.
    return null;
  }
}

/** Zapamiętuje cel, jeśli jest bezpieczną, głęboką ścieżką aplikacji. */
export function rememberPostLoginPath(path: string, nowMs = Date.now()): void {
  const safe = sanitizeNextPath(path);
  if (!safe || !isDeepAppPath(safe)) return;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ path: safe, at: nowMs }));
  } catch {
    // brak miejsca / storage niedostępny — logowanie i tak zadziała, tylko bez powrotu
  }
}

/**
 * Odczytuje i KASUJE zapamiętany cel. null, gdy go nie ma, wygasł albo nie
 * przechodzi walidacji.
 */
export function consumePostLoginPath(nowMs = Date.now()): string | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
    store.removeItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return null;
    const age = nowMs - parsed.at;
    if (age < 0 || age > POST_LOGIN_TTL_MS) return null;
    return sanitizeNextPath(typeof parsed.path === 'string' ? parsed.path : null);
  } catch {
    return null;
  }
}

/** Dokąd iść po udanym logowaniu: zapamiętany cel albo dashboard. */
export function takePostLoginTarget(nowMs = Date.now()): string {
  return consumePostLoginPath(nowMs) ?? DEFAULT_POST_LOGIN_PATH;
}

/** Bieżący adres karty jako ścieżka (do zapamiętania przed przekierowaniem na logowanie). */
export function currentLocationPath(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}
