/**
 * Data sesji dla dziennego słupka Yahoo (v8 chart, `interval=1d`).
 *
 * Yahoo stempluje słupek dzienny POCZĄTKIEM sesji w czasie giełdy, a nie północą
 * UTC. Dopóki giełda leży na zachód od Greenwich albo otwiera się po północy UTC,
 * data UTC stempla i data sesji są tym samym dniem. Przestają być, gdy początek
 * sesji wypada przed północą UTC — zmierzone na żywej odpowiedzi (2026-11-23):
 *
 * - pary walutowe (`USDPLN=X`, `EURUSD=X`, wszystkie `=X`; `Europe/London`):
 *   słupek to doba londyńska, stempel = północ w Londynie. Zimą 00:00 UTC, latem
 *   (BST) **23:00 UTC dnia poprzedniego**. Sesja poniedziałkowa 2026-07-13 ma
 *   stempel `2026-07-12T23:00:00Z`;
 * - ASX (`.AX`, `Australia/Sydney`): otwarcie 10:00 — w czasie AEDT 23:00 UTC
 *   dnia poprzedniego (zimą australijską 00:00 UTC, bez przesunięcia);
 * - NZX (`.NZ`, `Pacific/Auckland`): otwarcie 10:00 = 21:00/22:00 UTC dnia
 *   poprzedniego, cały rok.
 *
 * Kontrakty (`GC=F`: północ nowojorska = 04/05:00 UTC), krypto (północ UTC),
 * GPW, XETRA, giełdy USA, Tokio, Hongkong i Singapur mają datę UTC równą dacie
 * sesji.
 *
 * Datowanie przez `toISOString()` przesuwało więc takie serie o dzień WSTECZ:
 * poniedziałek lądował pod niedzielą, piątek pod czwartkiem. Silnik wyceny czyta
 * kurs z dnia D po kluczu D, więc latem wycena z dnia D brała zamknięcie sesji
 * D+1 — kurs, którego w dniu D jeszcze nie było.
 *
 * `meta.gmtoffset` się do tego NIE nadaje: to offset bieżący, wspólny dla całej
 * odpowiedzi (w listopadzie `0` także dla słupków lipcowych). Offset trzeba
 * liczyć per słupek ze strefy `meta.exchangeTimezoneName`.
 */

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** Formatter `YYYY-MM-DD` w danej strefie; `null`, gdy środowisko jej nie zna. */
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  let fmt = formatters.get(timeZone);
  if (fmt === undefined) {
    try {
      // `en-CA` daje wprost `YYYY-MM-DD`; kalendarz i cyfry przypięte jawnie,
      // żeby domyślne ustawienia procesu nie zmieniły kształtu daty.
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      fmt = null; // nieznana strefa (RangeError) — spadamy na UTC
    }
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Data UTC stempla (sekundy epoch) — dawny sposób datowania słupka. */
export function utcDateOfTimestamp(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString().split('T')[0];
}

/**
 * Data sesji (`YYYY-MM-DD`) słupka dziennego o stemplu `tsSeconds`, liczona
 * w strefie giełdy z `meta.exchangeTimezoneName`.
 *
 * Brak strefy w odpowiedzi albo strefa nieznana środowisku → data UTC, czyli
 * dotychczasowe zachowanie (poprawne dla wszystkich rynków poza wymienionymi
 * w nagłówku pliku).
 */
export function yahooBarDate(tsSeconds: number, timeZone: string | null | undefined): string {
  if (!timeZone) return utcDateOfTimestamp(tsSeconds);
  const fmt = formatterFor(timeZone);
  if (!fmt) return utcDateOfTimestamp(tsSeconds);
  return fmt.format(new Date(tsSeconds * 1000));
}

/**
 * Czy słupek wolno zapisać jako ZAMKNIĘCIE, gdy bieżąca data UTC to `todayUtc`.
 *
 * Słupek trwającej sesji niesie cenę śróddzienną. Rozpoznajemy go po dacie, ale
 * po OBU datach naraz, bo Yahoo stempluje go na dwa sposoby:
 *
 * - bieżącym czasem notowania (`regularMarketTime`) — tak wygląda słupek pary
 *   walutowej w ciągu dnia; jego data UTC to dziś, więc łapie go warunek na UTC
 *   (to cała dotychczasowa reguła — jej nie wolno poluzować);
 * - początkiem sesji — tak wygląda słupek NZX po otwarciu (21:00 UTC, w Auckland
 *   już jutro); data UTC bywa wtedy WCZORAJSZA, a data sesji to dziś lub jutro,
 *   więc łapie go dopiero warunek na datę sesji. Przy datowaniu po UTC taki
 *   słupek przechodził filtr po północy UTC i kurs śróddzienny trafiał do
 *   historii jako zamknięcie poprzedniego dnia.
 *
 * Reguła jest ostrożna w jedną stronę: sesja zakończona, ale datowana na dziś
 * (Sydney po 16:00 czasu miejscowego), poczeka na zapis do północy UTC. Historia
 * czyta zamknięcia, bieżącą cenę ma osobna ścieżka (`live_quotes`).
 */
export function isSettledYahooBar(
  tsSeconds: number,
  timeZone: string | null | undefined,
  todayUtc: string,
): boolean {
  return utcDateOfTimestamp(tsSeconds) < todayUtc && yahooBarDate(tsSeconds, timeZone) < todayUtc;
}
