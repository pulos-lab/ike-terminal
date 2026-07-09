import { describe, it, expect } from 'vitest';
import { parseIbkrFile, isIbkrFormat } from '../ibkr/index.js';

/**
 * Syntetyczny Activity Statement odwzorowujący realne przypadki z wyciągów 2021-2025:
 * akcje (w tym fractional), opcje (sell-to-open, wygaśnięcie C;Ep, assignment A;C + noga
 * akcyjna A;O po strike), obligacja UST (qty=nominał, cena w %), forex, dywidenda+WHT
 * (+ reversal), odsetki margin, SYEP, kupon obligacji, accrued interest, opłata market data,
 * wpłata, split, reverse split ze zmianą ISIN, zmiana CUSIP/ISIN, transfer Inter-Company, FTT.
 */

const row = (cells: string[], cls = 'row-summary no-details') =>
  `<tr class="${cls}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const header = (label: string, kind: 'asset' | 'currency', colspan = 11) =>
  `<tr><td class="header-${kind}" colspan="${colspan}">${label}</td></tr>`;
const thead = (cols: string[]) =>
  `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;

const TRADES_COLS = [
  'Symbol',
  'Date/Time',
  'Quantity',
  'T. Price',
  'C. Price',
  'Proceeds',
  'Comm/Fee',
  'Basis',
  'Realized P/L',
  'MTM P/L',
  'Code',
];

const FIXTURE = `
<html><body>
<div>Activity Statement</div><div>Interactive Brokers Central Europe Zrt.</div>
<div id="tblAccountInformation_U6474045Body"><table><tbody>
<tr><td>Account</td><td>U6474045</td></tr>
<tr><td>Base Currency</td><td>PLN</td></tr>
</tbody></table></div>
<div id="tblTransactions_U6474045Body"><table>
${thead(TRADES_COLS)}
<tbody>
${header('Stocks', 'asset')}
${header('USD', 'currency')}
${row(['GLOB', '2022-07-22, 09:52:06', '2.8', '197.13285714', '194.5500', '-551.97', '-0.35', '552.32', '0.00', '-7.23', 'FPA;O;P'])}
${row(['PYPL', '2022-04-18, 16:20:00', '100', '230.0000', '103.6600', '-23,000.00', '0.00', '23,000.00', '0.00', '-12,634.00', 'A;O'])}
${row(['XXX', '2022-05-01, 10:00:00', '5', '10.00', '10.00', '-50.00', '-1.00', '51.00', '0.00', '0.00', 'Ca'])}
${header('EUR', 'currency')}
${row(['UBI', '2021-10-07, 09:00:00', '47', '41.00', '41.00', '-1,927.00', '-3.00', '1,930.00', '0.00', '0.00', 'O'])}
${header('Equity and Index Options', 'asset')}
${header('USD', 'currency')}
${row(['EDU 19NOV21 3.0 C', '2021-10-12, 10:17:55', '-3', '0.2000', '0.1250', '60.00', '-2.08', '-57.92', '0.00', '22.50', 'O'])}
${row(['EDU 19NOV21 3.0 C', '2021-11-19, 16:20:00', '3', '0.0000', '0.0000', '0.00', '0.00', '57.92', '57.92', '0.00', 'C;Ep'])}
${row(['PYPL 17JUN22 230.0 P', '2022-04-18, 16:20:00', '1', '0.0000', '126.3466', '0.00', '0.00', '2,551.31', '0.00', '12,634.66', 'A;C'])}
${header('Bonds', 'asset')}
${header('USD', 'currency')}
${row(['T 2 7/8 05/15/32 3.92547561%', '2022-10-13, 12:07:48', '2,000', '91.422275', '91.40625', '-1,828.45', '-5.00', '1,833.45', '0.00', '-0.32', 'O'])}
${header('Forex', 'asset')}
${header('PLN', 'currency')}
${row(['USD.PLN', '2022-03-17, 06:23:59', '1,270', '4.24497', '&nbsp;', '-5,391.11', '-8.45', '&nbsp;', '&nbsp;', '-26.25', '&nbsp;'])}
</tbody></table></div>
<div id="tblCombDivU6474045Body"><table>
${thead(['Date', 'Description', 'Amount'])}
<tbody>
${header('USD', 'currency', 3)}
${row(['2021-11-09', 'MA(US57636Q1040) Cash Dividend USD 0.44 per Share (Ordinary Dividend)', '1.32'], '')}
${row(['2021-12-01', 'GHI(US1111111117) Cash Dividend USD 1.00 per Share (Ordinary Dividend)', '5.00'], '')}
${row(['2021-12-01', 'GHI(US1111111117) Cash Dividend USD 1.00 per Share (Ordinary Dividend)', '-5.00'], '')}
</tbody></table></div>
<div id="tblWithholdingTax_U6474045Body"><table>
${thead(['Date', 'Description', 'Amount', 'Code'])}
<tbody>
${header('USD', 'currency', 4)}
${row(['2021-11-09', 'MA(US57636Q1040) Cash Dividend USD 0.44 per Share - US Tax', '-0.20', '&nbsp;'], '')}
${row(['2021-12-15', 'OLD(US2222222225) Cash Dividend USD 2.00 per Share - US Tax', '0.31', '&nbsp;'], '')}
</tbody></table></div>
<div id="tblCombIntU6474045Body"><table>
${thead(['Date', 'Description', 'Amount'])}
<tbody>
${header('USD', 'currency', 3)}
${row(['2022-10-13', 'Purchase Accrued Interest T 2 7/8 05/15/32', '-23.75'], '')}
${row(['2022-11-15', 'Bond Coupon Payment (T 2 7/8 05/15/32 - United States Treasury T 2 7/8 05/15/32)', '28.75'], '')}
${row(['2022-12-05', 'USD Investment Loan Interest for Nov-2022', '-2.34'], '')}
</tbody></table></div>
<div id="tblBrokerFeesU6474045Body"><table>
${thead(['Date', 'Description', 'Amount', 'Code'])}
<tbody>
${header('USD', 'currency', 4)}
${row(['2021-09-03', 'USD IBKR Managed Securities (SYEP) Fees for Aug-2021', '4.17', '&nbsp;'], '')}
${row(['2021-08-04', 'USD Stock Borrow Fees for Jul-2021', '-0.04', '&nbsp;'], '')}
</tbody></table></div>
<div id="tblCombFeesU6474045Body"><table>
${thead(['Date', 'Description', 'Amount'])}
<tbody>
${header('Other Fees', 'asset', 3)}
${header('PLN', 'currency', 3)}
${row(['2021-07-20', 'l******32:NYSE Level I for Jul 2021', '-5.82'], '')}
</tbody></table></div>
<div id="tblCombDepWithU6474045Body"><table>
${thead(['Date', 'Description', 'Amount'])}
<tbody>
${header('PLN', 'currency', 3)}
${row(['2021-07-16', 'Electronic Fund Transfer', '3,000.00'], '')}
${row(['2024-02-01', 'Electronic Fund Transfer', '-500.00'], '')}
</tbody></table></div>
<div id="tblCorporateActions_U6474045Body"><table>
${thead(['Report Date', 'Date/Time', 'Description', 'Quantity', 'Proceeds', 'Value', 'Realized P/L', 'Code'])}
<tbody>
${header('Stocks', 'asset', 8)}
${header('USD', 'currency', 8)}
${row(['2022-06-06', '2022-06-03, 20:25:00', 'AMZN(US0231351067) Split 20 for 1 (AMZN, AMAZON.COM INC, US0231351067)', '19', '0.00', '0.00', '0.00', '&nbsp;'], '')}
${row(['2024-06-17', '2024-06-14, 20:25:00', 'SPCE(US92766K1060) Split 1 for 20 (SPCE, VIRGIN GALACTIC HOLDINGS INC, US92766K4031)', '5', '0.00', '0.00', '0.00', '&nbsp;'], '')}
${row(['2024-06-17', '2024-06-14, 20:25:00', 'SPCE(US92766K1060) Split 1 for 20 (SPCE.OLD, VIRGIN GALACTIC HOLDINGS INC, US92766K1060)', '-100', '0.00', '0.00', '0.00', '&nbsp;'], '')}
${row(['2021-07-26', '2021-07-23, 20:25:00', 'CCIV(US1714391026) CUSIP/ISIN Change to (US5494981039) (CCIV, CHURCHILL CAPITAL CORP IV-A, US1714391026)', '-85', '0.00', '0.00', '0.00', '&nbsp;'], '')}
${row(['2021-07-26', '2021-07-23, 20:25:00', 'CCIV(US1714391026) CUSIP/ISIN Change to (US5494981039) (LCID, LUCID GROUP INC, US5494981039)', '85', '0.00', '0.00', '0.00', '&nbsp;'], '')}
</tbody></table></div>
<div id="tblAccountTransfers_U6474045Body"><table>
${thead(['Symbol', 'Date', 'Type', 'Direction', 'Xfer Company', 'Xfer Account', 'Qty', 'Xfer Price', 'Market Value', 'Realized P/L', 'Cash Amount', 'Code'])}
<tbody>
${header('Stocks', 'asset', 12)}
${header('EUR', 'currency', 12)}
${row(['UBI', '2024-08-30', 'Inter-Company', 'Out', '--', 'U16474045', '-47', '--', '-807.93', '0.00', '0.00', '&nbsp;'], '')}
${header('Equity and Index Options', 'asset', 12)}
${header('USD', 'currency', 12)}
${row(['INTC 06SEP24 18 P', '2024-08-30', 'Inter-Company', 'Out', '--', 'U16474045', '1', '--', '-3.07', '0.00', '0.00', '&nbsp;'], '')}
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
${row(['GLOB', 'GLOBANT SA', '123', 'LU0974299876', 'NYSE', '1', 'COMMON', '&nbsp;'], '')}
${row(['PYPL', 'PAYPAL HOLDINGS INC', '124', 'US70450Y1038', 'NASDAQ', '1', 'COMMON', '&nbsp;'], '')}
${row(['UBI', 'UBISOFT ENTERTAINMENT', '125', 'FR0000054470', 'SBF', '1', 'COMMON', '&nbsp;'], '')}
</tbody></table>
<table>
${thead(['Symbol', 'Description', 'Conid', 'Listing Exch', 'Multiplier', 'Expiry', 'Delivery Month', 'Type', 'Strike', 'Code'])}
<tbody>
${header('Equity and Index Options', 'asset', 10)}
${row(['EDU   211119C00003000', 'EDU 19NOV21 3.0 C', '223', 'CBOE', '100', '2021-11-19', '2021-11', 'C', '3', '&nbsp;'], '')}
${row(['PYPL  220617P00230000', 'PYPL 17JUN22 230.0 P', '224', 'CBOE', '100', '2022-06-17', '2022-06', 'P', '230', '&nbsp;'], '')}
</tbody></table>
<table>
${thead(['Symbol', 'Description', 'Conid', 'Security ID', 'Listing Exch', 'Multiplier', 'Type', 'Issuer', 'Maturity', 'Code'])}
<tbody>
${header('Bonds', 'asset', 10)}
${row(['T 2 7/8 05/15/32', 'T 2 7/8 05/15/32', '561', 'US91282CEP23', 'T', '1', 'Govt', 'United States Treasury', '2032-05-15', '&nbsp;'], '')}
</tbody></table>
</div>
</body></html>`;

const parse = () => parseIbkrFile(Buffer.from(FIXTURE, 'utf-8'), 'batch-1');

describe('isIbkrFormat', () => {
  it('rozpoznaje Activity Statement', () => {
    expect(isIbkrFormat(Buffer.from(FIXTURE, 'utf-8'))).toBe(true);
    expect(isIbkrFormat(Buffer.from('data;kwota;waluta\n', 'utf-8'))).toBe(false);
  });
});

describe('mapowanie Trades', () => {
  it('akcje: fractional, side z znaku qty, ISIN z ContractInfo, total wg konwencji K/S', () => {
    const { transactions } = parse();
    const glob = transactions.find((t) => t.paperName === 'GLOBANT SA')!;
    expect(glob).toMatchObject({
      isin: 'LU0974299876',
      quantity: 2.8,
      side: 'K',
      price: 197.13285714,
      value: 551.97,
      commission: 0.35,
      total: 552.32, // K: value + commission
      currency: 'USD',
      paymentCurrency: 'USD',
      category: 'stock',
      source: 'ibkr',
      importBatch: 'batch-1',
    });
    expect(glob.fxRate).toBeUndefined();
    expect(glob.date).toBe('2022-07-22T09:52:06');
  });

  it('anulowana transakcja (kod Ca) jest pomijana', () => {
    const { transactions, skipped } = parse();
    expect(transactions.find((t) => t.paperName === 'XXX')).toBeUndefined();
    expect(skipped.some((s) => s.paperName === 'XXX')).toBe(true);
  });

  it('opcje: sell-to-open jako S z pseudo-ISIN OPT:{OCC} i wartością z mnożnikiem', () => {
    const { transactions } = parse();
    const open = transactions.find((t) => t.isin === 'OPT:EDU211119C00003000' && t.side === 'S')!;
    expect(open).toMatchObject({
      category: 'option',
      quantity: 3,
      price: 0.2,
      value: 60, // 3 × 0.20 × 100
      commission: 2.08,
      total: 57.92, // S: value − commission
    });
  });

  it('wygaśnięcie (C;Ep) to zwykłe zamknięcie K po cenie 0', () => {
    const { transactions } = parse();
    const expiry = transactions.find((t) => t.isin === 'OPT:EDU211119C00003000' && t.side === 'K')!;
    expect(expiry).toMatchObject({ price: 0, value: 0, total: 0, quantity: 3 });
  });

  it('assignment: noga opcyjna zamyka po 0, noga akcyjna K po strike, obie z optionEvent', () => {
    const { transactions } = parse();
    const optLeg = transactions.find((t) => t.isin === 'OPT:PYPL220617P00230000')!;
    expect(optLeg).toMatchObject({ side: 'K', price: 0, value: 0, optionEvent: 'assignment' });
    const stockLeg = transactions.find((t) => t.isin === 'US70450Y1038')!;
    expect(stockLeg).toMatchObject({
      side: 'K',
      quantity: 100,
      price: 230,
      value: 23000,
      optionEvent: 'assignment', // z kodu 'A;O' → nie nadpisujemy kursu rynkowego strike'iem
    });
    // zwykła transakcja (bez kodu A/Ex) nie ma znacznika
    const normal = transactions.find((t) => t.isin === 'US91282CEP23')!;
    expect(normal.optionEvent).toBeUndefined();
  });

  it('obligacja: qty znormalizowane do nominału/100, cena zostaje w % nominału', () => {
    const { transactions } = parse();
    const bond = transactions.find((t) => t.isin === 'US91282CEP23')!;
    expect(bond).toMatchObject({
      category: 'bond',
      quantity: 20, // 2000 nominału / 100
      price: 91.422275,
      value: 1828.45,
      side: 'K',
    });
    // inferBondNominal: value / (qty × price%) = 1828.45 / (20 × 0.91422275) ≈ 100
    expect(bond.value / (bond.quantity * (bond.price / 100))).toBeCloseTo(100, 1);
  });

  it('forex: para nóg fx_exchange + prowizja jako fee', () => {
    const { operations } = parse();
    const legs = operations.filter((o) => o.operationType === 'fx_exchange');
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({
      amount: 1270,
      currency: 'USD',
      fxRate: 4.24497,
      fxPair: 'USD/PLN',
      date: '2022-03-17',
    });
    expect(legs[1]).toMatchObject({ amount: -5391.11, currency: 'PLN' });
    const fxFee = operations.find((o) => o.description.includes('Prowizja przewalutowania'))!;
    expect(fxFee).toMatchObject({ operationType: 'fee', amount: -8.45, currency: 'PLN' });
  });
});

describe('mapowanie operacji gotówkowych', () => {
  it('dywidenda parowana z WHT w jedną operację netto z procentem podatku', () => {
    const { operations } = parse();
    const div = operations.find((o) => o.operationType === 'dividend' && o.ticker === 'MA')!;
    expect(div.amount).toBeCloseTo(1.12, 2); // 1.32 − 0.20
    expect(div.description).toContain('(podatek 15%)');
    expect(div.currency).toBe('USD');
  });

  it('reversal dywidendy netuje się do zera — grupa znika', () => {
    const { operations } = parse();
    expect(operations.find((o) => o.ticker === 'GHI')).toBeUndefined();
  });

  it('osierocona korekta WHT importowana jako samodzielna operacja z warningiem', () => {
    const { operations, warnings } = parse();
    const orphan = operations.find((o) => o.ticker === 'OLD')!;
    expect(orphan).toMatchObject({ operationType: 'dividend', amount: 0.31 });
    expect(warnings.some((w) => w.includes('bez dywidendy'))).toBe(true);
  });

  it('kupon obligacji → dividend+coupon, accrued interest → ujemny coupon', () => {
    const { operations } = parse();
    const coupon = operations.find((o) => o.subkind === 'coupon' && o.amount > 0)!;
    expect(coupon).toMatchObject({ operationType: 'dividend', amount: 28.75 });
    expect(coupon.ticker).toBe('T 2 7/8 05/15/32');
    const accrued = operations.find((o) => o.subkind === 'coupon' && o.amount < 0)!;
    expect(accrued).toMatchObject({ amount: -23.75, ticker: 'T 2 7/8 05/15/32' });
  });

  it('odsetki margin i stock borrow → fee z subkindem; SYEP → other+lending_income', () => {
    const { operations } = parse();
    expect(
      operations.find((o) => o.description.includes('Odsetki od kredytu (margin)')),
    ).toMatchObject({ operationType: 'fee', subkind: 'margin_interest', amount: -2.34 });
    expect(
      operations.find((o) => o.description.includes('Opłata za pożyczenie akcji')),
    ).toMatchObject({ operationType: 'fee', subkind: 'borrow_fee', amount: -0.04 });
    expect(operations.find((o) => o.description.includes('SYEP'))).toMatchObject({
      operationType: 'other',
      subkind: 'lending_income',
      amount: 4.17,
    });
  });

  it('opłata market data → fee; wpłaty/wypłaty po znaku', () => {
    const { operations } = parse();
    expect(operations.find((o) => o.description.includes('NYSE Level I'))).toMatchObject({
      operationType: 'fee',
      subkind: 'market_data',
      amount: -5.82,
      currency: 'PLN',
    });
    expect(operations.filter((o) => o.operationType === 'deposit')).toHaveLength(1);
    expect(operations.find((o) => o.operationType === 'withdrawal')).toMatchObject({
      amount: -500,
    });
  });
});

describe('markery reconciliation', () => {
  it('split zwykły → marker z ratio post/pre', () => {
    const { splits } = parse();
    const amzn = splits.find((s) => s.isin === 'US0231351067')!;
    expect(amzn).toMatchObject({ ratio: 20, exDate: '2022-06-03', ticker: 'AMZN' });
  });

  it('reverse split ze zmianą ISIN → isinChange + split na NOWYM ISIN', () => {
    const { splits, isinChanges } = parse();
    const spce = splits.find((s) => s.ticker === 'SPCE')!;
    expect(spce).toMatchObject({ isin: 'US92766K4031', ratio: 0.05 });
    expect(isinChanges).toContainEqual(
      expect.objectContaining({ oldIsin: 'US92766K1060', newIsin: 'US92766K4031' }),
    );
  });

  it('zmiana CUSIP/ISIN (CCIV→LCID) → marker isinChange', () => {
    const { isinChanges } = parse();
    expect(isinChanges).toContainEqual(
      expect.objectContaining({
        oldIsin: 'US1714391026',
        newIsin: 'US5494981039',
        symbol: 'LCID',
      }),
    );
  });

  it('kontrakty opcyjne z ContractInfo + waluta z Trades', () => {
    const { optionContracts } = parse();
    const edu = optionContracts.find((c) => c.isin === 'OPT:EDU211119C00003000')!;
    expect(edu).toMatchObject({
      occTicker: 'EDU211119C00003000',
      underlying: 'EDU',
      expiry: '2021-11-19',
      strike: 3,
      optionType: 'C',
      multiplier: 100,
      currency: 'USD',
    });
  });

  it('transfery Inter-Company pomijane z warningiem informacyjnym', () => {
    const { transactions, warnings } = parse();
    expect(transactions.some((t) => t.paperName.includes('INTC'))).toBe(false);
    expect(warnings.some((w) => w.includes('transferu między kontami'))).toBe(true);
  });

  it('FTT mapowany na TransactionTax z ISIN z ContractInfo', () => {
    const { transactionTaxes } = parse();
    expect(transactionTaxes).toEqual([
      expect.objectContaining({ isin: 'FR0000054470', amount: 2.36, date: '2021-10-07' }),
    ]);
  });
});
