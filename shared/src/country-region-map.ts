/**
 * Regiony portfela — mapowanie kraju siedziby spółki (Yahoo assetProfile.country,
 * kanoniczne angielskie nazwy) na polskie etykiety wykresu „Regiony".
 *
 * Kraj jest źródłem pierwszego wyboru (poprawnie klasyfikuje ADR-y — np. Novo
 * Nordisk notowany na NYSE → Dania). Gdy kraju brak (ETF-y, CFD, stare wpisy
 * przed backfillem) — fallback na giełdę notowania (EXCHANGE_REGION_PL).
 */

/** Yahoo country (EN) → polska etykieta regionu. Nazwy spoza mapy przechodzą
 *  bez tłumaczenia (lepszy angielski kraj niż wiadro „Inne"). */
export const COUNTRY_LABEL_PL: Record<string, string> = {
  // Ameryka Północna
  'United States': 'USA',
  Canada: 'Kanada',
  Mexico: 'Meksyk',

  // Polska i Europa
  Poland: 'Polska',
  Germany: 'Niemcy',
  'United Kingdom': 'Wielka Brytania',
  France: 'Francja',
  Netherlands: 'Holandia',
  Switzerland: 'Szwajcaria',
  Sweden: 'Szwecja',
  Norway: 'Norwegia',
  Denmark: 'Dania',
  Finland: 'Finlandia',
  Spain: 'Hiszpania',
  Italy: 'Włochy',
  Portugal: 'Portugalia',
  Belgium: 'Belgia',
  Austria: 'Austria',
  Ireland: 'Irlandia',
  Luxembourg: 'Luksemburg',
  Greece: 'Grecja',
  'Czech Republic': 'Czechy',
  Czechia: 'Czechy',
  Hungary: 'Węgry',
  Romania: 'Rumunia',
  Slovakia: 'Słowacja',
  Slovenia: 'Słowenia',
  Lithuania: 'Litwa',
  Latvia: 'Łotwa',
  Estonia: 'Estonia',
  Ukraine: 'Ukraina',
  Cyprus: 'Cypr',
  Malta: 'Malta',
  Iceland: 'Islandia',
  Monaco: 'Monako',
  Liechtenstein: 'Liechtenstein',
  Gibraltar: 'Gibraltar',
  Jersey: 'Jersey',
  Guernsey: 'Guernsey',
  'Isle of Man': 'Wyspa Man',
  Turkey: 'Turcja',
  Russia: 'Rosja',

  // Azja i Pacyfik
  Japan: 'Japonia',
  China: 'Chiny',
  'Hong Kong': 'Hongkong',
  Macau: 'Makau',
  Taiwan: 'Tajwan',
  'South Korea': 'Korea Południowa',
  Singapore: 'Singapur',
  India: 'Indie',
  Indonesia: 'Indonezja',
  Malaysia: 'Malezja',
  Thailand: 'Tajlandia',
  Vietnam: 'Wietnam',
  Philippines: 'Filipiny',
  Kazakhstan: 'Kazachstan',
  Australia: 'Australia',
  'New Zealand': 'Nowa Zelandia',

  // Bliski Wschód i Afryka
  Israel: 'Izrael',
  'United Arab Emirates': 'Zjedn. Emiraty Arabskie',
  'Saudi Arabia': 'Arabia Saudyjska',
  Qatar: 'Katar',
  'South Africa': 'RPA',
  Egypt: 'Egipt',
  Nigeria: 'Nigeria',

  // Ameryka Łacińska i raje rejestrowe (częste siedziby holdingów)
  Brazil: 'Brazylia',
  Argentina: 'Argentyna',
  Chile: 'Chile',
  Colombia: 'Kolumbia',
  Peru: 'Peru',
  Uruguay: 'Urugwaj',
  Panama: 'Panama',
  'Costa Rica': 'Kostaryka',
  'Cayman Islands': 'Kajmany',
  Bermuda: 'Bermudy',
  Bahamas: 'Bahamy',
  'British Virgin Islands': 'Brytyjskie Wyspy Dziewicze',
  Curacao: 'Curaçao',
  Curaçao: 'Curaçao',
};

/** Fallback: giełda notowania → region, gdy kraj siedziby nieznany.
 *  Pokrywa PEŁNY enum TickerMapEntry['exchange'] — wcześniej brak XETRA
 *  i CATALYST wysyłał SAP.DE i polskie obligacje do „Inne". */
export const EXCHANGE_REGION_PL: Record<string, string> = {
  GPW: 'Polska',
  NC: 'Polska',
  CATALYST: 'Polska',
  NYSE: 'USA',
  NASDAQ: 'USA',
  TSX: 'Kanada',
  XETRA: 'Niemcy',
  OTHER: 'Inne',
};

/**
 * Etykieta regionu dla pozycji: kraj siedziby (jeśli rozwiązany) → giełda → „Inne".
 */
export function regionLabel(
  country: string | null | undefined,
  exchange: string | null | undefined,
): string {
  if (country) return COUNTRY_LABEL_PL[country] ?? country;
  return EXCHANGE_REGION_PL[exchange ?? ''] ?? 'Inne';
}
