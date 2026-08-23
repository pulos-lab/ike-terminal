/**
 * Sufiksy giełdowe Yahoo oznaczające notowanie POZA Warszawą.
 *
 * PO CO: pseudo-ISIN-y ze starego formatu XTB są już kanonicznymi symbolami
 * Yahoo („SMSN.L", „INPST.AS", „NOVOB.CO"), ale etykieta waluty przy takiej
 * transakcji bywa walutą KONTA, nie notowania. Resolver rozstrzygał polskość
 * papieru właśnie po tej etykiecie, więc londyński GDR opisany jako „PLN"
 * wpadał w gałąź akceptującą wyłącznie listingi `.WA` i wracał nierozpoznany
 * (zgłoszenie 2026-08-23, `SMSN.UK`). Sufiks giełdy jest twardszym sygnałem
 * niż etykieta waluty i to on ma rozstrzygać.
 *
 * Świadomie BEZ `.WA` i `.NC` — te są markerem gałęzi polskiej.
 *
 * RELACJA DO `XTB_TO_YAHOO` (server/src/parsers/xtb-transactions.ts): tamta mapa
 * tłumaczy sufiks KRAJU u brokera na sufiks Yahoo i jest specyficzna dla XTB.
 * Ten zbiór odpowiada na inne pytanie („czy symbol jest już kanoniczny u Yahoo?")
 * i musi być nadzbiorem wartości tamtej mapy — pilnuje tego test parytetu
 * `server/src/parsers/__tests__/xtb-yahoo-suffix-parity.test.ts`.
 */
export const FOREIGN_YAHOO_SUFFIXES: ReadonlySet<string> = new Set([
  'L', // London Stock Exchange
  'IL', // LSE International Order Book (GDR-y, notowane w USD)
  'AS', // Euronext Amsterdam
  'PA', // Euronext Paris
  'BR', // Euronext Bruksela
  'LS', // Euronext Lizbona
  'MC', // BME Madryt
  'MI', // Borsa Italiana
  'DE', // XETRA
  'F', // Frankfurt
  'SG', // Stuttgart
  'VI', // Wiedeń
  'ST', // Nasdaq Sztokholm
  'OL', // Oslo Børs
  'CO', // Nasdaq Kopenhaga
  'HE', // Nasdaq Helsinki
  'IC', // Nasdaq Reykjavik
  'SW', // SIX Swiss Exchange
  'PR', // Praga
  'BD', // Budapeszt
  'IR', // Euronext Dublin
  'HK', // Hong Kong
  'T', // Tokio
  'TO', // Toronto
  'V', // TSX Venture
  'AX', // ASX Sydney
  'NZ', // NZX
  'SA', // B3 São Paulo
  'MX', // BMV Meksyk
  'JO', // Johannesburg
  'TA', // Tel Awiw
  'SI', // Singapur
  'KS', // KRX Seul
  'KQ', // KOSDAQ
  'TW', // Tajwan
  'NS', // NSE Indie
  'BO', // BSE Indie
]);

/**
 * Sufiks giełdy zagranicznej albo `null`.
 * „SMSN.L" → „L"; „JSW.WA" → null (Warszawa); „PLTR" → null (brak sufiksu);
 * „OIL.WTI" → null (sufiks nie jest kodem giełdy Yahoo).
 */
export function foreignYahooSuffix(symbol: string): string | null {
  const dot = symbol.lastIndexOf('.');
  if (dot === -1) return null;
  const suffix = symbol.slice(dot + 1).toUpperCase();
  return FOREIGN_YAHOO_SUFFIXES.has(suffix) ? suffix : null;
}

/** Czy symbol jest kanonicznym tickerem Yahoo z sufiksem giełdy zagranicznej. */
export function hasForeignYahooSuffix(symbol: string): boolean {
  return foreignYahooSuffix(symbol) !== null;
}
