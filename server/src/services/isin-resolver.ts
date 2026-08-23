import type { Transaction, TickerMapEntry } from 'shared';
import {
  findNcTicker,
  findCfdTicker,
  getCfdSector,
  isBondInstrument,
  findBondByIsin,
  findBondByTicker,
  hasForeignYahooSuffix,
} from 'shared';
import { getTickerMap, upsertTickerMapEntry, isProvisionalStub } from '../db/ticker-map-repo.js';
import { searchYahoo, fetchYahooSymbolInfo } from './ticker-search.js';
import { getBrCatalogService } from './biznesradar-catalog.js';
import { fetchYahooPrice } from './yahoo-finance.js';
import { resolveSector } from './sector-resolver.js';
import { mapWithConcurrency } from './concurrency.js';
import { normalizeBossaPaperName, isNewConnectPaperName } from './stooq-utils.js';
import { pickPlausible, isExactSymbolMatch, isSameBaseSymbol } from './ticker-match.js';

interface UnresolvedIsin {
  isin: string;
  paperName: string;
  currency: string;
}

export interface ResolveResult {
  resolved: TickerMapEntry[];
  unresolved: UnresolvedIsin[];
}

/**
 * Infer exchange type from ticker symbol and Yahoo exchange string.
 */
/**
 * Giełda z sufiksu tickera albo kodu giełdy Yahoo. `OTHER` oznacza „nie wiem" —
 * i jest to stan REALNY na produkcji dla ręcznie dodanych tickerów, więc konsumenci
 * nie mogą traktować go jak zamkniętej listy (patrz `resolveEarningsMarket`).
 */
export function inferExchange(ticker: string, yahooExchange?: string): TickerMapEntry['exchange'] {
  if (ticker.endsWith('.WA')) return 'GPW';
  if (ticker.endsWith('.DE')) return 'XETRA';
  if (ticker.endsWith('.TO')) return 'TSX';

  if (yahooExchange) {
    const ex = yahooExchange.toUpperCase();
    if (ex.includes('NASDAQ') || ex === 'NMS' || ex === 'NGM' || ex === 'NCM') return 'NASDAQ';
    if (ex.includes('NYSE') || ex === 'NYQ') return 'NYSE';
    if (ex.includes('XETRA') || ex === 'GER') return 'XETRA';
    if (ex.includes('TSX') || ex === 'TOR') return 'TSX';
    if (ex.includes('WARSAW') || ex.includes('WSE')) return 'GPW';
  }

  return 'OTHER';
}

/**
 * Infer price source from ticker symbol and exchange.
 * NewConnect (.NC) → Stooq (Yahoo doesn't list all NC stocks).
 * Everything else (GPW .WA, foreign) → Yahoo (to avoid Stooq daily rate limits).
 */
function inferPriceSource(ticker: string, exchange?: string): 'yahoo' | 'stooq' {
  if (exchange === 'NC') return 'stooq';
  return 'yahoo';
}

/**
 * Try to resolve a single ISIN to a TickerMapEntry.
 *
 * Resolution order:
 * 1. Yahoo search by ISIN (most reliable — exact identifier)
 * 2. Yahoo search by paper name (fallback for small stocks)
 * 3. Stooq validation for Polish (PL*) ISINs
 */
/**
 * Check if a string looks like a real ISIN (2 uppercase letters + 10 alphanumeric chars).
 * mBank pseudo-ISINs (e.g., "ETFSP500", "PKOBP") won't match this pattern.
 */
function isRealIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(value);
}

/**
 * Split concatenated mBank ETF names into searchable queries.
 * e.g., "BETAETFWIG20TR" → "BETA ETF WIG20TR"
 *        "ETFSP500"       → "ETFSP500" (no change needed, short enough for Yahoo)
 */
function splitEtfName(name: string): string {
  const upper = name.toUpperCase();
  // Pattern: prefix + "ETF" + rest, e.g. "BETA" + "ETF" + "WIG20TR"
  const match = upper.match(/^(BETA|XTRACKERS?|ISHARES?|LYXOR|AMUNDI)?(ETF)(.+)$/i);
  if (match) {
    const parts = [match[1], match[2], match[3]].filter(Boolean);
    return parts.join(' ');
  }
  return name;
}

/**
 * Aliasy rebrandingowe polskich spółek: stary kod tickera → obecny.
 *
 * ⚠ KOD TICKERA BYWA RECYKLOWANY. Po delistingu GPW/NewConnect zwalnia
 * trzyliterowy kod i nadaje go innej spółce. Alias, którego KLUCZ jest dziś
 * żywym kodem, kieruje pozycję na CUDZY papier — tak `SUN: 'MIG'` (Sundragon
 * → Military Group, 2025) rozjechał Suntech, który przejął kod `SUN`
 * (zgłoszenie 2026-08-23). Rozstrzygnięcie „stary czy nowy właściciel kodu"
 * wymagałoby daty transakcji, której ta mapa nie zna, więc:
 *  1) resolver pyta katalog BR SUROWYM kodem PRZED aliasem (patrz `resolveIsin`),
 *  2) klucz aliasu nie może być tickerem żywym w `NC_TICKER_MAP` — pilnuje tego
 *     `__tests__/isin-resolver-alias-hygiene.test.ts`, więc dopisanie kolejnego
 *     kolidującego aliasu wywala CI.
 * Wyjątkiem jest `7FT`: tam alias jest POPRAWNY (7Fit naprawdę jest dziś OML),
 * a nieaktualny jest wpis w mapie NC — scraper mapy jej nie odświeżył.
 */
export const STOOQ_ALIASES: Record<string, string> = {
  DINO: 'DNP', // Dino Polska
  R22: 'CBF', // R22 → CyberFolks
  BRU: 'MBR', // old ticker → Mo-BRUK
  CCC: 'MOD', // CCC → Modivo (2026)
  RAEN: 'GVT', // Raen → Grupa Virtus (2026)
  NEPTS: 'YAN', // Neptis → Yanosik (2026)
  VGN: 'TEC', // Vinci Gen → Tecnovatica (2026)
  EON: 'EUV', // EO Networks → Euvic (2026)
  DTL: 'VAI', // Detalion Games → Volaria AI (2025)
  // UWAGA: brak aliasu PKN→ORL. To był rebrand WYŁĄCZNIE w schemacie Stooqa
  // (martwy od 2026); biznesradar i Yahoo kwotują Orlen pod PKN/PKN.WA,
  // a ORL.WA to Orzeł S.A. (NewConnect) — alias kierował Orlen na Orzeł.
  LVC: 'TXT', // LiveChat → Text (2023)
  FMF: 'GNE', // Famur → Grenevia (2023)
  GBK: 'CPT', // GetBack → Capitea (2023)
  OAT: 'MOC', // OncoArendi → Molecure (2022)
  '4FM': 'DIG', // 4FUN Media → Digital Network (2022)
  WSC: 'GGP', // Work Service → Gi Group Poland (2021)
  LCC: 'DVL', // LC Corp → Develia (2019)
  VST: 'VRG', // Vistula Group → VRG (2018)
  PIL: 'DAT', // PiLab → DataWalk (2018)
  // NewConnect renamed tickers
  RAE: 'GVT', // Raen → Grupa Virtus (2026)
  VAK: 'BTF', // Vakomtek → BTCS (2025)
  // USUNIĘTE: SUN → MIG (Sundragon → Military Group, 2025). Kod SUN należy dziś
  // do Suntechu, a Military Group jest osiągalny własnym kodem MIG. Alias na
  // żywym kodzie tylko losowo (zależnie od dostępności katalogu) podstawiał
  // cudzy papier — patrz nagłówek mapy.
  PGM: 'GNS', // Polska Grupa Motoryzacyjna → Grupa Niewiadów (2025)
  PUN: 'RAE', // PunkPirates → Raen (2023)
  BRZ: 'HUB', // Boruta-Zachem → Hub.Tech (2022)
  MCP: 'BEL', // Medcamp → BeLeaf (2022)
  IQP: 'PUN', // IQ Partners → PunkPirates (2020)
  '7FT': 'OML', // 7Fit → One More Level (2020)
  BSP: 'IVO', // Baltic Storage → Incuvo (2020)
  ZAK: 'PDG', // Zaks → Pyramid Games (2019)
  // USUNIĘTE: SKN → SIM (Skin-System → SimFabric, 2019). Kod SKN nosi dziś
  // Sakana — ta sama pułapka co SUN, tyle że jeszcze niezgłoszona.
  BLU: 'CLC', // Blumerang Pre-IPO → Columbus Energy (2018)
};

/**
 * Aliasy rebrandingowe dla papierów ZAGRANICZNYCH (stary ticker → obecny).
 *
 * Odpowiednik `STOOQ_ALIASES`, ale dla gałęzi zagranicznej. To jedyna droga do
 * auto-naprawy zmiany tickera: Yahoo nie wystawia mapowania stary→nowy symbol.
 * Wyszukiwarka zwraca wprawdzie `prevName`/`nameChangeDate`, ale tylko dla zmian
 * NAZWY — dla wycofanego symbolu chart oddaje po prostu 404, a `search` podsuwa
 * pierwszą lepszą spółkę o podobnej nazwie.
 */
export const FOREIGN_TICKER_ALIASES: Record<string, string> = {
  RELI: 'EZRA', // Reliance Global Group → EZRA International Group (2026-01-26)
};

/**
 * Aliasy NOTACJI BROKERA → symbol Yahoo (papiery zagraniczne).
 *
 * Inny byt niż `FOREIGN_TICKER_ALIASES`: tam symbol był kiedyś poprawny i zmienił
 * się w czasie (rebranding), tu nigdy poprawny nie był — broker po prostu zapisuje
 * klasę akcji inną konwencją niż Yahoo. Yahoo używa MYŚLNIKA (`BRK-B`, `BF-B`),
 * XTB skleja literę z tickerem (`BRKB.US`, `BFB.US`), a klasa C Alphabetu siedzi
 * u Yahoo pod gołym `GOOG`.
 *
 * DLACZEGO MAPA, A NIE HEURYSTYKA (zmierzone na żywej wyszukiwarce 2026-08-06):
 *  - `search('GOOGC')` → tylko `GOOGCL.SN` (Santiago, CLP) — poprawnego papieru
 *    NIE MA w wynikach, więc żaden filtr waluty/giełdy go nie wyłowi,
 *  - `search('ALPHABET INC C')` → 7 trafień, wszystkie cross-listingi (NEO, Santiago,
 *    Wiedeń, Buenos Aires), zero z USA,
 *  - `search('Alphabet')` → `GOOG` i `GOOGL` obok siebie, a informacja o klasie już
 *    przepadła → wybór `[0]` byłby losowaniem między papierami po ~360 USD,
 *  - `search('Berkshire Hathaway B')` → pierwsze trafienie to lewarowany ETP 2x.
 * Wpisy tu są więc świadomie ręczne i każdy jest zweryfikowany kursem z Yahoo.
 *
 * Klucz = symbol BEZ sufiksu kraju (parser XTB obcina `.US` przed resolverem);
 * `lookupForeignAlias` próbuje dodatkowo bazy symbolu, żeby złapać też ścieżki,
 * które sufiks zachowują (import uniwersalny nie obcina niczego).
 */
export const BROKER_TICKER_ALIASES: Record<string, string> = {
  GOOGC: 'GOOG', // XTB Alphabet klasa C → Yahoo GOOG (klasa A to GOOGL)
  BRKA: 'BRK-A', // XTB Berkshire Hathaway klasa A
  BRKB: 'BRK-B', // XTB Berkshire Hathaway klasa B
  BFB: 'BF-B', // XTB Brown-Forman klasa B
  // Novo Nordisk B z Kopenhagi. XTB `NOVOB.DK` → nasza mapa sufiksów daje `NOVOB.CO`,
  // a Yahoo trzyma tę akcję pod `NOVO-B.CO`. Symbol `NOVOB.CO` u Yahoo ISTNIEJE, ale
  // oddaje pustą cenę — czyli `chart` nie odsiewa go tak, jak odsiewa symbol nieznany.
  // Zmierzone na prodzie: 7 portfeli bez ceny, wszystkie z cenami transakcji 232–600,
  // czyli notowanie kopenhaskie w DKK (amerykański ADR `NVO` chodzi ~40 USD).
  NOVOB: 'NOVO-B.CO',
};

/** GBX/GBp (pensy) i GBP to ta sama waluta w innej jednostce — nie mylić z niezgodnością. */
function sameCurrency(a: string, b: string): boolean {
  const norm = (c: string) => (c.toUpperCase() === 'GBX' ? 'GBP' : c.toUpperCase());
  return norm(a) === norm(b);
}

/**
 * `buildEntry` + guard waluty dla trafień NIE-dokładnych.
 *
 * GENEZA: `isPlausibleMatch` przepuszcza różnicę sufiksu giełdy (`BRKB` → `BRKB.VI`),
 * więc XTB-owe `BRKB.US` rozwiązywało się na wiedeński listing w EUR. Gdy symbol nie
 * jest dokładnym trafieniem, żądamy zgodności waluty notowania z walutą transakcji —
 * inaczej odrzucamy i pozwalamy zadziałać kolejnej strategii (a finalnie zwrócić null,
 * czyli provisional stub). Zasada niezmieniona: lepiej zero ceny niż cudza cena.
 *
 * Guard jest wołany WYŁĄCZNIE w gałęzi `shouldValidate` (pseudo-ISIN, niepolski,
 * nie-CFD). To istotne: dla papieru kupionego w PLN `isPolishTicker` jest prawdziwe,
 * więc guard nie ruszy tam, gdzie waluta transakcji to waluta konta, a nie notowania.
 *
 * Gdy `buildEntry` nie zdołał pobrać ceny, waluta wpisu spada do `txCurrency` —
 * porównanie wypada wtedy trywialnie zgodne i wpis przechodzi. Świadomie: brak danych
 * nie jest dowodem niezgodności.
 */
async function buildEntryGuarded(
  isin: string,
  hit: { symbol: string; name: string; exchange?: string },
  paperName: string,
  txCurrency: string,
  matchQueries: Array<string | undefined>,
  /**
   * Waluta transakcji jest ZGADNIĘTA z sufiksu kraju u brokera (XTB: `.UK` → GBP),
   * a nie odczytana z pliku. Wtedy nie może przeważyć nad notowaniem z Yahoo —
   * patrz komentarz przy sprawdzeniu niżej.
   */
  txCurrencyIsGuess = false,
): Promise<TickerMapEntry | null> {
  const entry = await buildEntry(isin, hit.symbol, hit.name, hit.exchange, paperName, txCurrency);
  if (isExactSymbolMatch(matchQueries, hit.symbol)) return entry;
  if (sameCurrency(entry.currency, txCurrency)) return entry;
  // Sufiks kraju mówi, GDZIE papier jest notowany — nie W CZYM. Londyn kwotuje
  // GDR-y w USD (`SMSN.IL`, `ISAC.L`), więc etykieta GBP z `.UK` przegrywa
  // z walutą notowania, o ile trafienie jest tym samym kodem papieru i różni się
  // wyłącznie sufiksem giełdy (zgłoszenie 2026-08-23: `SMSN.UK` → `SMSN.IL`).
  // Dla symbolu BEZ sufiksu (`BRKB` → `BRKB.VI`) etykieta pochodzi z pliku i guard
  // działa jak dotąd.
  if (txCurrencyIsGuess && isSameBaseSymbol(matchQueries, hit.symbol)) return entry;
  console.log(
    `  ✗ ${isin} → ${hit.symbol} odrzucone: notowanie w ${entry.currency}, transakcja w ${txCurrency}`,
  );
  return null;
}

/** Symbol bez sufiksu giełdy/kraju: „GOOGC.US" → „GOOGC". */
function baseTickerSymbol(value: string): string {
  const dot = value.indexOf('.');
  return dot === -1 ? value : value.slice(0, dot);
}

/**
 * Alias dla zagranicznego symbolu: najpierw rebranding, potem notacja brokera.
 * Sprawdzamy symbol w całości i jego bazę — `GOOGC` i `GOOGC.US` mają trafić tak samo.
 */
export function lookupForeignAlias(symbol: string): string | undefined {
  const keys = [symbol.toUpperCase(), baseTickerSymbol(symbol.toUpperCase())];
  for (const key of keys) {
    const hit = FOREIGN_TICKER_ALIASES[key] ?? BROKER_TICKER_ALIASES[key];
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Wczesny NC offline guard używany w resolverze przed jakimkolwiek requestem do
 * Yahoo/Stooq. Jeśli paper name ma sufiks `-NC`/`-NC-FIX` (Bossa autorytatywnie
 * mówi "NewConnect"), statyczna mapa NC jest wystarczająca i bezpieczniejsza
 * niż Yahoo (który czasem zwraca .WA symbol bez OHLC dla NC spółki — np. SEV.WA
 * dla SEVENET). Wyekstrahowane do osobnej funkcji żeby umożliwić czysty test.
 */
export function tryNcOfflineGuard(isin: string, paperName: string): TickerMapEntry | null {
  if (!isNewConnectPaperName(paperName)) return null;
  const cleanName = normalizeBossaPaperName(paperName);
  if (cleanName.length < 2) return null;
  const ncEntry = findNcTicker(cleanName);
  if (!ncEntry) return null;
  return {
    isin,
    ticker: `${ncEntry.ticker}.WA`,
    name: ncEntry.name,
    exchange: 'NC' as TickerMapEntry['exchange'],
    currency: 'PLN',
    priceSource: 'stooq',
  };
}

/**
 * Wczesny guard obligacji Catalyst — analogia do tryNcOfflineGuard. Yahoo nie zna
 * Catalyst, więc każdy request to strata; Stooq kwotuje obligacje po tickerze serii
 * (np. ds1030, fpc0733) w % nominału. Wpis z bond-map gdy znamy serię; dla obligacji
 * spoza mapy (np. świeża emisja korporacyjna) fallback na paperName — Stooq i tak
 * rozpozna symbol, a nominał silnik wyinferuje z transakcji.
 */
export function tryBondGuard(
  isin: string,
  paperName: string,
  txCurrency: string,
): TickerMapEntry | null {
  if (!isBondInstrument(paperName, isin)) return null;
  const bond = findBondByIsin(isin) ?? findBondByTicker(paperName);
  const ticker = bond?.ticker ?? paperName.toUpperCase().trim();
  return {
    isin,
    ticker,
    name: bond ? `${bond.ticker} (${bond.name})` : ticker,
    exchange: 'CATALYST' as TickerMapEntry['exchange'],
    currency: bond?.currency ?? txCurrency ?? 'PLN',
    priceSource: 'stooq',
  };
}

/**
 * Statyczna mapa spółek trwale wycofanych z obrotu na GPW (delisting). Yahoo/Stooq
 * nie kwotują ich już cen, więc resolver bez tego guardu zwracałby null. Klucz = ISIN.
 *
 * TODO (patrz backlog): docelowo `status`/`category` na `ticker_map` + scraper archiwum
 * GPW zamiast hardcode. Na teraz — analogicznie do NC/bond map — mała mapa wystarcza.
 */
const DELISTED_GPW = new Map<string, { ticker: string; name: string }>([
  ['PLPSTBX00016', { ticker: 'PLASTBOX', name: 'Plast-Box S.A.' }],
]);

export function tryDelistedGuard(isin: string): TickerMapEntry | null {
  const entry = DELISTED_GPW.get(isin);
  if (!entry) return null;
  return {
    isin,
    ticker: entry.ticker,
    name: entry.name,
    exchange: 'GPW',
    currency: 'PLN',
    priceSource: 'stooq',
  };
}

export async function resolveIsin(
  isin: string,
  paperName: string,
  txCurrency: string,
): Promise<TickerMapEntry | null> {
  const isPseudoIsin = !isRealIsin(isin);

  // Should we prefer Warsaw Stock Exchange results?
  const isRealPolishIsin = isin.startsWith('PL') && isRealIsin(isin);
  // Pseudo-ISIN z kanonicznym sufiksem giełdy Yahoo („SMSN.L", „INPST.AS",
  // „NOVOB.CO") NIE jest polski — nawet gdy etykieta waluty mówi PLN. Ta
  // etykieta bywa walutą KONTA: `resolveTradeCurrency` (parser XTB) ma kilka
  // ścieżek, w których nie da się policzyć implikowanego kursu i zostaje waluta
  // rachunku. Bez tego londyński GDR Samsunga („SMSN.UK" → „SMSN.L") szedł
  // gałęzią polską, która akceptuje wyłącznie `.WA`, i wracał nierozpoznany
  // (zgłoszenie 2026-08-23).
  const foreignSuffix = isPseudoIsin && hasForeignYahooSuffix(isin);
  const isPolishTicker =
    !foreignSuffix &&
    (isRealPolishIsin || isin.endsWith('.WA') || (isPseudoIsin && txCurrency === 'PLN'));

  // Detect NewConnect from paper name suffix (Bossa uses "-NC", "-NC-FIX")
  const isNewConnect = isNewConnectPaperName(paperName);

  // Clean up paper names: remove Bossa suffixes like "-NC", "-NC-FIX", "-FIX", "-C", ".WA"
  const cleanName = normalizeBossaPaperName(paperName);

  // Wczesny guard NC: jeśli paper name ma sufiks -NC (Bossa), statyczna mapa
  // jest autorytatywna. Yahoo czasem zwraca .WA symbol dla NC spółki (np. SEV.WA
  // dla SEVENET) bez aktualnych danych OHLC — wtedy Strategy 1 (Yahoo by ISIN)
  // akceptuje pusty wynik, a późniejszy NC offline fallback (line ~309) już nie
  // odpala. Sprawdzenie tutaj — przed jakimkolwiek requestem do Yahoo/Stooq —
  // gwarantuje że NC offline map wygra dla każdej ścieżki ISIN-u.
  const ncGuard = tryNcOfflineGuard(isin, paperName);
  if (ncGuard) return ncGuard;

  // Wczesny guard obligacji Catalyst — przed jakimkolwiek requestem do Yahoo/Stooq.
  const bondGuard = tryBondGuard(isin, paperName, txCurrency);
  if (bondGuard) return bondGuard;

  // Wczesny guard spółek wycofanych z GPW — Yahoo/Stooq nie mają danych OHLC,
  // resolver zwróciłby null i papier zostałby "Nie rozpoznano" mimo że ticker
  // jest znany. Statyczna mapa (jak NC/bond) załatwia sprawę bez requestów.
  const delistedGuard = tryDelistedGuard(isin);
  if (delistedGuard) return delistedGuard;

  // === Polish pseudo-ISINs: katalog biznesradar FIRST (authoritative for GPW+NC) ===
  // Dawniej Stooq; oba jego endpointy padły (CSV /q/l/ ~03.2026, /cmp/ challenge
  // anti-bot ~07.2026). Katalog BR pokrywa GPW+NC (bez GlobalConnect) i sam
  // klasyfikuje NC vs GPW z weryfikacją nazwy (kolizje typu ORL→ORZLOPONY/Orlen).
  // This covers: mBank tickers (CDR, KTY), XTB new format (Cyfrowy Polsat, PGE),
  // XTB old format (.WA suffix like JSW.WA, ANR.WA)
  if (isPolishTicker && isPseudoIsin && cleanName.length >= 2) {
    // Check aliases for ambiguous names (e.g., "Dino" → "DNP")
    const aliasedName = STOOQ_ALIASES[cleanName.toUpperCase()] || cleanName;

    // Czy kod, który podał broker, jest DZIŚ czyimś tickerem? Statyczna mapa NC
    // jest tu jedynym offline'owym dowodem — i wystarczającym, bo recykling kodu
    // po delistingu zdarza się właśnie na NewConnect (SUN, SKN, 7FT).
    const ncExact = findNcTicker(cleanName);
    const rawCodeIsLive = !!ncExact && ncExact.ticker.toUpperCase() === cleanName.toUpperCase();

    // 1. Dokładne dopasowanie tickera w katalogu BR (short tickers: PGE, CDR, JSW, DNP)
    //    Gdy kod jest żywy, pytamy o niego SUROWO przed aliasem: alias pamięta
    //    POPRZEDNIEGO właściciela kodu i kierowałby pozycję na cudzy papier
    //    (patrz nagłówek STOOQ_ALIASES). Bez tego dowodu kolejność zostaje dawna
    //    — dla rebrandingu stary kod jest martwy i alias jest jedyną drogą.
    const candidates: string[] = [];
    if (rawCodeIsLive && aliasedName !== cleanName) candidates.push(cleanName);
    candidates.push(aliasedName);
    if (
      !aliasedName.toUpperCase().startsWith('ETF') &&
      !aliasedName.toUpperCase().startsWith('BETA')
    ) {
      if (aliasedName.length > 4) candidates.push(aliasedName.substring(0, 4));
      if (aliasedName.length > 3) candidates.push(aliasedName.substring(0, 3));
    }

    for (const candidate of candidates) {
      // expectedName=cleanName: kandydaci obcięci/aliasowani nie mogą łapać
      // obcych spółek o tym samym kodzie (np. "ORLEN"→"ORL" = Orzeł S.A. na NC).
      // Gdy user podał sam ticker (cleanName == kod w katalogu), weryfikacja
      // przechodzi przez furtkę tożsamości tickera w findByTicker.
      const brResult = await getBrCatalogService().findByTicker(candidate, cleanName);
      if (brResult) {
        // Katalog klasyfikuje NC (krzyżowanie z mapą NC + zgodność nazwy);
        // sufiks -NC z Bossy zostaje dodatkowym, autorytatywnym sygnałem.
        const exchange = (
          isNewConnect || brResult.exchange === 'NC' ? 'NC' : 'GPW'
        ) as TickerMapEntry['exchange'];
        return {
          isin,
          ticker: brResult.symbol,
          name: brResult.name,
          exchange,
          currency: 'PLN',
          priceSource: inferPriceSource(brResult.symbol, exchange),
        };
      }
    }

    // 2. Statyczna mapa NC — DOKŁADNE trafienie kodu tickera, PRZED dopasowaniem
    //    po nazwie. Kod jest unikalny w obrębie GPW+NewConnect, więc dokładne
    //    trafienie jest autorytatywne; prefiks NAZWY nie jest — „SUN" jest
    //    prefiksem i SUNNET, i SUNTECHU, a remis w findByName rozstrzygała
    //    kolejność w indeksie katalogu. Stąd zgłoszenie 2026-08-23: Suntech
    //    („SUN.PL" z XTB) rozwiązywał się na SNN.WA (Sunnet).
    if (ncExact && rawCodeIsLive) {
      return {
        isin,
        ticker: `${ncExact.ticker}.WA`,
        name: ncExact.name,
        exchange: 'NC' as TickerMapEntry['exchange'],
        currency: 'PLN',
        priceSource: 'stooq',
      };
    }

    // 3. Dopasowanie po nazwie spółki w katalogu BR (full names: mBank, Tauron, Budimex)
    if (cleanName.length >= 3) {
      const brByName = await getBrCatalogService().findByName(cleanName);
      if (brByName) {
        const exchange = (brByName.exchange === 'NC' ? 'NC' : 'GPW') as TickerMapEntry['exchange'];
        return {
          isin,
          ticker: brByName.symbol,
          name: brByName.name,
          exchange,
          currency: 'PLN',
          priceSource: inferPriceSource(brByName.symbol, exchange),
        };
      }
    }

    // 4. NC offline fallback po NAZWIE — wyłącznie dla Bossy (sufiks -NC, np.
    //    "MINERAL" → MND). Dopasowanie kodem obsłużył krok 2; tutaj zostaje
    //    dawne, luźniejsze dopasowanie (prefiks nazwy), na które pozwala jedynie
    //    autorytatywny marker NewConnectu z pliku brokera.
    if (isNewConnect) {
      const ncByName = findNcTicker(cleanName);
      if (ncByName) {
        return {
          isin,
          ticker: `${ncByName.ticker}.WA`,
          name: ncByName.name,
          exchange: 'NC' as TickerMapEntry['exchange'],
          currency: 'PLN',
          priceSource: 'stooq',
        };
      }
    }

    // 5. Yahoo fallback — WYŁĄCZNIE listing .WA. Dla polskiego tickera (PLN) nigdy nie
    //    akceptujemy zagranicznego papieru: to samo 3-literowe oznaczenie bywa innym
    //    instrumentem na obcej giełdzie (EXC=Exelon/NASDAQ, CCC=CCC Intelligent/NASDAQ,
    //    MNS=Monster, DADA=PT Diamond/Dżakarta). Brak .WA hita → zwracamy null: wpis
    //    zostaje nierozwiązany i przy kolejnym imporcie/odświeżeniu (gdy Stooq odpowie)
    //    rozwiąże się poprawnie na notowanie warszawskie — lepsze niż zła cena z Yahoo.
    const byIsin = await searchYahoo(isin);
    const byIsinWa = byIsin.find((r) => r.symbol.endsWith('.WA'));
    if (byIsinWa) {
      return await buildEntry(
        isin,
        byIsinWa.symbol,
        byIsinWa.name,
        byIsinWa.exchange,
        paperName,
        txCurrency,
      );
    }

    if (cleanName !== isin) {
      const byName = await searchYahoo(cleanName);
      const byNameWa = byName.find((r) => r.symbol.endsWith('.WA'));
      if (byNameWa) {
        return await buildEntry(
          isin,
          byNameWa.symbol,
          byNameWa.name,
          byNameWa.exchange,
          paperName,
          txCurrency,
        );
      }
    }

    return null;
  }

  // === Non-Polish or real ISINs: Yahoo first ===

  // Alias (rebranding LUB notacja klasy akcji u brokera): jeśli znamy właściwy
  // symbol, pytamy Yahoo od razu o niego. Sprawdzamy też paperName, bo część
  // ścieżek (import uniwersalny) trzyma symbol tam, z sufiksem kraju włącznie.
  const foreignAlias = isPseudoIsin
    ? (lookupForeignAlias(isin) ?? lookupForeignAlias(paperName))
    : undefined;

  // Walidacja trafień Yahoo (patrz ticker-match.ts). GENEZA: zgłoszenie
  // 2026-07-20 — po zmianie tickera RELI→EZRA symbol zniknął z Yahoo, a
  // `byIsin[0]` podstawiło `RS | Reliance, Inc.` (dystrybutor stali z S&P 500)
  // i portfel pokazywał 395,93 USD zamiast 2,28 USD.
  //
  // Zakres celowo zawężony do ścieżki, którą zmierzono na produkcji:
  //  - isPseudoIsin  — ścieżka prawdziwych ISIN-ów (DeGiro/IBKR) niezmierzona;
  //  - !isPolishTicker — gałąź polska ma własny, osobny problem (ucinanie nazwy
  //    do 3 znaków w Strategy 2), naprawiany oddzielnie;
  //  - !cfdKnown     — mapa CFD rozwiązuje OIL→BZ=F, US500→ES=F, USDPLN→USDPLN=X,
  //    gdzie symbol z definicji nie przypomina zapytania.
  const cfdKnown = findCfdTicker(paperName) !== null || findCfdTicker(isin) !== null;
  const shouldValidate = isPseudoIsin && !isPolishTicker && !cfdKnown;
  const matchQueries = [foreignAlias, isin, paperName];

  // Strategy 0: pseudo-ISIN JEST już kanonicznym symbolem Yahoo (ma sufiks
  // giełdy) → pytamy o notowanie WPROST, zamiast szukać po wyszukiwarce.
  // GENEZA (zgłoszenie 2026-08-23, `SMSN.UK` → `SMSN.L`): wyszukiwarka na
  // zapytanie z sufiksem podsuwa sąsiedni listing (`SMSN.IL`), więc trafienie
  // nie jest dokładne i guard waluty odrzuca je — notowanie GDR-u jest w USD,
  // a etykieta z sufiksu `.UK` mówi GBP. Pozycja zostawała nierozpoznana, choć
  // ręczne dodanie tickera działało: `POST /transactions` idzie DOKŁADNIE tą
  // ścieżką (fetchYahooPrice + fetchYahooSymbolInfo).
  //
  // Guardu waluty tu nie ma świadomie — symbol jest dokładnie tym, o co
  // pytaliśmy (semantyka `isExactSymbolMatch`). Brak ceny → `null` i cofamy się
  // do Strategy 1 z pełnym kompletem guardów.
  const directSymbol = foreignAlias ?? (foreignSuffix ? isin : undefined);
  if (!cfdKnown && directSymbol && hasForeignYahooSuffix(directSymbol)) {
    // KOLEJNOŚĆ MA ZNACZENIE: najpierw potwierdzenie symbolu w wyszukiwarce,
    // dopiero potem cena. `fetchYahooSymbolInfo` wymaga DOKŁADNEJ zgodności
    // symbolu, więc odpowiada na pytanie „czy Yahoo w ogóle zna ten papier".
    // Sama cena z chart API tego nie dowodzi: dla `SMSN.UK` mapa sufiksów daje
    // `SMSN.L`, chart oddaje na to notowanie ~4× niższe od instrumentu, który
    // XTB faktycznie śledzi (GDR Samsunga to `SMSN.IL`), a wyszukiwarka symbolu
    // `SMSN.L` nie zna. Wpis powstawał więc z nazwą równą tickerowi — bezużyteczny
    // w UI i, przez kotwicę, nie do samonaprawienia (zgłoszenie 2026-08-23).
    let info: Awaited<ReturnType<typeof fetchYahooSymbolInfo>> = null;
    try {
      info = await fetchYahooSymbolInfo(directSymbol);
    } catch {
      info = null;
    }
    if (info?.name) {
      let quote: Awaited<ReturnType<typeof fetchYahooPrice>> = null;
      try {
        quote = await fetchYahooPrice(directSymbol);
      } catch {
        quote = null;
      }
      // Nazwę i giełdę mamy z potwierdzenia — zapisujemy je OD RAZU: dla
      // `exchange: 'OTHER'` późniejszy `backfillTickerNamesForPortfolio` już tu
      // nie zajrzy (patrz komentarz w scripts/backfill-ticker-exchange.ts).
      if (quote) {
        return await buildEntry(
          isin,
          directSymbol,
          info.name,
          info.exchange ?? undefined,
          paperName,
          txCurrency,
        );
      }
    }
  }

  // Strategy 1: Yahoo search by ISIN (exact identifier — reliable)
  const byIsin = await searchYahoo(foreignAlias ?? isin);
  if (byIsin.length > 0) {
    // Preferencja .WA: zarówno dla polskich tickerów (isPolishTicker) jak i dla dual-listed
    // spółek gdzie user kupuje przez GPW (txCurrency === 'PLN'). Przykład: GreenX Metals
    // (AU0000198939) — Yahoo zwraca [GRX.AX (Sydney AUD), GRX.WA (Warsaw PLN)]; user kupuje
    // przez Bossę w PLN, więc GRX.WA jest właściwe dla live prices i historii.
    // Symbol z sufiksem giełdy zagranicznej nie może wpaść w preferencję .WA
    // przez samą etykietę waluty (bywa nią waluta konta) — patrz `foreignSuffix`.
    const preferWa = !foreignSuffix && (isPolishTicker || txCurrency === 'PLN');
    if (preferWa) {
      const waHit = byIsin.find((r) => r.symbol.endsWith('.WA'));
      if (waHit) {
        return await buildEntry(
          isin,
          waHit.symbol,
          waHit.name,
          waHit.exchange,
          paperName,
          txCurrency,
        );
      }
    }
    // Polish ticker z pseudoISIN/realPL bez .WA hita → NIE akceptujemy zagranicznego listingu,
    // niżej Strategy 2 (Stooq) spróbuje znaleźć .WA po nazwie.
    if (!isPolishTicker) {
      // Ścieżka niewalidowana (realne ISIN-y, CFD) też WOLI wiarygodne trafienie:
      // gdy [0] nie pasuje ani symbolem, ani nazwą, a dalszy kandydat pasuje —
      // bierzemy kandydata. Fallback do [0] zachowuje dotychczasowe pokrycie
      // (zero utraconych rozpoznań), zmienia się wyłącznie WYBÓR spośród wyników.
      const hit = pickPlausible(byIsin, matchQueries) ?? (shouldValidate ? null : byIsin[0]);
      if (hit) {
        const entry = shouldValidate
          ? await buildEntryGuarded(isin, hit, paperName, txCurrency, matchQueries, foreignSuffix)
          : await buildEntry(isin, hit.symbol, hit.name, hit.exchange, paperName, txCurrency);
        // Odrzucenie przez guard waluty NIE kończy resolwowania — Strategy 3
        // (szukanie po nazwie) może jeszcze trafić właściwy listing.
        if (entry) return entry;
      }
      // Żadne trafienie nie odpowiada temu, o co pytaliśmy → NIE sięgamy po [0].
      // Niżej Strategy 3 spróbuje po nazwie; gdy i to zawiedzie, resolver zwróci
      // null, a import zapisze provisional stub (re-resolwowany przy kolejnym
      // imporcie). Lepiej zero ceny niż cudza cena.
    }
  }

  // Strategy 2: katalog BR check for real Polish ISINs BEFORE Yahoo name search.
  // This prevents Yahoo from matching "MINERAL" → NAK (Northern Dynasty)
  // when the actual stock is MINERAL-NC on NewConnect.
  if (isRealPolishIsin && cleanName.length >= 2) {
    // 2a. Dokładne dopasowanie tickera (short tickers: MNR, KBT, BCT) —
    //     z weryfikacją nazwy (skrócone kandydaty ≠ fałszywe trafienia,
    //     np. "MOL" = MOL Magyar, nie Molecure).
    const candidates = [cleanName];
    if (!cleanName.toUpperCase().startsWith('ETF') && !cleanName.toUpperCase().startsWith('BETA')) {
      if (cleanName.length > 4) candidates.push(cleanName.substring(0, 4));
      if (cleanName.length > 3) candidates.push(cleanName.substring(0, 3));
    }

    for (const candidate of candidates) {
      const brResult = await getBrCatalogService().findByTicker(candidate, cleanName);
      if (brResult) {
        const exchange = (
          isNewConnect || brResult.exchange === 'NC' ? 'NC' : 'GPW'
        ) as TickerMapEntry['exchange'];
        return {
          isin,
          ticker: brResult.symbol,
          name: brResult.name,
          exchange,
          currency: 'PLN',
          priceSource: inferPriceSource(brResult.symbol, exchange),
        };
      }
    }

    // 2b. Dopasowanie po nazwie spółki w katalogu BR (full names on GPW/NC)
    if (cleanName.length >= 3) {
      const brByName = await getBrCatalogService().findByName(cleanName);
      if (brByName) {
        const exchange = (brByName.exchange === 'NC' ? 'NC' : 'GPW') as TickerMapEntry['exchange'];
        return {
          isin,
          ticker: brByName.symbol,
          name: brByName.name,
          exchange,
          currency: 'PLN',
          priceSource: inferPriceSource(brByName.symbol, exchange),
        };
      }
    }
  }

  // Strategy 2c: NC offline fallback — static map prevents Yahoo from matching
  // NC stocks to wrong foreign tickers (e.g., MINERAL → NAK)
  if (isNewConnect && cleanName.length >= 2) {
    const ncEntry = findNcTicker(cleanName);
    if (ncEntry) {
      return {
        isin,
        ticker: `${ncEntry.ticker}.WA`,
        name: ncEntry.name,
        exchange: 'NC' as TickerMapEntry['exchange'],
        currency: 'PLN',
        priceSource: 'stooq',
      };
    }
  }

  // Strategy 3: Yahoo search by paper name (fallback for foreign stocks)
  if (cleanName.length >= 2) {
    const searchVariants = [cleanName];
    if (isPseudoIsin) {
      const split = splitEtfName(cleanName);
      if (split !== cleanName) searchVariants.push(split);
    }
    // Symbol z sufiksem giełdy: dokładamy SAM KOD. Wyszukiwarka Yahoo nie zna
    // każdego zapisu z sufiksem (`SMSN.L` nie zwraca nic), ale po samym kodzie
    // oddaje właściwy listing (`SMSN` → `SMSN.IL`, GDR Samsunga notowany w USD).
    // Tak samo szuka człowiek, gdy dodaje ticker ręcznie.
    if (foreignSuffix) {
      const base = baseTickerSymbol(isin);
      if (base && !searchVariants.includes(base)) searchVariants.push(base);
    }

    for (const variant of searchVariants) {
      const byName = await searchYahoo(variant);
      if (byName.length > 0) {
        if (isPolishTicker) {
          const waHit = byName.find((r) => r.symbol.endsWith('.WA'));
          if (waHit) {
            return await buildEntry(
              isin,
              waHit.symbol,
              waHit.name,
              waHit.exchange,
              paperName,
              txCurrency,
            );
          }
        } else {
          // Prefer-plausible jak w Strategy 1 — fallback [0] tylko na ścieżce
          // niewalidowanej.
          const hit = pickPlausible(byName, matchQueries) ?? (shouldValidate ? null : byName[0]);
          if (hit) {
            const entry = shouldValidate
              ? await buildEntryGuarded(
                  isin,
                  hit,
                  paperName,
                  txCurrency,
                  matchQueries,
                  foreignSuffix,
                )
              : await buildEntry(isin, hit.symbol, hit.name, hit.exchange, paperName, txCurrency);
            if (entry) return entry;
          }
          // Brak wiarygodnego trafienia — próbujemy kolejnego wariantu nazwy,
          // a ostatecznie zwracamy null zamiast cudzej spółki.
        }
      }
    }
  }

  // Ostatnia deska ratunku: jeśli dla polskiej akcji Yahoo nie zwrócił .WA ani Stooq nic
  // nie znalazł, ALE mamy gdzieś wynik zagraniczny z Yahoo (np. TSGAMES → 1HQ.SG) — użyjmy
  // go zamiast zwracać null. Wymaga to ponownego searchYahoo po ISIN (pierwszy byIsin poszedł
  // out of scope w try/catch powyżej).
  //
  // Trafienie MUSI przejść walidację jak wszędzie indziej — surowe [0] to dokładnie
  // wzorzec z genezy ticker-match, a Yahoo potrafi błędnie dopasować nawet realny
  // ISIN (US75960P1049 → Remitly zamiast Reliance Global). Docierają tu praktycznie
  // wyłącznie realne polskie ISIN-y (gałąź pseudo-PL zwraca null wcześniej), więc
  // przy chwilowej niedostępności katalogu BR [0] podstawiało losowy zagraniczny
  // papier pod polską spółkę. CELOWO bez guardu waluty: zagraniczny listing
  // polskiej spółki legalnie kwotuje w obcej walucie. Brak wiarygodnego trafienia
  // → null → provisional stub + self-heal (lepiej zero ceny niż cudza cena).
  if (isPolishTicker) {
    const byIsinRetry = await searchYahoo(isin);
    const hit = pickPlausible(byIsinRetry, [isin, paperName, cleanName]);
    if (hit) {
      return await buildEntry(isin, hit.symbol, hit.name, hit.exchange, paperName, txCurrency);
    }
  }

  return null;
}

/**
 * Prowizoryczny stub dla nierozwiązanego papieru z otwartą pozycją.
 * `ticker === name` (patrz isProvisionalStub) — self-heal ponawia rozpoznanie.
 *
 * Waluta idzie z TRANSAKCJI, nie z hardcode'u PLN: nierozwiązany walor USD
 * figurował jako polski (GPW/PLN/stooq) do czasu self-heala — zła waluta psuła
 * przewalutowanie ceny ręcznej/ostatniej transakcji w wycenie. Dla walut obcych
 * nie zgadujemy giełdy (`OTHER` to realny stan, nie błąd danych).
 */
export function buildProvisionalStub(u: {
  isin: string;
  paperName: string;
  currency: string;
}): TickerMapEntry {
  const currency = (u.currency || 'PLN').toUpperCase();
  const foreign = currency !== 'PLN';
  return {
    isin: u.isin,
    ticker: u.paperName,
    name: u.paperName,
    exchange: foreign ? 'OTHER' : 'GPW',
    currency,
    priceSource: foreign ? 'yahoo' : 'stooq',
  };
}

/**
 * Build a TickerMapEntry from a resolved Yahoo result.
 * Fetches the actual price to get the currency (Yahoo search doesn't return it).
 */
async function buildEntry(
  isin: string,
  ticker: string,
  name: string,
  yahooExchange: string | undefined,
  paperName: string,
  txCurrency: string,
): Promise<TickerMapEntry> {
  let exchange = inferExchange(ticker, yahooExchange);

  // NC override dla .WA: Yahoo/inferExchange domyślnie klasyfikuje wszystkie
  // .WA jako GPW, ale część polskich tickerów to NewConnect (np. SEV.WA = SEVENET).
  // Cross-check NC offline map: jeśli ticker base matches NC byTicker AND nazwa
  // (z Yahoo lub Stooq) matchuje NC entry name (substring obie strony) → NC.
  // Pokrywa case DEGIRO real ISIN + Yahoo trap (PLSEVNT00018 → SEV.WA), manual
  // entries z nazwą NC spółki, oraz każdy inny path który prowadzi do .WA.
  if (ticker.endsWith('.WA')) {
    const tickerBase = ticker.replace(/\.WA$/i, '').toUpperCase();
    const ncEntry = findNcTicker(tickerBase);
    if (ncEntry && ncEntry.ticker.toUpperCase() === tickerBase) {
      const yahooNameUpper = (name || '').toUpperCase();
      const ncNameUpper = ncEntry.name.toUpperCase();
      if (
        yahooNameUpper.includes(ncNameUpper) ||
        ncNameUpper.includes(yahooNameUpper) ||
        // Też matchuj jeśli paperName user'a pasuje (DEGIRO "Sevenet S.A." → SEVENET)
        paperName.toUpperCase().includes(ncNameUpper)
      ) {
        exchange = 'NC';
      }
    }
  }

  const priceSource = inferPriceSource(ticker, exchange);
  const resolvedName = name || paperName;

  // CFD-first: jeśli paperName/ticker pasuje do CFD_TICKER_MAP, używamy
  // statycznej kategoryzacji (Yahoo assetProfile i tak nie zwraca sensownego
  // sektora dla futures/forex/crypto).
  const cfdEntry = findCfdTicker(paperName) || findCfdTicker(ticker);
  if (cfdEntry) {
    return {
      isin,
      ticker,
      name: resolvedName,
      exchange,
      currency: cfdEntry.currency,
      priceSource,
      sector: undefined,
      supersector: getCfdSector(cfdEntry),
    };
  }

  // For .WA tickers, we know it's PLN — skip Yahoo price lookup,
  // ale sektor/supersektor próbujemy pobrać (stockwatch map + Yahoo fallback).
  if (ticker.endsWith('.WA')) {
    const { supersector, subsector, country } = await resolveSector({
      isin,
      ticker,
      name: resolvedName,
      exchange,
      currency: 'PLN',
      priceSource,
    }).catch(() => ({ supersector: null, subsector: null, country: 'Poland' }));
    return {
      isin,
      ticker,
      name: resolvedName,
      exchange,
      currency: 'PLN',
      priceSource,
      sector: subsector || undefined,
      supersector: supersector || undefined,
      country: country || undefined,
    };
  }

  // For other tickers, fetch currency (price) and klasyfikację sektorową w parallel.
  let currency = txCurrency;
  let subsector: string | null = null;
  let supersector: string | null = null;
  let country: string | null = null;
  try {
    const [priceData, sectors] = await Promise.all([
      fetchYahooPrice(ticker).catch(() => null),
      resolveSector({
        isin,
        ticker,
        name: resolvedName,
        exchange,
        currency: txCurrency,
        priceSource,
      }).catch(() => ({ supersector: null, subsector: null, country: null })),
    ]);
    if (priceData?.currency) currency = priceData.currency;
    subsector = sectors.subsector;
    supersector = sectors.supersector;
    country = sectors.country;
  } catch {
    // Fall back to transaction currency, no sector
  }

  return {
    isin,
    ticker,
    name: resolvedName,
    exchange,
    currency,
    priceSource,
    sector: subsector || undefined,
    supersector: supersector || undefined,
    country: country || undefined,
  };
}

/**
 * Resolve unknown ISINs from imported transactions.
 *
 * Compares ISINs in the transactions against the existing ticker_map,
 * then attempts to auto-resolve any that are missing via Yahoo Finance
 * and Stooq lookups. Resolved entries are persisted to the database.
 */
export async function resolveUnknownIsins(
  transactions: Transaction[],
  portfolioId: string,
): Promise<ResolveResult> {
  const existingMap = getTickerMap(portfolioId);

  // Collect unique ISINs with their paper names and currencies.
  // Re-attempt not only ISINs absent from the map, but also those anchored to a
  // provisional stub (an unresolved-debut placeholder) — so a fresh listing
  // self-heals on the next import once a price source finally lists it. A
  // successful resolution overwrites the stub (the anchor no longer protects it).
  const unknowns = new Map<string, { paperName: string; currency: string; category?: string }>();
  for (const tx of transactions) {
    const existing = existingMap.get(tx.isin);
    if ((!existing || isProvisionalStub(existing)) && !unknowns.has(tx.isin)) {
      unknowns.set(tx.isin, {
        paperName: tx.paperName,
        currency: tx.currency,
        category: tx.category,
      });
    }
  }

  if (unknowns.size === 0) {
    return { resolved: [], unresolved: [] };
  }

  console.log(`ISIN resolver: ${unknowns.size} unknown ISINs to resolve`);

  // Katalog BR musi być gotowy ZANIM zaczniemy rozpoznawać — inaczej polska gałąź
  // pyta pustą listę i dostaje „nie ma takiej spółki" zamiast „jeszcze nie wiem".
  // Ten sam wynik zapisuje się potem jako brak wpisu, a w ścieżce plików binarnych
  // (XTB/IBKR) nic tego nie ponawia. Zmierzone na produkcji: Allegro, PZU, JSW, LPP,
  // Kruk, Cyfrowy Polsat i Modivo bez ceny mimo poprawnych danych w katalogu.
  // No-op gdy katalog jest używalny; czekamy wyłącznie na start z pustki.
  await getBrCatalogService()
    .warmUp()
    .catch(() => {
      // Katalog niedostępny (biznesradar padł) — lecimy dalej, polskie papiery
      // zostaną nierozwiązane i zagoi je lazy pass przy kolejnym wejściu.
    });

  const resolved: TickerMapEntry[] = [];
  const unresolved: UnresolvedIsin[] = [];

  const items = Array.from(unknowns.entries());

  await mapWithConcurrency(items, 3, async ([isin, { paperName, currency, category }]) => {
    try {
      // Obligacje Catalyst: wpis bez requestów sieciowych (mapa/regex → Stooq).
      // Kategorię 'bond' ustawia parser, więc isBondInstrument na pewno przejdzie;
      // tryBondGuard w resolveIsin to ścieżka zapasowa (np. ręcznie dodane transakcje).
      if (category === 'bond') {
        const bondEntry = tryBondGuard(isin, paperName, currency);
        if (bondEntry) {
          upsertTickerMapEntry(bondEntry, portfolioId);
          resolved.push(bondEntry);
          console.log(`  ✓ ${isin} → ${bondEntry.ticker} (${bondEntry.name}) [BOND]`);
          return;
        }
        // category='bond' bez przejścia guardu nie powinno się zdarzyć — spadnij na zwykłą ścieżkę.
      }

      // CFD instruments: resolve via static map (Yahoo/Stooq search won't find them)
      if (category === 'cfd') {
        // Krypto/CFD zwykle mają w kolumnie symbolu ticker (np. Trade Republic: „BTC"),
        // nie ISIN — gdy ISIN nie trafia w mapę, próbujemy nazwy papieru
        // (np. „Bitcoin" → klucz BITCOIN → BTC-USD). Lustro ścieżki CFD-first wyżej.
        const cfdEntry = findCfdTicker(isin) || findCfdTicker(paperName);
        if (cfdEntry) {
          const entry: TickerMapEntry = {
            isin,
            ticker: cfdEntry.yahooTicker,
            name: cfdEntry.name,
            exchange: 'OTHER',
            currency: cfdEntry.currency,
            priceSource: 'yahoo',
          };
          upsertTickerMapEntry(entry, portfolioId);
          resolved.push(entry);
          console.log(`  ✓ ${isin} → ${entry.ticker} (${entry.name}) [CFD]`);
        } else {
          unresolved.push({ isin, paperName, currency });
          console.log(`  ✗ ${isin} (${paperName}) — unknown CFD instrument`);
        }
        return;
      }

      const entry = await resolveIsin(isin, paperName, currency);
      if (entry) {
        upsertTickerMapEntry(entry, portfolioId);
        resolved.push(entry);
        console.log(`  ✓ ${isin} → ${entry.ticker} (${entry.name})`);
      } else {
        unresolved.push({ isin, paperName, currency });
        console.log(`  ✗ ${isin} (${paperName}) — could not resolve`);
      }
    } catch (error) {
      console.error(`  ✗ ${isin} (${paperName}) — error:`, error);
      unresolved.push({ isin, paperName, currency });
    }
  });

  console.log(`ISIN resolver: ${resolved.length} resolved, ${unresolved.length} unresolved`);
  return { resolved, unresolved };
}
