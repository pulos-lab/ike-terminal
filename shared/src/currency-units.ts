/**
 * Funt i pens to JEDNA waluta w dwóch jednostkach: 1 GBP = 100 GBX (Yahoo i część
 * brokerów pisze też „GBp"). Kurs FX istnieje tylko dla GBP (GBPPLN=X), więc
 * wszystko, co grupuje po walucie albo szuka kursu, musi sprowadzić GBX do GBP.
 *
 * Wcześniej ta sama normalizacja była zaszyta w ~25 miejscach (silnik, trasy,
 * resolver, rekoncyliacje, parsery) w kilku wariantach. Kwoty w pensach wymagają
 * DODATKOWO współczynnika — `penceFactor` — samo `currencyBucket` go nie niesie.
 */

/** Klucz waluty do grupowania i kursów: GBX/GBp/GBP → 'GBP', reszta uppercase. */
export function currencyBucket(currency: string | null | undefined): string {
  const u = (currency ?? '').trim().toUpperCase();
  return u === 'GBX' ? 'GBP' : u;
}

/** Mnożnik kwoty do jednostki `currencyBucket`: 0.01 dla pensów (GBX/GBp), inaczej 1.
 *  „GBp" (konwencja Yahoo) rozpoznajemy PRZED zmianą wielkości liter — po
 *  uppercase staje się „GBP", czyli funtem, i współczynnik by zniknął. */
export function penceFactor(currency: string | null | undefined): number {
  const raw = (currency ?? '').trim();
  return raw === 'GBp' || raw.toUpperCase() === 'GBX' ? 0.01 : 1;
}

/** Czy dwie etykiety oznaczają tę samą walutę (GBX ≡ GBP). */
export function sameCurrency(a: string | null | undefined, b: string | null | undefined): boolean {
  return currencyBucket(a) === currencyBucket(b);
}
