/**
 * Walidacja trafień z wyszukiwarki Yahoo dla papierów zagranicznych.
 *
 * GENEZA (zgłoszenie użytkownika 2026-07-20): Reliance Global Group zmieniło
 * ticker RELI→EZRA (2026-01-26). Symbol `RELI` zniknął z Yahoo, ale resolver
 * brał `byIsin[0]` / `byName[0]` bez żadnej weryfikacji — a wyszukiwarka Yahoo
 * na zapytanie „RELI" zwraca jako pierwszy wynik `RS | Reliance, Inc.`, czyli
 * dystrybutora stali z S&P 500. Portfel pokazywał 395,93 USD zamiast 2,28 USD.
 *
 * Zasada: lepiej ZERO ceny niż CUDZA cena. Odrzucone trafienie kończy się
 * provisional stubem (patrz `isProvisionalStub`), który jest re-resolwowany przy
 * kolejnym imporcie — więc pozycja sama się naprawi, gdy źródło ją wreszcie zna.
 */

/**
 * Tokeny pomijane przy porównywaniu nazw: formy prawne i oznaczenia klas akcji.
 * Klasy są tu, bo XTB podaje „NOVO NORDISK B", a Yahoo „Novo Nordisk A/S".
 */
const IGNORED_TOKENS = new Set([
  // formy prawne
  'SA',
  'S',
  'A',
  'INC',
  'CORP',
  'CORPORATION',
  'PLC',
  'NV',
  'AG',
  'ASA',
  'AB',
  'OYJ',
  'SE',
  'LTD',
  'LIMITED',
  'CO',
  'COMPANY',
  'GROUP',
  'HOLDING',
  'HOLDINGS',
  'TBK',
  'PT',
  'THE',
  'SPA',
  'KGAA',
  'TRUST',
  'NA',
  'AS',
  'ADR',
  'SPÓŁKA',
  'AKCYJNA',
  // klasy akcji
  'CLASS',
  'CL',
  'B',
  'C',
  'I',
  'II',
]);

/** Minimalna długość tokenu, przy której dopuszczamy dopasowanie po prefiksie
 *  (żeby „TECH" trafiło w „TECHNOLOGY", ale „REL" już nie w „RELIANCE"). */
const MIN_PREFIX_LEN = 4;

function tokenize(value: string): string[] {
  return value
    .toUpperCase()
    .split(/[^A-Z0-9ĄĆĘŁŃÓŚŹŻ]+/)
    .filter((t) => t.length > 0 && !IGNORED_TOKENS.has(t));
}

/** Część symbolu przed sufiksem giełdy: „INPST.AS" → „INPST". */
function baseSymbol(value: string): string {
  const dot = value.indexOf('.');
  return dot === -1 ? value : value.slice(0, dot);
}

/**
 * Czy zwrócony symbol to ten sam papier co szukany ticker?
 *
 * Akceptujemy różnicę sufiksu giełdowego, bo mapa XTB_TO_YAHOO jest niepełna
 * (13 pozycji, brak m.in. .AT/.BE/.PT) — dla nieznanego sufiksu XTB oddaje goły
 * ticker, a Yahoo słusznie zwraca go z sufiksem (np. „XYZ" → „XYZ.VI").
 */
function symbolMatches(query: string, symbol: string): boolean {
  const q = query.toUpperCase();
  const sym = symbol.toUpperCase();
  if (sym === q) return true;
  if (sym.startsWith(q + '.')) return true;
  const qBase = baseSymbol(q);
  return qBase.length > 0 && qBase === baseSymbol(sym);
}

/**
 * Czy nazwa z Yahoo odpowiada temu, o co pytaliśmy?
 *
 * KLUCZOWE: dla zapytania jednotokenowego wymagamy DOKŁADNEGO trafienia w token
 * nazwy — dopasowanie po prefiksie jest zabronione, bo „RELI" jest prefiksem
 * „RELIANCE" i to właśnie ten prefiks przepuścił błędne trafienie RELI→RS.
 * Prefiksy dopuszczamy dopiero przy zapytaniach wielotokenowych, gdzie pozostałe
 * tokeny niosą wystarczający kontekst („MICRON TECH" → „Micron Technology").
 */
function nameMatches(query: string, name: string): boolean {
  const qt = tokenize(query);
  const nt = tokenize(name);
  if (qt.length === 0 || nt.length === 0) return false;

  if (qt.length === 1) {
    return nt.includes(qt[0]);
  }
  return qt.every((t) =>
    nt.some((n) => n === t || (t.length >= MIN_PREFIX_LEN && n.startsWith(t))),
  );
}

/**
 * Czy trafienie z Yahoo odpowiada któremukolwiek z zapytań (ticker / nazwa
 * papieru od brokera)? Wystarczy zgodność symbolu ALBO nazwy.
 */
export function isPlausibleMatch(
  queries: Array<string | undefined | null>,
  candidate: { symbol: string; name: string },
): boolean {
  const seen = queries.filter((q): q is string => !!q && q.trim().length > 0);
  return seen.some(
    (q) => symbolMatches(q, candidate.symbol) || nameMatches(q, candidate.name || ''),
  );
}

/**
 * Pierwsze trafienie z listy, które przechodzi walidację. `null`, gdy żadne —
 * wtedy wołający MUSI zrezygnować, a nie sięgać po `[0]`.
 */
export function pickPlausible<T extends { symbol: string; name: string }>(
  candidates: T[],
  queries: Array<string | undefined | null>,
): T | null {
  return candidates.find((c) => isPlausibleMatch(queries, c)) ?? null;
}
