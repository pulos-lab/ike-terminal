/**
 * Dzienna zmiana wartości — per pozycja i zbiorczo dla portfela.
 *
 * Czyste funkcje (zero sieci, zero zegara): silnik pozycji podaje ceny, loty
 * i dzień sesji, widok pozycji sumuje wynik. Jedna definicja dla tabeli
 * Portfela, paska metryk i dashboardu — inaczej trzy miejsca liczyłyby „dziś”
 * trzema sposobami.
 *
 * DEFINICJA: ruch CEN wyceniony BIEŻĄCYM kursem waluty. Zmiana kursu walut
 * w ciągu dnia NIE wchodzi do liczby (`fxIncluded: false`) — spójnie z kolumną
 * „zmiana dzienna” per pozycja, która od zawsze jest w walucie notowania,
 * i bez mieszania godzin odcięcia giełdy z rynkiem walutowym.
 */
import type { Position, PortfolioDayChange } from 'shared';

export interface DayChangeLot {
  /** Data transakcji otwierającej lot (YYYY-MM-DD, ewentualnie z czasem). */
  date: string;
  /** Ilość w locie — zawsze dodatnia, także dla lotów pozycji krótkiej. */
  quantity: number;
  /** Cena otwarcia w walucie LOTU (skala notowania — przed mnożnikiem instrumentu). */
  price: number;
  currency: string;
}

export interface PositionDayChangeInput {
  lots: DayChangeLot[];
  /** Pozycja krótka: zysk, gdy cena spada. */
  isShort: boolean;
  /** Bieżąca cena w walucie notowania (dla Londynu już w funtach, nie pensach). */
  priceNative: number;
  /** Poprzednie zamknięcie w tej samej skali co `priceNative`; null = nieznane. */
  previousCloseNative: number | null;
  /** Dzień sesji, z której pochodzi `priceNative` (YYYY-MM-DD). */
  sessionDate: string;
  /** Mnożnik instrumentu: nominał/100 dla obligacji, mnożnik kontraktu dla opcji. */
  instMult: number;
  /** Kurs waluty notowania do PLN. */
  fxNativeToPln: number;
  /** Kursy walut lotów do PLN (klucz = waluta lotu). */
  fxRates: Record<string, number>;
}

/**
 * Zmiana wartości pozycji względem poprzedniego zamknięcia.
 *
 * Lot otwarty W DNIU SESJI nie istniał na poprzednim zamknięciu, więc jego
 * punktem odniesienia jest cena otwarcia lotu — inaczej zakup po 103 przy
 * wczorajszym zamknięciu 100 i dzisiejszej cenie 103 pokazałby +3 „zarobione
 * dziś”, których nie było. Koszt lotu przeliczamy do PLN tym samym kursem, co
 * silnik w `costBasisPln`, więc dla lotu z dziś wynik = jego niezrealizowany P/L.
 *
 * Zwraca null, gdy jakikolwiek starszy lot wymaga poprzedniego zamknięcia,
 * a go nie mamy — częściowej liczby nie pokazujemy jako pełnej.
 */
export function computePositionDayChange(
  input: PositionDayChangeInput,
): { native: number; pln: number } | null {
  const { lots, isShort, priceNative, previousCloseNative, sessionDate, instMult } = input;
  const { fxNativeToPln, fxRates } = input;
  if (!(priceNative > 0) || !(fxNativeToPln > 0) || lots.length === 0) return null;

  const hasPrevClose = previousCloseNative != null && previousCloseNative > 0;
  let pln = 0;
  for (const lot of lots) {
    const openedInSession = lot.date.slice(0, 10) >= sessionDate;
    if (openedInSession) {
      const lotFx = fxRates[lot.currency] || 1;
      pln += lot.quantity * instMult * (priceNative * fxNativeToPln - lot.price * lotFx);
    } else {
      if (!hasPrevClose) return null;
      pln +=
        lot.quantity * instMult * (priceNative - (previousCloseNative as number)) * fxNativeToPln;
    }
  }
  if (isShort) pln = -pln;
  return { native: pln / fxNativeToPln, pln };
}

/** Ile tickerów bez danych wymieniamy z nazwy — reszta mieści się w liczniku. */
const MAX_MISSING_TICKERS = 20;

/**
 * Dzienna zmiana portfela = suma zmian pozycji.
 *
 * Gotówka nie ma dziennej zmiany (0) i nie wchodzi do licznika pokrycia, ale
 * WCHODZI do mianownika procentu — pytanie brzmi „o ile zmienił się portfel”,
 * a nie „o ile zmieniły się akcje”. Mianownik to wartość sprzed zmiany
 * (`total − change`); przy ujemnym lub zerowym kapitale procent nie ma sensu.
 *
 * Pokrycie jest JAWNE: pozycja bez danych (cena z fallbacku, opcja po wartości
 * wewnętrznej, GPW z zapasowego źródła) liczy się do `totalCount`, nie do
 * `coveredCount`. Bez tego portfel z dużym udziałem NewConnect pokazywałby
 * zmianę policzoną z połowy pozycji bez żadnej wskazówki, że jest niepełna.
 */
export function summarizeDayChange(
  positions: Pick<Position, 'ticker' | 'currency' | 'dailyChangeValue' | 'dailyChangeValuePln'>[],
  totalValuePln: number,
  baseCurrency: string,
): PortfolioDayChange | null {
  if (positions.length === 0) return null;

  const base = (baseCurrency || 'PLN').toUpperCase();
  let changePln = 0;
  let changeNative = 0;
  let coveredCount = 0;
  const missingTickers: string[] = [];
  let hasForeignPositions = false;

  for (const p of positions) {
    if ((p.currency || '').toUpperCase() !== base) hasForeignPositions = true;
    if (p.dailyChangeValuePln == null || p.dailyChangeValue == null) {
      if (missingTickers.length < MAX_MISSING_TICKERS) missingTickers.push(p.ticker);
      continue;
    }
    coveredCount++;
    changePln += p.dailyChangeValuePln;
    changeNative += p.dailyChangeValue;
  }

  if (coveredCount === 0) {
    return {
      change: null,
      changePct: null,
      currency: base,
      coveredCount,
      totalCount: positions.length,
      missingTickers,
      fxIncluded: false,
      hasForeignPositions,
    };
  }

  // Portfel w walucie innej niż PLN pokazuje wartości natywne pozycji (tak jak
  // tabela Portfela) — kwota idzie z sumy natywnej, procent z PLN (jest
  // niezmienniczy względem waluty przy jednym, bieżącym kursie).
  const previousValuePln = totalValuePln - changePln;
  return {
    change: base === 'PLN' ? changePln : changeNative,
    changePct: previousValuePln > 0 ? (changePln / previousValuePln) * 100 : null,
    currency: base,
    coveredCount,
    totalCount: positions.length,
    missingTickers,
    fxIncluded: false,
    hasForeignPositions,
  };
}

/**
 * Poprzednie zamknięcie z lokalnej historii cen (zapas, gdy źródło live nie
 * odpowiada): OSTATNI kurs sprzed dnia sesji, nie starszy niż `maxAgeDays`.
 *
 * Wcześniej brany był „przedostatni wiersz z ostatnich 10 dni” bez patrzenia
 * na daty — przy dziurze w cache'u dawał zmianę dwu- albo pięciodniową
 * podpisaną jako dzienna. Zbyt stary kurs to brak danych, nie przybliżenie.
 */
export function pickPreviousClose(
  rows: Array<{ date: string; close: number }>,
  sessionDate: string,
  maxAgeDays = 7,
): number | null {
  const sessionMs = Date.parse(`${sessionDate}T00:00:00Z`);
  if (!Number.isFinite(sessionMs)) return null;
  let best: { date: string; close: number } | null = null;
  for (const row of rows) {
    const day = row.date.slice(0, 10);
    if (day >= sessionDate) continue;
    if (!(row.close > 0)) continue;
    if (!best || day > best.date.slice(0, 10)) best = row;
  }
  if (!best) return null;
  const ageDays = (sessionMs - Date.parse(`${best.date.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
  return ageDays <= maxAgeDays ? best.close : null;
}

/**
 * Dzień ostatniej sesji giełdowej dla źródeł, które nie podają czasu notowania
 * (biznesradar, Stooq): dziś w dni robocze, w weekend — miniony piątek.
 *
 * Bez tego w sobotę „ostatnie zamknięcie sprzed dziś” byłoby piątkowym kursem,
 * czyli tym samym, co cena bieżąca, i zmiana wychodziłaby 0 zamiast ruchu
 * z piątkowej sesji. Święta giełdowe świadomie pominięte (kalendarza nie mamy):
 * w taki dzień zmiana pokaże 0 — rzadkie i nieszkodliwe przybliżenie.
 */
export function lastWeekdayIso(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0 = niedziela, 6 = sobota
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}
