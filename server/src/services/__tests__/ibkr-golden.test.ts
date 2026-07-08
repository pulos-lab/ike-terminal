import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as cheerio from 'cheerio';

/**
 * Golden test na REALNYCH wyciągach IBKR (2 konta, 2021-2025).
 *
 * Pliki są prywatne i nie siedzą w repo — test jest SKIPPOWANY, gdy katalog
 * `IBKR_IMPORT_DIR` (default: <repo>/import/ibkr) nie istnieje. Lokalnie:
 *   npm run test -w server -- --run ibkr-golden
 *
 * Najmocniejsza asercja: saldo gotówki per waluta liczone z zaimportowanych
 * transakcji+operacji musi się zgadzać z sekcją Cash Report każdego wyciągu
 * (Ending - Starting, sumowane przez lata). To weryfikuje end-to-end kompletność
 * WSZYSTKICH przepływów: transakcje, prowizje (też forex w walucie bazowej),
 * dywidendy+WHT, odsetki margin, kupony, opłaty, FTT, Sales Tax, wpłaty/wypłaty.
 */

const IBKR_DIR = process.env.IBKR_IMPORT_DIR ?? path.resolve(__dirname, '../../../../import/ibkr');
const hasFiles =
  fs.existsSync(IBKR_DIR) && fs.readdirSync(IBKR_DIR).some((f) => f.endsWith('.htm'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-golden-ibkr-'));
process.env.DATA_DIR = tmpDir;

// Golden test weryfikuje import i księgowość — nie sieciowe resolvowanie tickerów.
vi.mock('../isin-resolver.js', () => ({
  resolveUnknownIsins: vi.fn().mockResolvedValue({ resolved: [], unresolved: [] }),
}));

/** Delta salda per waluta z sekcji Cash Report (Ending − Starting), bez Base Currency Summary. */
function cashReportDeltas(html: string): Map<string, number> {
  const $ = cheerio.load(html);
  const deltas = new Map<string, number>();
  $('div')
    .filter((_, el) => /^tblCashReport_?U\d+Body$/.test($(el).attr('id') ?? ''))
    .find('tr')
    .each((_, tr) => {
      const cells = $(tr)
        .children('td')
        .map((_, td) => $(td).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim())
        .get();
      if (cells.length === 1) {
        const label = cells[0];
        (cashReportDeltas as any).cur = /^[A-Z]{3}$/.test(label) ? label : null;
        return;
      }
      const cur = (cashReportDeltas as any).cur as string | null;
      if (!cur || cells.length < 2) return;
      if (cells[0] === 'Starting Cash' || cells[0] === 'Ending Cash') {
        const v = Number(cells[1].replace(/,/g, ''));
        if (!Number.isFinite(v)) return;
        const sign = cells[0] === 'Ending Cash' ? 1 : -1;
        deltas.set(cur, (deltas.get(cur) ?? 0) + sign * v);
      }
    });
  return deltas;
}

describe.skipIf(!hasFiles)('IBKR golden — import 6 realnych wyciągów', () => {
  const PID = 'golden-ibkr';
  let files: Array<{ buffer: Buffer; originalname: string }>;
  let result: import('shared').ImportResult;
  let txRepo: typeof import('../../db/transactions-repo.js');
  let opsRepo: typeof import('../../db/operations-repo.js');
  let optRepo: typeof import('../../db/option-contracts-repo.js');
  let splitsRepo: typeof import('../../db/splits-repo.js');
  let engine: typeof import('../portfolio-engine.js');
  let connection: typeof import('../../db/connection.js');
  let bulkImport: typeof import('../import-service.js').bulkImport;

  beforeAll(async () => {
    ({ bulkImport } = await import('../import-service.js'));
    txRepo = await import('../../db/transactions-repo.js');
    opsRepo = await import('../../db/operations-repo.js');
    optRepo = await import('../../db/option-contracts-repo.js');
    splitsRepo = await import('../../db/splits-repo.js');
    engine = await import('../portfolio-engine.js');
    connection = await import('../../db/connection.js');
    files = fs
      .readdirSync(IBKR_DIR)
      .filter((f) => f.endsWith('.htm'))
      .sort()
      .map((f) => ({ buffer: fs.readFileSync(path.join(IBKR_DIR, f)), originalname: f }));
    result = await bulkImport({ transactionsFiles: files, portfolioId: PID });
  }, 60_000);

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('import przechodzi bez błędów i bez pominiętych wierszy', () => {
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.detectedSource).toBe('ibkr');
    // Skipped dopuszczone tylko dla duplikatów (=0 przy świeżej bazie)
    expect((result.skipped ?? []).filter((s) => s.reason !== 'duplicate')).toEqual([]);
  });

  it('sumy kontrolne: liczba transakcji per kategoria i operacji per typ', () => {
    const txs = txRepo.getAllTransactions(PID);
    const byCat: Record<string, number> = {};
    for (const t of txs) byCat[t.category ?? 'stock'] = (byCat[t.category ?? 'stock'] ?? 0) + 1;
    // Zamrożone po pierwszym uruchomieniu na plikach 2021-2025 (zmiana = regresja parsera
    // albo nowe pliki w katalogu — wtedy zaktualizuj świadomie).
    expect(byCat).toEqual({ stock: 742, etf: 11, option: 131, bond: 2 });

    const ops = opsRepo.getAllOperations(PID);
    const byType: Record<string, number> = {};
    for (const o of ops) byType[o.operationType] = (byType[o.operationType] ?? 0) + 1;
    expect(byType['deposit']).toBe(58);
    expect(byType['withdrawal']).toBe(13);
    expect(byType['fx_exchange']).toBe(44 * 2); // 44 przewalutowania × 2 nogi
    expect(byType['dividend']).toBeGreaterThanOrEqual(60);
    expect(result.taxesApplied).toBe(4); // francuski FTT (UBI)
  });

  it('markery: 5 splitów z realnymi ex-datami, zmiany ISIN zaaplikowane, 69 kontraktów opcyjnych', () => {
    const splits = splitsRepo.getSplits(PID);
    expect(splits.map((s) => `${s.ticker}@${s.splitDate}=${s.ratio}`).sort()).toEqual([
      'AMZN@2022-06-03=20',
      'GOOGL@2022-07-15=20',
      'MCHP@2021-10-12=2',
      'SHOP@2022-06-28=10',
      'SPCE@2024-06-14=0.05',
    ]);
    const txs = txRepo.getAllTransactions(PID);
    // CCIV→LCID i SPCE.OLD→SPCE: stare ISIN-y nie mogą istnieć po imporcie
    expect(txs.some((t) => t.isin === 'US1714391026')).toBe(false);
    expect(txs.some((t) => t.isin === 'US92766K1060')).toBe(false);
    expect(optRepo.getOptionContractsMap(PID).size).toBe(69);
  });

  it('KLUCZOWE: saldo gotówki per waluta zgadza się z Cash Report wyciągów (±0.25)', () => {
    const expected = new Map<string, number>();
    for (const f of files) {
      const deltas = cashReportDeltas(f.buffer.toString('utf-8'));
      for (const [cur, d] of deltas) expected.set(cur, (expected.get(cur) ?? 0) + d);
    }
    const balances = engine.computeCashBalances(
      txRepo.getAllTransactions(PID),
      opsRepo.getAllOperations(PID),
    );
    for (const [cur, exp] of expected) {
      // Tolerancja 0.25: zaokrąglenia totali do 2 miejsc kumulują się przy setkach
      // transakcji (zmierzone: max 0.11 USD na 463k USD obrotu).
      expect
        .soft(
          Math.abs((balances[cur] ?? 0) - exp),
          `saldo ${cur}: ours=${balances[cur]} stmt=${exp}`,
        )
        .toBeLessThan(0.25);
    }
  });

  it('otwarte pozycje opcyjne zgadzają się z sekcją Open Positions ostatniego wyciągu', async () => {
    const txs = txRepo.getAllTransactions(PID);
    const { positions } = await engine.computeOpenPositions(txs, new Map(), [], undefined, {
      skipSplitDetection: true,
      optionContracts: optRepo.getOptionContractsMap(PID),
    });
    const options = positions.filter((p) => p.category === 'option');
    // Wyciąg U16474045_2025: 8 otwartych pozycji opcyjnych (wszystkie long puty)
    const byLabel = new Map(options.map((p) => [p.paperName, p.shares]));
    expect(byLabel.get('OKLO 17DEC27 15 P')).toBe(7);
    expect(byLabel.get('OKLO 17DEC27 20 P')).toBe(3);
    expect(byLabel.get('QBTS 16JAN26 10 P')).toBe(5);
    expect(byLabel.get('RGTI 15JAN27 7 P')).toBe(5);
    expect(options).toHaveLength(8);
    // Wszystkie zamknięte/wygasłe/przydzielone kontrakty NIE wiszą jako pozycje
    expect(options.every((p) => p.shares !== 0)).toBe(true);
  });

  it('re-import wszystkich plików jest w pełni idempotentny', async () => {
    const again = await bulkImport({ transactionsFiles: files, portfolioId: PID });
    expect(again.success).toBe(true);
    expect(again.transactionsImported).toBe(0);
    expect(again.operationsImported).toBe(0);
    expect(splitsRepo.getSplits(PID)).toHaveLength(5);
  }, 60_000);
});
