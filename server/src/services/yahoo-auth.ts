const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FETCH_TIMEOUT = 10_000;
const CRUMB_TTL = 6 * 3600 * 1000;

let cachedCrumb: string | null = null;
let cachedCookies: string | null = null;
let crumbExpiresAt = 0;

/**
 * Crumb to krótki token bez białych znaków (np. `4rRSDBSpuMv`, bywa z `/`).
 * Strona zgody, challenge albo pusta odpowiedź NIM NIE JEST — a zapisana jako
 * crumb zatruwa wszystkie ścieżki z autoryzacją na 6 h.
 */
export function isPlausibleCrumb(value: string): boolean {
  const token = value.trim();
  return token.length > 0 && token.length <= 64 && !/[\s<>]/.test(token);
}

async function refreshYahooCrumb(): Promise<void> {
  try {
    const resp1 = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    const setCookieHeaders = resp1.headers.getSetCookie?.() || [];
    cachedCookies = setCookieHeaders.map((c) => c.split(';')[0]).join('; ');

    if (!cachedCookies) {
      console.warn('[yahoo-auth] No cookies received from fc.yahoo.com');
      return;
    }

    const resp2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': USER_AGENT, Cookie: cachedCookies },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp2.ok) {
      console.warn(`[yahoo-auth] Crumb fetch failed: HTTP ${resp2.status}`);
      return;
    }
    const body = (await resp2.text()).trim();
    if (!isPlausibleCrumb(body)) {
      // Yahoo bywa oddaje 200 ze stroną zgody/challenge zamiast tokenu. Zapisany
      // „crumb" w postaci HTML-a żyłby 6 h, a v7 odpowiadałby przez ten czas
      // kopertą Unauthorized przy HTTP 200 — czyli cichą pustką w cenach.
      console.warn(
        `[yahoo-auth] Crumb endpoint zwrócił 200, ale treść nie wygląda na token (${body.length} znaków)`,
      );
      return;
    }
    cachedCrumb = body;
    crumbExpiresAt = Date.now() + CRUMB_TTL;
    console.log('[yahoo-auth] Crumb refreshed successfully');
  } catch (error) {
    console.error('[yahoo-auth] Failed to refresh crumb:', error);
  }
}

export async function getYahooAuth(): Promise<{ crumb: string; cookies: string } | null> {
  if (!cachedCrumb || !cachedCookies || Date.now() > crumbExpiresAt) {
    await refreshYahooCrumb();
  }
  if (!cachedCrumb || !cachedCookies) return null;
  return { crumb: cachedCrumb, cookies: cachedCookies };
}

export function invalidateYahooAuth(): void {
  cachedCrumb = null;
}
