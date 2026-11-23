/**
 * Czy „ogon" serii dziennych zamknięć jest aktualny — wspólna reguła dla
 * wszystkich źródeł historii (Yahoo, Stooq, biznesradar).
 *
 * Poprzednio każde źródło miało własną kopię reguły „ostatnia data w cache
 * ≤3 dni temu = świeże". Próg miał pokrywać weekend, ale działał też w środku
 * tygodnia: po pobraniu we wtorek (zamknięcie z poniedziałku) środa i czwartek
 * mieściły się w progu, więc zamknięcia z wtorku i środy dochodziły dopiero
 * w piątek, jedną paczką. Pomiar na produkcji (2026-11-23): tylko 34% pobrań
 * przynosiło jedną sesję, 53% — dwie lub trzy naraz. Skutek na ekranie:
 * ostatnie 1–2 dni wykresu i TWR liczone na starym zamknięciu, poprawiane
 * wstecz po dociągnięciu.
 *
 * Nowa reguła ma dwie części:
 *
 * 1. DATA. Ogon jest aktualny, gdy cache sięga ostatniego dnia roboczego PRZED
 *    dziś (UTC). Dzisiejszego słupka nie oczekujemy — jest częściowy i historia
 *    go nie przyjmuje (patrz `fetchYahooHistory`). W sobotę, niedzielę
 *    i poniedziałek oczekiwanym dniem jest piątek, więc weekend nadal nie
 *    generuje ruchu.
 *
 * 2. PAMIĘĆ SPRAWDZENIA. Kalendarza świąt nie znamy, a papier bywa wycofany
 *    albo bez obrotu — wtedy źródło odpowiada, ale niczego nowszego nie ma.
 *    Bez tej części takie tickery biłyby do źródła przy KAŻDYM żądaniu (stara
 *    reguła robiła dokładnie to dla wszystkiego starszego niż 3 dni). Dlatego
 *    po sprawdzeniu, na które źródło ODPOWIEDZIAŁO, przez `RECHECK_AFTER_MS`
 *    traktujemy ogon jak aktualny. Błąd sieci i otwarty bezpiecznik sprawdzeniem
 *    NIE są — po awarii następne żądanie próbuje od razu, jak dotąd.
 *
 * Pamięć jest w procesie: po restarcie każdy nieaktualny ticker zostanie
 * sprawdzony jeden raz więcej, co jest tańsze niż kolejna tabela.
 *
 * ZNANE OGRANICZENIE: instrumenty notowane w weekend (krypto) dostają sobotę
 * i niedzielę dopiero we wtorek — tak jak przy starej regule.
 */

/** Po jakim czasie od bezowocnego sprawdzenia pytamy źródło ponownie. */
const RECHECK_AFTER_MS = 6 * 60 * 60 * 1000;

/** TTL wpisu w cache pamięciowym, gdy ogon jest aktualny co do daty. */
const FRESH_CACHE_TTL_SECONDS = 12 * 60 * 60;

/** Podłoga TTL — żeby wpis tuż przed końcem okna nie wygasał co żądanie. */
const MIN_WAITING_TTL_SECONDS = 60;

const lastCheckedAt = new Map<string, number>();

/**
 * Ostatni dzień, z którego zamknięcie powinno już istnieć: najbliższy dzień
 * roboczy ściśle przed `today` (YYYY-MM-DD, UTC). Święta pomijamy świadomie —
 * obsługuje je pamięć sprawdzenia.
 */
export function lastExpectedCloseDate(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().split('T')[0];
}

export interface HistoryTailStatus {
  /** true = nie pytamy źródła o nowsze zamknięcia. */
  fresh: boolean;
  /**
   * Na ile wolno zapamiętać serię w cache pamięciowym. Gdy ogon jest „świeży"
   * tylko dzięki niedawnemu sprawdzeniu, TTL kończy się razem z oknem — inaczej
   * 12-godzinny wpis przetrzymałby nieaktualną serię dłużej niż samo okno.
   */
  cacheTtlSeconds: number;
}

/**
 * @param key klucz źródło+ticker (np. `yahoo:CDR.WA`) — ten sam, co w `noteHistoryTailChecked`
 * @param lastCached ostatnia data w trwałym cache albo null, gdy cache pusty
 */
export function getHistoryTailStatus(
  key: string,
  lastCached: string | null,
  now: Date = new Date(),
): HistoryTailStatus {
  if (!lastCached) return { fresh: false, cacheTtlSeconds: FRESH_CACHE_TTL_SECONDS };

  const today = now.toISOString().split('T')[0];
  if (lastCached >= lastExpectedCloseDate(today)) {
    return { fresh: true, cacheTtlSeconds: FRESH_CACHE_TTL_SECONDS };
  }

  const checkedAt = lastCheckedAt.get(key);
  if (checkedAt !== undefined) {
    const remainingMs = checkedAt + RECHECK_AFTER_MS - now.getTime();
    if (remainingMs > 0) {
      return {
        fresh: true,
        cacheTtlSeconds: Math.max(MIN_WAITING_TTL_SECONDS, Math.ceil(remainingMs / 1000)),
      };
    }
  }
  return { fresh: false, cacheTtlSeconds: FRESH_CACHE_TTL_SECONDS };
}

/**
 * Odnotuj, że źródło ODPOWIEDZIAŁO na pytanie o najnowsze zamknięcia. Wołać
 * tylko po udanej odpowiedzi — nie po błędzie sieci ani przy otwartym
 * bezpieczniku, bo wtedy chcemy ponowić przy następnym żądaniu.
 */
export function noteHistoryTailChecked(key: string, now: Date = new Date()): void {
  lastCheckedAt.set(key, now.getTime());
}

/** Wyczyść pamięć sprawdzeń (testy). */
export function resetHistoryTailChecks(): void {
  lastCheckedAt.clear();
}
