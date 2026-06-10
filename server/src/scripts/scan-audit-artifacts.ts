/**
 * READ-ONLY skan baz portfeli pod kątem danych zapisanych przez błędy
 * naprawione w audycie 2026-06 (PR #58-#71). Niczego nie modyfikuje.
 *
 * Wykrywa:
 *  1. Auto-splity z datą detekcji zamiast realnej daty splitu (stary detektor
 *     zapisywał date = "dzisiaj"; sygnatura: split_date == data z detected_at).
 *  2. Syntetyczne SELL z resolve akcji korporacyjnych z currency != PLN, ale
 *     payment_currency = PLN (stary hardcode).
 *  3. Portfele-kandydaci do reconcile-all-portfolios (transakcje walutowe
 *     Bossa/Degiro — stary reconciler mógł zapisać złą klasyfikację waluty).
 *  4. Sygnatura prowizji XTB "same-second": >1 transakcja tego samego ISIN-u
 *     z identycznym timestampem, w tym dokładnie jedna z prowizją > 0
 *     (stary parser doklejał obie prowizje do pierwszej transakcji).
 *
 * Usage (lokalnie):  cd server && npx tsx src/scripts/scan-audit-artifacts.ts
 * Usage (prod VPS):  DATA_DIR=/opt/ike-terminal/data node server/dist/scripts/scan-audit-artifacts.js
 */

import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db']);

function listPortfolioDbs(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => join(config.dataDir, e.name));
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  return !!row;
}

let affectedPortfolios = 0;

for (const dbPath of listPortfolioDbs()) {
  const pid = basename(dbPath, '.db');
  const db = new Database(dbPath, { readonly: true });
  const findings: string[] = [];

  try {
    // ── 1. Auto-splity z datą detekcji ──
    if (hasTable(db, 'stock_splits')) {
      const splits = db
        .prepare(
          `SELECT isin, ticker, split_date, ratio, detected_at
             FROM stock_splits
            WHERE source = 'auto'
              AND split_date = substr(detected_at, 1, 10)`,
        )
        .all() as Array<{
        isin: string;
        ticker: string;
        split_date: string;
        ratio: number;
        detected_at: string;
      }>;
      for (const s of splits) {
        // Czy portfel ma transakcje PO zapisanej dacie (świeżo dotknięte korektą)?
        const post = db
          .prepare(`SELECT COUNT(*) AS c FROM transactions WHERE isin = ? AND date > ?`)
          .get(s.isin, s.split_date) as { c: number };
        const pre = db
          .prepare(`SELECT COUNT(*) AS c FROM transactions WHERE isin = ? AND date <= ?`)
          .get(s.isin, s.split_date) as { c: number };
        findings.push(
          `  [1] AUTO-SPLIT z datą detekcji: ${s.ticker} (${s.isin}) ratio=${s.ratio} ` +
            `split_date=${s.split_date} (detected_at=${s.detected_at}) — ` +
            `tx przed/po tej dacie: ${pre.c}/${post.c}` +
            (pre.c > 0 && post.c > 0 ? '  ⚠️ PORTFEL MIESZANY — korekta po złej dacie' : ''),
        );
      }
    }

    // ── 2. Syntetyczne SELL z payment_currency = PLN przy walucie obcej ──
    const synth = db
      .prepare(
        `SELECT id, date, paper_name, currency, payment_currency, total, synthetic_origin
           FROM transactions
          WHERE synthetic_origin IS NOT NULL
            AND upper(currency) != 'PLN'
            AND upper(coalesce(payment_currency, currency)) = 'PLN'`,
      )
      .all() as Array<{
      id: number;
      date: string;
      paper_name: string;
      currency: string;
      total: number;
      synthetic_origin: string;
    }>;
    for (const t of synth) {
      findings.push(
        `  [2] SYNTETYCZNY SELL z błędnym rozliczeniem PLN: #${t.id} ${t.paper_name} ` +
          `${t.date.slice(0, 10)} ${t.total} ${t.currency} (${t.synthetic_origin})`,
      );
    }

    // ── 3. Kandydaci do reconcile-all-portfolios ──
    const fxCandidates = db
      .prepare(
        `SELECT source, COUNT(*) AS c FROM transactions
          WHERE source IN ('bossa', 'degiro') AND upper(currency) != 'PLN'
          GROUP BY source`,
      )
      .all() as Array<{ source: string; c: number }>;
    for (const r of fxCandidates) {
      findings.push(
        `  [3] Kandydat do reconcile-all: ${r.c} transakcji walutowych źródła '${r.source}'`,
      );
    }

    // ── 4. Sygnatura XTB same-second commissions ──
    const sameSecond = db
      .prepare(
        `SELECT date, isin, COUNT(*) AS n,
                SUM(CASE WHEN commission > 0 THEN 1 ELSE 0 END) AS with_comm
           FROM transactions
          WHERE source = 'xtb'
          GROUP BY date, isin, side
         HAVING n > 1 AND with_comm = 1`,
      )
      .all() as Array<{ date: string; isin: string; n: number; with_comm: number }>;
    for (const r of sameSecond) {
      findings.push(
        `  [4] XTB same-second: ${r.n} transakcji ${r.isin} @ ${r.date}, ` +
          `prowizja tylko na jednej — możliwa skumulowana prowizja na pierwszej`,
      );
    }
  } finally {
    db.close();
  }

  if (findings.length > 0) {
    affectedPortfolios++;
    console.log(`\n━━ Portfel: ${pid} ━━`);
    for (const f of findings) console.log(f);
  } else {
    console.log(`\n━━ Portfel: ${pid} ━━\n  OK — brak artefaktów starych błędów`);
  }
}

console.log(
  `\n══════════\nPortfele z artefaktami: ${affectedPortfolios}. ` +
    `Legenda: [1] re-detekcja splitów, [2] korekta payment_currency syntetyków, ` +
    `[3] reconcile-all-portfolios, [4] clear+reimport XTB.`,
);
