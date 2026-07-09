/**
 * Ekstraktor tabel z wyciągu IBKR Activity Statement (HTML).
 *
 * Struktura pliku (zweryfikowana na wyciągach 2021-2025, konta IB Central Europe i IB Ireland):
 * - każda sekcja to `<div id="tbl{Name}_U{acct}Body">` z jedną lub kilkoma `<table>`;
 *   UWAGA: część sekcji nie ma podkreślnika przed numerem konta (np. `tblContractInfoU6474045Body`),
 *   dlatego selektor musi tolerować oba warianty;
 * - wiersze danych w Trades mają klasę `row-summary`, ale w Transfers/ContractInfo są BEZ klasy —
 *   jedyna niezawodna reguła to wykluczanie wierszy `subtotal`/`total` i wierszy-nagłówków;
 * - nagłówki kategorii aktywów ("Stocks", "Equity and Index Options", ...) i waluty ("USD") to
 *   wiersze z pojedynczą komórką `colspan` — ustawiają kontekst dla kolejnych wierszy danych;
 * - zestaw kolumn tej samej sekcji różni się między latami (np. ContractInfo ma kolumnę
 *   "Underlying" dopiero od 2024) — konsument musi mapować komórki po nazwach nagłówków.
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

/** Wiersz danych z kontekstem sekcji (kategoria aktywów + waluta z nagłówków grupujących). */
export interface IbkrRow {
  assetClass?: string;
  currency?: string;
  cells: string[];
}

export interface IbkrTable {
  headers: string[];
  rows: IbkrRow[];
}

/** Kategorie aktywów rozpoznawane w nagłówkach grupujących sekcji. */
const ASSET_CLASS_HEADERS = new Set([
  'Stocks',
  'Equity and Index Options',
  'Bonds',
  'Forex',
  'CFDs',
  'Warrants',
  'Other Fees',
  'Futures',
]);

/** Waluta ISO 4217 lub specjalne nagłówki podsumowań walutowych. */
const CURRENCY_RE = /^[A-Z]{3}$/;

function normalizeCell(text: string): string {
  // &nbsp; z cheerio przychodzi jako  ; IBKR używa go jako pustej komórki i separatora
  return text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Zwraca wszystkie tabele sekcji o podanej nazwie (np. 'Transactions', 'ContractInfo').
 * Sekcja może nie istnieć w danym roku (np. CorporateActions) — wtedy [].
 */
export function extractSectionTables(html: string, sectionName: string): IbkrTable[] {
  const $ = cheerio.load(html);
  const idRe = new RegExp(`^tbl${sectionName}_?U\\d+Body$`);
  const bodies = $('div').filter((_, el) => idRe.test($(el).attr('id') ?? ''));
  const tables: IbkrTable[] = [];

  bodies.each((_, body) => {
    $(body)
      .find('table')
      .each((_, tableEl) => {
        const table = extractTable($, tableEl);
        if (table.headers.length > 0 || table.rows.length > 0) tables.push(table);
      });
  });

  return tables;
}

function extractTable($: cheerio.CheerioAPI, tableEl: AnyNode): IbkrTable {
  let headers: string[] = [];
  const rows: IbkrRow[] = [];
  let assetClass: string | undefined;
  let currency: string | undefined;

  $(tableEl)
    .find('tr')
    .each((_, tr) => {
      const $tr = $(tr);
      const cls = $tr.attr('class') ?? '';
      // Wiersze podsumowań — pomijamy (dane per waluta/symbol liczymy sami)
      if (/\b(subtotal|total)\b/.test(cls)) return;

      const ths = $tr.children('th');
      if (ths.length > 0) {
        // Ostatni wiersz <th> wygrywa — sekcje z wieloma tabelami mają własne nagłówki per tabela
        headers = ths.map((_, th) => normalizeCell($(th).text())).get();
        return;
      }

      const tds = $tr.children('td');
      if (tds.length === 0) return;
      const cells = tds.map((_, td) => normalizeCell($(td).text())).get();

      // Wiersz grupujący: jedna komórka (zwykle colspan) z kategorią aktywów lub walutą
      if (tds.length === 1) {
        const label = cells[0];
        const firstCls = $(tds[0]).attr('class') ?? '';
        if (ASSET_CLASS_HEADERS.has(label) || /header-asset/.test(firstCls)) {
          assetClass = label;
          currency = undefined;
        } else if (CURRENCY_RE.test(label) || /header-currency/.test(firstCls)) {
          currency = label;
        }
        // Inne jednokomórkowe wiersze (np. "Base Currency Summary", notki) — pomijamy
        return;
      }

      // Wiersz danych — pomiń całkowicie puste
      if (cells.every((c) => c === '')) return;
      rows.push({ assetClass, currency, cells });
    });

  return { headers, rows };
}

/**
 * Mapuje komórki wiersza na rekord po nazwach nagłówków. Sekcje IBKR zmieniają zestaw kolumn
 * między latami — dostęp po nazwie jest odporny, po indeksie NIE.
 * Gdy komórek jest mniej niż nagłówków (rzadkie wiersze skrócone), brakujące pola są pomijane.
 */
export function cellsToRecord(headers: string[], cells: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < headers.length && i < cells.length; i++) {
    if (headers[i]) record[headers[i]] = cells[i];
  }
  return record;
}

/**
 * Parsuje liczbę w notacji IBKR: przecinek jako separator tysięcy, kropka dziesiętna,
 * minus dla ujemnych ("−1,076.52" → -1076.52). Puste / "--" → null.
 */
export function parseIbkrNumber(raw: string): number | null {
  const cleaned = raw.replace(/ /g, ' ').trim();
  if (cleaned === '' || cleaned === '--' || cleaned === '-') return null;
  const num = Number(cleaned.replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

/**
 * Parsuje datę IBKR: "2024-01-15, 10:30:05" → "2024-01-15T10:30:05"; "2024-01-15" → bez zmian.
 * Czas zachowujemy — wchodzi do klucza deduplikacji transakcji.
 */
export function parseIbkrDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})(?:,\s*(\d{2}:\d{2}:\d{2}))?$/);
  if (!m) return null;
  return m[2] ? `${m[1]}T${m[2]}` : m[1];
}
