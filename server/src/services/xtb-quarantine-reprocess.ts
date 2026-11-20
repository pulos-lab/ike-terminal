/**
 * Ponowne przetworzenie wierszy XTB ze skrzynki „Do wyjaśnienia", które parser
 * odrzucił przez komentarz z tickerem ("OPEN BUY DIG.PL 1 @ 308.80", format od
 * ~10.2026, naprawiony w PR #267).
 *
 * Plików importu nie przechowujemy, ale kwarantanna trzyma CAŁY surowy wiersz
 * (nagłówki + komórki w kanonicznym układzie OLD EN: ID | Type | Time | Comment |
 * Symbol | Amount) oraz nazwę pliku (prefiks IKE_/PLN_/USD_ = waluta konta).
 * Z tego odtwarzamy jednowierszowy arkusz i przepuszczamy go przez ten sam
 * `parseXtbFile`, którego używa import — zero równoległej logiki parsowania.
 *
 * Każdy wiersz parsowany jest OSOBNO: daje to jednoznaczne powiązanie
 * transakcja ↔ wiersz skrzynki, a wszystko, czego potrzebuje transakcja
 * akcyjna (ilość, cena, kwota, symbol), leży w samym wierszu. Prowizje NIE są
 * dopinane — przy imporcie weszły jako osobny koszt (brak transakcji do
 * podpięcia), więc saldo gotówki już się zgadza.
 *
 * Insert idzie przez `insertTransactionsWithDedup` (licznikowy dedup, źródła
 * `manual`/`generic` liczą się jako wildcard) — transakcja dodana wcześniej
 * ręcznie z dialogu skrzynki nie zdubluje się. Identyczne partial fille
 * (3× "CLOSE BUY VRC.PL 1/3") wstawiamy w JEDNYM wywołaniu, żeby dedup policzył
 * krotność, a nie uznał kolejnych za duplikat pierwszego.
 */

import ExcelJS from 'exceljs';
import type { Transaction } from 'shared';
import { getDb } from '../db/connection.js';
import { insertTransactionsWithDedup } from '../db/transactions-repo.js';
import { resolveQuarantineRow } from '../db/quarantine-repo.js';
import { parseXtbFile } from '../parsers/xtb-transactions.js';

/** Komentarz w nowym formacie: ticker między "BUY" a ilością. */
const NEW_FORMAT_RE = /(?:OPEN|CLOSE) BUY [A-Z0-9][\w.-]* [\d.]/;

const RESOLVE_NOTE = 'auto: ponowne przetworzenie po poprawce parsera XTB (PR #267)';

interface QuarantineRow {
  id: number;
  import_batch: string;
  file_name: string | null;
  status: string;
  headers_json: string | null;
  raw_cells_json: string;
}

export interface ReprocessItem {
  quarantineId: number;
  status: string;
  importBatch: string;
  fileName: string | null;
  comment: string;
  tx?: Transaction;
  /** Powód, dla którego wiersza nie da się zaksięgować automatycznie. */
  error?: string;
}

export interface ReprocessResult {
  items: ReprocessItem[];
  /** Wiersze pokryte transakcją już obecną w portfelu (np. dodaną ręcznie). */
  alreadyPresent: number;
  inserted: number;
  resolved: number;
}

function cell(cells: string[], headers: string[], name: string): string {
  const i = headers.indexOf(name);
  return i >= 0 ? (cells[i] ?? '') : '';
}

/** Jednowierszowy arkusz XTB w układzie OLD EN. Czas MUSI być Date — tekst
 *  "2026-10-22T12:22:28" parser wziąłby za numer seryjny Excela (parseFloat → 2026). */
async function buildSingleRowWorkbook(headers: string[], cells: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('CASH OPERATION HISTORY');
  ws.addRow(headers);
  ws.addRow(
    headers.map((h, i) => {
      const v = cells[i] ?? '';
      if (h === 'Time') return new Date(`${v}Z`);
      if (h === 'Amount' || h === 'ID') {
        const n = Number(v);
        return v !== '' && Number.isFinite(n) ? n : v;
      }
      return v;
    }),
  );
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** Kategoria z istniejących transakcji tego papieru — jednowierszowy arkusz nie
 *  ma „Closed Positions", z którego parser bierze ETF/STOCK. */
function existingCategory(portfolioId: string, isin: string): Transaction['category'] | undefined {
  const row = getDb(portfolioId)
    .prepare(
      `SELECT category FROM transactions WHERE isin = ? AND category IS NOT NULL
       GROUP BY category ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get(isin) as { category: Transaction['category'] } | undefined;
  return row?.category;
}

async function parseRow(row: QuarantineRow, portfolioId: string): Promise<ReprocessItem> {
  const headers = JSON.parse(row.headers_json ?? '[]') as string[];
  const cells = JSON.parse(row.raw_cells_json) as string[];
  const comment = cell(cells, headers, 'Comment');
  const base: ReprocessItem = {
    quarantineId: row.id,
    status: row.status,
    importBatch: row.import_batch,
    fileName: row.file_name,
    comment,
  };
  if (!headers.includes('Time') || !headers.includes('Comment')) {
    return { ...base, error: `nieoczekiwane nagłówki: ${headers.join(' | ')}` };
  }

  const buf = await buildSingleRowWorkbook(headers, cells);
  const { transactions } = await parseXtbFile(buf, row.import_batch, row.file_name ?? undefined);
  if (transactions.data.length !== 1 || transactions.skipped.length > 0) {
    const reason = transactions.skipped[0]?.reason ?? `${transactions.data.length} transakcji`;
    return { ...base, error: `parser nie dał jednej transakcji (${reason})` };
  }

  const tx = transactions.data[0];
  const category = existingCategory(portfolioId, tx.isin);
  if (category) tx.category = category;
  return { ...base, tx };
}

function dedupKey(tx: Transaction): string {
  return `${tx.date}|${tx.isin}|${tx.side}|${tx.quantity}|${tx.price}`;
}

/**
 * Przetwarza kwalifikujące się wiersze jednego portfela. Bez `apply` niczego
 * nie zapisuje — zwraca podgląd (z liczbą wierszy już pokrytych w portfelu).
 * Transakcje do resolwera tickerów zwraca w `items[].tx` — wywołujący decyduje,
 * czy odpalić rozpoznawanie (sieć) po zapisie.
 */
export async function reprocessXtbQuarantine(
  portfolioId: string,
  opts: { apply: boolean },
): Promise<ReprocessResult> {
  const db = getDb(portfolioId);
  const rows = (
    db
      .prepare(
        `SELECT id, import_batch, file_name, status, headers_json, raw_cells_json
         FROM import_quarantine
         WHERE source = 'xtb' AND reason = 'unparseable_comment'
           AND status IN ('pending', 'reported')
         ORDER BY id`,
      )
      .all() as QuarantineRow[]
  ).filter((r) => NEW_FORMAT_RE.test(r.raw_cells_json));

  const items: ReprocessItem[] = [];
  for (const row of rows) items.push(await parseRow(row, portfolioId));

  const ok = items.filter((i): i is ReprocessItem & { tx: Transaction } => !!i.tx);
  const groups = new Map<string, typeof ok>();
  for (const item of ok) {
    const key = dedupKey(item.tx);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  // Ten sam warunek co dedup przy imporcie (źródło xtb + wildcardy manual/generic/NULL).
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS cnt FROM transactions
     WHERE date = ? AND isin = ? AND side = ? AND quantity = ? AND price = ?
       AND (source IS NULL OR source IN ('xtb', 'manual', 'generic'))`,
  );
  let alreadyPresent = 0;
  for (const group of groups.values()) {
    const t = group[0].tx;
    const { cnt } = countStmt.get(t.date, t.isin, t.side, t.quantity, t.price) as { cnt: number };
    alreadyPresent += Math.min(cnt, group.length);
  }

  if (!opts.apply || ok.length === 0) {
    return { items, alreadyPresent, inserted: 0, resolved: 0 };
  }

  let inserted = 0;
  let resolved = 0;
  db.transaction(() => {
    // Każda transakcja niesie import_batch swojego wiersza (parser dostał go
    // wprost) — usunięcie batcha w UI usuwa też to, co tu dołożymy.
    inserted = insertTransactionsWithDedup(
      ok.map((i) => i.tx),
      portfolioId,
    ).inserted;
    for (const item of ok) {
      if (
        resolveQuarantineRow(
          item.quarantineId,
          { kind: 'transaction', note: RESOLVE_NOTE },
          portfolioId,
        )
      ) {
        resolved++;
      }
    }
  })();

  return { items, alreadyPresent, inserted, resolved };
}
