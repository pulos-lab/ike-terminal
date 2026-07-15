/**
 * Pobranie i parsowanie strony SZCZEGÓŁÓW pojedynczej obligacji z obligacje.pl
 * (`/pl/obligacja/<TICKER>`) — do self-healu on-demand podczas importu (Etap 2 #167).
 *
 * KLUCZOWE: strona detalu istnieje także dla serii, których wyszukiwarka NIE listuje
 * (wykupione, nienotowane w oknie scrapera — np. BST0728). Regexy ISIN/nominał są te same,
 * które od dawna działają w scraperze `scrape-catalyst-bonds.ts`; nazwę emitenta, datę wykupu,
 * typ kuponu i serię czytamy dodatkowo (potwierdzone na realnym HTML BST0728).
 */
import { TREASURY_BOND_RE, type BondMapEntry } from 'shared';

const DETAIL_URL = (ticker: string) => `https://obligacje.pl/pl/obligacja/${ticker}`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

/** Kod obligacji Catalyst: 2-4 wielkie litery + 4 cyfry (MMRR, np. BST0728, DS1030). */
export const CATALYST_TICKER_RE = /^[A-Z]{2,4}\d{4}$/;

function parseCouponType(raw: string | undefined): 'fixed' | 'floating' | 'zero' | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower.includes('stał')) return 'fixed';
  if (lower.includes('zmienn')) return 'floating';
  if (lower.includes('zerokupon') || lower.includes('dyskont')) return 'zero';
  return undefined;
}

/** Zapadalność z tickera MMRR jako fallback, gdy strona nie poda daty ISO. */
function maturityFromTicker(ticker: string): string | null {
  const m = ticker.match(/^[A-Z]{2,4}(\d{2})(\d{2})$/);
  if (!m) return null;
  const month = m[1];
  const year = m[2];
  if (Number(month) < 1 || Number(month) > 12) return null;
  return `20${year}-${month}-01`;
}

/**
 * Parsuje HTML strony detalu do `BondMapEntry`. Zwraca null, gdy brak wiarygodnego
 * ISIN + nominału (strona nieistniejąca / nie-obligacja). Czysta funkcja — testowalna
 * bez sieci.
 */
export function parseBondDetailHtml(html: string, ticker: string): BondMapEntry | null {
  const upper = ticker.toUpperCase().trim();
  const isinMatch = html.match(/ISIN:<\/th>\s*<td>([A-Z0-9]+)<\/td>/);
  // "Wartość nominalna:</th> <td>100.00 PLN</td>" — spacje tysięcy, kropka dziesiętna
  const nominalMatch = html.match(/Wartość nominalna:<\/th>\s*<td>([\d\s .,]+)\s+([A-Z]{3})<\/td>/);
  if (!isinMatch || !nominalMatch) return null;
  const nominal = parseFloat(nominalMatch[1].replace(/[\s ]/g, '').replace(',', '.'));
  if (!Number.isFinite(nominal) || nominal <= 0) return null;

  const nameMatch = html.match(/Emitent:<\/th>\s*<td>\s*<a[^>]*>([^<]+)<\/a>/);
  const name = nameMatch ? nameMatch[1].trim() : upper;

  const seriesMatch = html.match(/Seria:<\/th>\s*<td>([^<]*)<\/td>/i);
  const series = seriesMatch && seriesMatch[1].trim() ? seriesMatch[1].trim() : undefined;

  const couponTypeRaw = html.match(/Typ oprocentowania:<\/th>\s*<td>([^<]+)<\/td>/i)?.[1];
  const couponType = parseCouponType(couponTypeRaw);

  // Data wykupu: sekcja "<h4>Dzień wykupu</h4> ... <li>YYYY-MM-DD</li>". Fallback z tickera.
  const maturityMatch = html.match(/Dzień wykupu<\/h4>[\s\S]{0,300}?<li>(\d{4}-\d{2}-\d{2})<\/li>/);
  const maturityDate = maturityMatch ? maturityMatch[1] : (maturityFromTicker(upper) ?? '');

  const segment: BondMapEntry['segment'] =
    TREASURY_BOND_RE.test(upper) || name.toLowerCase().includes('skarb państwa')
      ? 'treasury'
      : 'corporate';

  return {
    isin: isinMatch[1],
    ticker: upper,
    name,
    nominal,
    currency: nominalMatch[2],
    maturityDate,
    segment,
    ...(couponType ? { couponType } : {}),
    ...(series ? { series } : {}),
  };
}

export interface FetchBondDetailOptions {
  fetchFn?: typeof fetch;
}

/**
 * Pobiera i parsuje detal obligacji z obligacje.pl. Zwraca `BondMapEntry` albo null
 * (nieistniejąca seria / błąd sieci / nie-obligacja). NIGDY nie rzuca — import ma
 * przejść nawet gdy obligacje.pl jest niedostępne.
 */
export async function fetchBondDetail(
  ticker: string,
  opts: FetchBondDetailOptions = {},
): Promise<BondMapEntry | null> {
  const upper = ticker.toUpperCase().trim();
  if (!CATALYST_TICKER_RE.test(upper)) return null;
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const resp = await fetchFn(DETAIL_URL(upper), { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return null;
    const html = await resp.text();
    return parseBondDetailHtml(html, upper);
  } catch {
    return null;
  }
}
