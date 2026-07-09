import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-ibkr-'));
process.env.DATA_DIR = tmpDir;

// ISIN-resolver strzela do Yahoo/Stooq — w teście integracyjnym importu mockujemy
// (seeding ticker_map dla opcji dzieje się PRZED resolverem i jest przedmiotem testu).
vi.mock('../isin-resolver.js', () => ({
  resolveUnknownIsins: vi.fn().mockResolvedValue({ resolved: [], unresolved: [] }),
}));

/**
 * Kompaktowy Activity Statement IBKR (struktura z realnych plików 2021-2025):
 * kupno akcji CCIV, short opcji, split AMZN, zmiana ISIN CCIV→LCID, FTT, wpłata.
 */
const row = (cells: string[], cls = 'row-summary no-details') =>
  `<tr class="${cls}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const header = (label: string, kind: 'asset' | 'currency', colspan: number) =>
  `<tr><td class="header-${kind}" colspan="${colspan}">${label}</td></tr>`;
const thead = (cols: string[]) =>
  `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;

const IBKR_HTML = `
<html><body>
<div>Activity Statement</div><div>Interactive Brokers Central Europe Zrt.</div>
<div id="tblAccountInformation_U6474045Body"><table><tbody>
<tr><td>Account</td><td>U6474045</td></tr>
<tr><td>Base Currency</td><td>PLN</td></tr>
</tbody></table></div>
<div id="tblTransactions_U6474045Body"><table>
${thead(['Symbol', 'Date/Time', 'Quantity', 'T. Price', 'C. Price', 'Proceeds', 'Comm/Fee', 'Basis', 'Realized P/L', 'MTM P/L', 'Code'])}
<tbody>
${header('Stocks', 'asset', 11)}
${header('USD', 'currency', 11)}
${row(['CCIV', '2021-03-01, 10:00:00', '85', '20.00', '20.00', '-1,700.00', '-1.00', '1,701.00', '0.00', '0.00', 'O'])}
${header('EUR', 'currency', 11)}
${row(['UBI', '2021-10-07, 09:00:00', '47', '41.00', '41.00', '-1,927.00', '-3.00', '1,930.00', '0.00', '0.00', 'O'])}
${header('Equity and Index Options', 'asset', 11)}
${header('USD', 'currency', 11)}
${row(['DKNG 20MAY22 60.0 P', '2021-11-04, 10:05:18', '-1', '16.3200', '17.9483', '1,632.00', '-0.68', '-1,631.32', '0.00', '-162.83', 'O'])}
</tbody></table></div>
<div id="tblCombDepWithU6474045Body"><table>
${thead(['Date', 'Description', 'Amount'])}
<tbody>
${header('PLN', 'currency', 3)}
${row(['2021-07-16', 'Electronic Fund Transfer', '3,000.00'], '')}
</tbody></table></div>
<div id="tblCorporateActions_U6474045Body"><table>
${thead(['Report Date', 'Date/Time', 'Description', 'Quantity', 'Proceeds', 'Value', 'Realized P/L', 'Code'])}
<tbody>
${header('Stocks', 'asset', 8)}
${header('USD', 'currency', 8)}
${row(['2022-06-06', '2022-06-03, 20:25:00', 'AMZN(US0231351067) Split 20 for 1 (AMZN, AMAZON.COM INC, US0231351067)', '19', '0.00', '0.00', '0.00', '&nbsp;'], '')}
${row(['2021-07-26', '2021-07-23, 20:25:00', 'CCIV(US1714391026) CUSIP/ISIN Change to (US5494981039) (CCIV, CHURCHILL CAPITAL CORP IV-A, US1714391026)', '-85', '0.00', '0.00', '0.00', '&nbsp;'], '')}
${row(['2021-07-26', '2021-07-23, 20:25:00', 'CCIV(US1714391026) CUSIP/ISIN Change to (US5494981039) (LCID, LUCID GROUP INC, US5494981039)', '85', '0.00', '0.00', '0.00', '&nbsp;'], '')}
</tbody></table></div>
<div id="tblTransactionsTax_U6474045Body"><table>
${thead(['Date/Time', 'Symbol', 'Description', 'Quantity', 'Trade Price', 'Amount', 'Code'])}
<tbody>
${header('Stocks', 'asset', 7)}
${header('EUR', 'currency', 7)}
${row(['2021-10-07', 'UBI', 'French Transaction Tax', '0', '0.0000', '-2.36', '&nbsp;'], '')}
</tbody></table></div>
<div id="tblContractInfoU6474045Body">
<table>
${thead(['Symbol', 'Description', 'Conid', 'Security ID', 'Listing Exch', 'Multiplier', 'Type', 'Code'])}
<tbody>
${header('Stocks', 'asset', 8)}
${row(['CCIV', 'CHURCHILL CAPITAL CORP IV-A', '1', 'US1714391026', 'NYSE', '1', 'COMMON', '&nbsp;'], '')}
${row(['UBI', 'UBISOFT ENTERTAINMENT', '2', 'FR0000054470', 'SBF', '1', 'COMMON', '&nbsp;'], '')}
</tbody></table>
<table>
${thead(['Symbol', 'Description', 'Conid', 'Listing Exch', 'Multiplier', 'Expiry', 'Delivery Month', 'Type', 'Strike', 'Code'])}
<tbody>
${header('Equity and Index Options', 'asset', 10)}
${row(['DKNG  220520P00060000', 'DKNG 20MAY22 60.0 P', '3', 'CBOE', '100', '2022-05-20', '2022-05', 'P', '60', '&nbsp;'], '')}
</tbody></table>
</div>
</body></html>`;

const PID = 'test-ibkr-import';

describe('bulkImport — pliki IBKR HTML (ścieżka combined)', () => {
  let bulkImport: typeof import('../import-service.js').bulkImport;
  let classifyFile: typeof import('../import-service.js').classifyFile;
  let txRepo: typeof import('../../db/transactions-repo.js');
  let opsRepo: typeof import('../../db/operations-repo.js');
  let tickerRepo: typeof import('../../db/ticker-map-repo.js');
  let optionsRepo: typeof import('../../db/option-contracts-repo.js');
  let splitsRepo: typeof import('../../db/splits-repo.js');
  let connection: typeof import('../../db/connection.js');

  beforeAll(async () => {
    ({ bulkImport, classifyFile } = await import('../import-service.js'));
    txRepo = await import('../../db/transactions-repo.js');
    opsRepo = await import('../../db/operations-repo.js');
    tickerRepo = await import('../../db/ticker-map-repo.js');
    optionsRepo = await import('../../db/option-contracts-repo.js');
    splitsRepo = await import('../../db/splits-repo.js');
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const file = () => ({
    buffer: Buffer.from(IBKR_HTML, 'utf-8'),
    originalname: 'U6474045_2021.htm',
  });

  it('classifyFile rozpoznaje HTML IBKR jako combined transactions', async () => {
    const classified = await classifyFile(file());
    expect(classified.broker).toBe('ibkr');
    expect(classified.role).toBe('transactions');
    expect(classified.isBinary).toBe(true);
  });

  it('importuje transakcje, operacje i markery reconciliation', async () => {
    const result = await bulkImport({ transactionsFiles: [file()], portfolioId: PID });
    expect(result.success).toBe(true);
    expect(result.detectedSource).toBe('ibkr');
    expect(result.transactionsImported).toBe(3); // CCIV, UBI, opcja
    expect(result.operationsImported).toBe(1); // deposit

    // Zmiana ISIN: transakcja CCIV przepisana na nowy ISIN LCID
    const txs = txRepo.getAllTransactions(PID);
    expect(txs.some((t) => t.isin === 'US5494981039')).toBe(true);
    expect(txs.some((t) => t.isin === 'US1714391026')).toBe(false);

    // FTT doliczony do prowizji UBI: 3.00 + 2.36 = 5.36
    const ubi = txs.find((t) => t.isin === 'FR0000054470')!;
    expect(ubi.commission).toBeCloseTo(5.36, 2);
    expect(result.taxesApplied).toBe(1);

    // Split AMZN zapisany z realną ex-datą i source manual
    const splits = splitsRepo.getSplits(PID);
    expect(splits).toContainEqual(
      expect.objectContaining({
        isin: 'US0231351067',
        splitDate: '2022-06-03',
        ratio: 20,
        source: 'manual',
      }),
    );

    // Kontrakt opcyjny + seeding ticker_map (ticker OCC, priceSource yahoo)
    const contracts = optionsRepo.getOptionContractsMap(PID);
    const contract = contracts.get('OPT:DKNG220520P00060000')!;
    expect(contract).toMatchObject({ underlying: 'DKNG', strike: 60, multiplier: 100 });
    const tmEntry = tickerRepo.getTickerByIsin('OPT:DKNG220520P00060000', PID)!;
    expect(tmEntry.ticker).toBe('DKNG220520P00060000');
    expect(tmEntry.priceSource).toBe('yahoo');

    // Short opcyjny NIE generuje warningu orphaned sells
    expect(result.orphanedSells ?? []).toEqual([]);
  });

  it('re-import tego samego pliku jest idempotentny (dedup, ON CONFLICT, applied_taxes)', async () => {
    const result = await bulkImport({ transactionsFiles: [file()], portfolioId: PID });
    expect(result.success).toBe(true);
    expect(result.transactionsImported).toBe(0);
    expect(result.operationsImported).toBe(0);
    expect(result.duplicatesSkipped).toBe(4); // 3 tx + 1 ops
    expect(result.taxesApplied).toBeUndefined(); // applied_transaction_taxes UNIQUE

    const ubi = txRepo.getAllTransactions(PID).find((t) => t.isin === 'FR0000054470')!;
    expect(ubi.commission).toBeCloseTo(5.36, 2); // prowizja nie urosła drugi raz

    expect(splitsRepo.getSplits(PID)).toHaveLength(1);
    expect(opsRepo.getAllOperations(PID)).toHaveLength(1);
  });
});
