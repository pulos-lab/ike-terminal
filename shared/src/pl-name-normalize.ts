/**
 * Normalizacja nazw polskich spółek do porównań między źródłami.
 *
 * Powstało dla mapowania pozycji na slug terminarza bankiera, ale jest celowo
 * ogólne — `sector-resolver.ts` ma własny, prawie identyczny `normalizeName`,
 * który jednak NIE składa diakrytyków, przez co „Grupa Kety" (nazwa brokerska,
 * bez ogonków) nie trafia w „Grupa Kęty" z mapy sektorów. Docelowo tamten
 * powinien wołać tę funkcję; podmiana jest poza zakresem tej zmiany, żeby nie
 * ruszać klasyfikacji sektorowej przy okazji kalendarza wyników.
 */

/** Ogonki → litery bazowe. `ł` wymaga osobnej reguły: NFD go nie rozkłada. */
export function foldPolishDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L');
}

/**
 * Nazwa spółki sprowadzona do postaci porównywalnej: bez diakrytyków, bez form
 * prawnych na końcu, bez interpunkcji, lowercase, pojedyncze spacje.
 *
 * „Grupa Kęty S.A." → „grupa kety”; „CD PROJEKT S.A." → „cd projekt”.
 */
export function normalizePolishCompanyName(name: string): string {
  return foldPolishDiacritics(name)
    .toLowerCase()
    .replace(/\s+spolka\s+akcyjna\s*$/, '')
    .replace(/[\s,]+s\.?\s?a\.?\s*$/, '')
    .replace(/\s+asi\s*$/, '')
    .replace(/\s+se\s*$/, '')
    .replace(/[.,'"()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Postać „zbita" — dodatkowo bez spacji. Slugi bankiera są właśnie zbite
 * (`ORANGEPL`, `BIGCHEESE`), więc to jest forma do porównania nazwy ze slugiem.
 */
export function compactPolishCompanyName(name: string): string {
  return normalizePolishCompanyName(name).replace(/\s+/g, '');
}
