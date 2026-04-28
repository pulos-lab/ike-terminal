/* eslint-disable no-console */
/**
 * One-shot scraper: generuje shared/src/gpw-sector-map.ts z listy sektorów
 * stockwatch.pl/gpw/sektory (40 podsektorów × 8 nadsektorów).
 *
 * Używa wyłącznie publicznych stron HTML (bez API), z delayem 500 ms między
 * requestami.  Wygenerowany plik jest commitowany — runtime nigdy nie uderza
 * do stockwatch.
 *
 * Run:  npm run scrape:gpw-sectors -w server
 */

import * as cheerio from 'cheerio';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const INDEX_URL = 'https://www.stockwatch.pl/gpw/sektory';
const BASE = 'https://www.stockwatch.pl';
const DELAY_MS = 500;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return await resp.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Z index'u wyciągamy listę { url, supersector, subsector } — 40 wpisów.
 * Parsujemy wiersze tabeli gdzie link do /gpw/sektory/*.aspx ma tekst
 * "Nadsektor: Podsektor".
 */
function parseIndex(html: string): Array<{ url: string; supersector: string; subsector: string }> {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: Array<{ url: string; supersector: string; subsector: string }> = [];
  $('a[href^="/gpw/sektory/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.endsWith('.aspx')) return;
    const text = $(el).text().trim();
    const m = text.match(/^([^:]+):\s*(.+)$/);
    if (!m) return;
    const url = BASE + href;
    if (seen.has(url)) return;
    seen.add(url);
    let supersector = m[1].trim();
    let subsector = m[2].trim();
    // Normalizacja: stockwatch czasem używa pełnej nazwy "Produkcja przemysłowa
    // i budowlano-montażowa" — skracamy do "Produkcja przemysłowa" dla czytelności.
    if (supersector.startsWith('Produkcja przemysłowa')) supersector = 'Produkcja przemysłowa';
    // "Pozostałe - Dobra konsumpcyjne" → "Pozostałe" (kontekst z nadsektora)
    subsector = subsector.replace(/\s*-\s*(Dobra konsumpcyjne|Ochrona zdrowia)\s*$/, '');
    out.push({ url, supersector, subsector });
  });
  return out;
}

/**
 * Z podstrony sektora wyciągamy listę spółek. Struktura: linki z id
 * `ctl00_Body_StocksSector1_CompaniesList_ctlNN_StockListItem1_h1`
 * o hrefie `/gpw/SLUG,notowania,wskazniki.aspx`, tekst = pełna nazwa firmy.
 */
function parseSectorPage(html: string): Array<{ ticker: string; name: string }> {
  const $ = cheerio.load(html);
  const out: Array<{ ticker: string; name: string }> = [];
  const seen = new Set<string>();
  $('a[id*="CompaniesList"][id*="StockListItem"][href*=",notowania,wskazniki.aspx"]').each(
    (_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/^\/gpw\/([a-z0-9-]+),notowania,wskazniki\.aspx$/i);
      if (!m) return;
      const slug = m[1].toUpperCase();
      if (seen.has(slug)) return;
      seen.add(slug);
      const name = $(el).text().trim();
      out.push({ ticker: slug, name });
    },
  );
  return out;
}

function tsStringLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function main() {
  console.log('[scrape] Fetching index', INDEX_URL);
  const indexHtml = await fetchHtml(INDEX_URL);
  const sectors = parseIndex(indexHtml);
  console.log(`[scrape] Found ${sectors.length} sectors`);

  const map: Record<string, { supersector: string; subsector: string; name: string }> = {};
  const supersectorSet = new Set<string>();
  let totalCompanies = 0;

  for (const { url, supersector, subsector } of sectors) {
    supersectorSet.add(supersector);
    console.log(`[scrape] ${supersector}: ${subsector} — ${url}`);
    await sleep(DELAY_MS);
    try {
      const html = await fetchHtml(url);
      const companies = parseSectorPage(html);
      console.log(`[scrape]   → ${companies.length} companies`);
      for (const c of companies) {
        totalCompanies++;
        // Jeśli spółka występuje w kilku podsektorach (rzadko), preferuj pierwsze
        // napotkane; stockwatch domyślnie nie duplikuje między nadsektorami.
        if (!map[c.ticker]) {
          map[c.ticker] = { supersector, subsector, name: c.name };
        }
      }
    } catch (err) {
      console.error(`[scrape] Failed for ${url}:`, (err as Error).message);
    }
  }

  console.log(
    `[scrape] Total unique tickers: ${Object.keys(map).length} (processed ${totalCompanies})`,
  );

  // Build TypeScript output, sorted by ticker dla deterministycznych diffów.
  const sortedKeys = Object.keys(map).sort();
  const supersectorsSorted = Array.from(supersectorSet).sort();

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(
    '// GENERATED by server/scripts/scrape-gpw-sectors.ts on ' + today + ' — do not edit by hand.',
  );
  lines.push('// Źródło: https://www.stockwatch.pl/gpw/sektory');
  lines.push('');
  lines.push('export interface GpwSectorEntry {');
  lines.push('  supersector: string;');
  lines.push('  subsector: string;');
  lines.push('  name: string;');
  lines.push('}');
  lines.push('');
  lines.push('export const GPW_SUPERSECTORS = [');
  for (const s of supersectorsSorted) {
    lines.push(`  ${tsStringLiteral(s)},`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('/** Klucz: ticker stockwatch uppercase (np. "PKOBP", "CDR", "11B"). */');
  lines.push('export const GPW_SECTOR_MAP: Record<string, GpwSectorEntry> = {');
  for (const k of sortedKeys) {
    const v = map[k];
    lines.push(
      `  ${tsStringLiteral(k)}: { supersector: ${tsStringLiteral(v.supersector)}, subsector: ${tsStringLiteral(v.subsector)}, name: ${tsStringLiteral(v.name)} },`,
    );
  }
  lines.push('};');
  lines.push('');
  lines.push('/** Reverse lookup: name (lowercase) → ticker. */');
  lines.push('export const GPW_NAME_TO_TICKER: Record<string, string> = (() => {');
  lines.push('  const out: Record<string, string> = {};');
  lines.push('  for (const [ticker, entry] of Object.entries(GPW_SECTOR_MAP)) {');
  lines.push('    out[entry.name.toLowerCase()] = ticker;');
  lines.push('  }');
  lines.push('  return out;');
  lines.push('})();');
  lines.push('');

  const outPath = resolve(process.cwd(), '../shared/src/gpw-sector-map.ts');
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(
    `[scrape] Wrote ${outPath} (${Object.keys(map).length} entries, ${supersectorsSorted.length} supersectors)`,
  );
}

main().catch((err) => {
  console.error('[scrape] Fatal:', err);
  process.exit(1);
});
