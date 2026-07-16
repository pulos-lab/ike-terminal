import type { Transaction, TickerMapEntry } from 'shared';
import {
  findNcTicker,
  findCfdTicker,
  getCfdSector,
  isBondInstrument,
  findBondByIsin,
  findBondByTicker,
} from 'shared';
import { getTickerMap, upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import { searchYahoo } from './ticker-search.js';
import { getBrCatalogService } from './biznesradar-catalog.js';
import { fetchYahooPrice } from './yahoo-finance.js';
import { resolveSector } from './sector-resolver.js';
import { mapWithConcurrency } from './concurrency.js';
import { normalizeBossaPaperName, isNewConnectPaperName } from './stooq-utils.js';

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
function inferExchange(ticker: string, yahooExchange?: string): TickerMapEntry['exchange'] {
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

// Stooq ticker aliases for renamed/rebranded Polish companies (old ticker → current Stooq ticker)
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
  SUN: 'MIG', // Sundragon → Military Group (2025)
  PGM: 'GNS', // Polska Grupa Motoryzacyjna → Grupa Niewiadów (2025)
  PUN: 'RAE', // PunkPirates → Raen (2023)
  BRZ: 'HUB', // Boruta-Zachem → Hub.Tech (2022)
  MCP: 'BEL', // Medcamp → BeLeaf (2022)
  IQP: 'PUN', // IQ Partners → PunkPirates (2020)
  '7FT': 'OML', // 7Fit → One More Level (2020)
  BSP: 'IVO', // Baltic Storage → Incuvo (2020)
  ZAK: 'PDG', // Zaks → Pyramid Games (2019)
  SKN: 'SIM', // Skin-System → SimFabric (2019)
  BLU: 'CLC', // Blumerang Pre-IPO → Columbus Energy (2018)
};

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
  const isPolishTicker =
    isRealPolishIsin || isin.endsWith('.WA') || (isPseudoIsin && txCurrency === 'PLN');

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

    // 1. Dokładne dopasowanie tickera w katalogu BR (short tickers: PGE, CDR, JSW, DNP)
    const candidates = [aliasedName];
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

    // 2. Dopasowanie po nazwie spółki w katalogu BR (full names: mBank, Tauron, Budimex)
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

    // 3. NC offline fallback — statyczna mapa NC PRZED Yahoo (zapobiega błędnym
    //    dopasowaniom zagranicznym). Uruchamiamy dla KAŻDEGO polskiego pseudo-ISINu
    //    z dokładnym dopasowaniem kodu tickera, nie tylko dla nazw z sufiksem -NC:
    //    XTB/mBank podają symbol jako "EXC.WA" bez markera NC, więc gdy Stooq jest
    //    rate-limitowany kroki 1-2 zawodzą i bez tego kod spadał do Yahoo, łapiąc
    //    zagraniczną kolizję o tym samym oznaczeniu (EXC → Exelon Corp, USD). Ticker
    //    jest unikalny w obrębie GPW+NewConnect, więc dokładne trafienie kodu w mapę
    //    NC jest autorytatywne. Dla Bossa (-NC, dopasowanie po NAZWIE spółki, np.
    //    "MINERAL" → MND) zachowujemy dawne zachowanie przez warunek isNewConnect.
    const ncFallback = findNcTicker(cleanName);
    if (ncFallback) {
      const exactTickerMatch = ncFallback.ticker.toUpperCase() === cleanName.toUpperCase();
      if (isNewConnect || exactTickerMatch) {
        return {
          isin,
          ticker: `${ncFallback.ticker}.WA`,
          name: ncFallback.name,
          exchange: 'NC' as TickerMapEntry['exchange'],
          currency: 'PLN',
          priceSource: 'stooq',
        };
      }
    }

    // 4. Yahoo fallback — WYŁĄCZNIE listing .WA. Dla polskiego tickera (PLN) nigdy nie
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

  // Strategy 1: Yahoo search by ISIN (exact identifier — reliable)
  const byIsin = await searchYahoo(isin);
  if (byIsin.length > 0) {
    // Preferencja .WA: zarówno dla polskich tickerów (isPolishTicker) jak i dla dual-listed
    // spółek gdzie user kupuje przez GPW (txCurrency === 'PLN'). Przykład: GreenX Metals
    // (AU0000198939) — Yahoo zwraca [GRX.AX (Sydney AUD), GRX.WA (Warsaw PLN)]; user kupuje
    // przez Bossę w PLN, więc GRX.WA jest właściwe dla live prices i historii.
    const preferWa = isPolishTicker || txCurrency === 'PLN';
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
      return await buildEntry(
        isin,
        byIsin[0].symbol,
        byIsin[0].name,
        byIsin[0].exchange,
        paperName,
        txCurrency,
      );
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
          return await buildEntry(
            isin,
            byName[0].symbol,
            byName[0].name,
            byName[0].exchange,
            paperName,
            txCurrency,
          );
        }
      }
    }
  }

  // Ostatnia deska ratunku: jeśli dla polskiej akcji Yahoo nie zwrócił .WA ani Stooq nic
  // nie znalazł, ALE mamy gdzieś wynik zagraniczny z Yahoo (np. TSGAMES → 1HQ.SG) — użyjmy
  // go zamiast zwracać null. Wymaga to ponownego searchYahoo po ISIN (pierwszy byIsin poszedł
  // out of scope w try/catch powyżej).
  if (isPolishTicker) {
    const byIsinRetry = await searchYahoo(isin);
    if (byIsinRetry.length > 0) {
      return await buildEntry(
        isin,
        byIsinRetry[0].symbol,
        byIsinRetry[0].name,
        byIsinRetry[0].exchange,
        paperName,
        txCurrency,
      );
    }
  }

  return null;
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

  // Collect unique ISINs with their paper names and currencies
  const unknowns = new Map<string, { paperName: string; currency: string; category?: string }>();
  for (const tx of transactions) {
    if (!existingMap.has(tx.isin) && !unknowns.has(tx.isin)) {
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
        const cfdEntry = findCfdTicker(isin);
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
