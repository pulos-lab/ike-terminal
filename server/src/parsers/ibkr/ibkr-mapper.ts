/**
 * Mapowanie modelu pośredniego IbkrStatement na typy domenowe:
 * Transaction / CashOperation / markery reconciliation (splity, zmiany ISIN, kontrakty opcyjne).
 *
 * Kluczowe decyzje (plan wdrożenia IBKR):
 * - konto IBKR jest wielowalutowe: `paymentCurrency = currency`, bez `fxRate` na transakcjach
 *   (koszt w PLN liczy silnik po dziennych kursach — wzorzec mBank);
 * - opcje: pseudo-ISIN `OPT:{ticker OCC}` derywowany deterministycznie z symbolu Trades
 *   (niezależnie od obecności ContractInfo); sell-to-open = zwykłe `S` — FIFO silnika
 *   obsługuje shorty; wygaśnięcie (kod Ep) i assignment (A) to zwykłe wiersze zamykające;
 * - obligacje: normalizacja `quantity = nominał/100` przy cenie w % nominału — dzięki temu
 *   `inferBondNominal` w silniku wylicza nominał 100 i wycena działa bez zmian;
 * - Forex: para nóg `fx_exchange` (konwencja DEGIRO) + prowizja jako `fee`;
 * - dywidendy i WHT: netting per (data, symbol, waluta) — reversale znoszą się w grupie —
 *   potem parowanie brutto+podatek w jedną operację netto (wzorzec DEGIRO);
 * - transfery Inter-Company: POMIJANE z warningiem (oba konta importowane do jednego portfela,
 *   ciągłość kosztu nabycia wynika z historii transakcji starego konta).
 */
import type { CashOperation, OptionContract, SkippedRow, Transaction } from 'shared';
import type { TransactionTax } from '../degiro-operations.js';
import { computeTotal, roundTo2 } from '../utils.js';
import type { IbkrCashRow, IbkrStatement, IbkrTrade } from './section-types.js';
import {
  normalizeBondSymbol,
  parseForexSymbol,
  parseOptionSymbol,
  toOccTicker,
  toOptionPseudoIsin,
} from './symbols.js';

export interface IbkrSplitMarker {
  isin: string;
  ticker: string;
  /** Data zdarzenia (ex-date wg wyciągu). */
  exDate: string;
  /** post/pre: "Split 20 for 1" → 20, "Split 1 for 20" → 0.05. */
  ratio: number;
}

export interface IbkrIsinChangeMarker {
  oldIsin: string;
  newIsin: string;
  /** Ticker instrumentu PO zmianie (np. LCID). */
  symbol: string;
  date: string;
}

export interface IbkrMappedStatement {
  transactions: Transaction[];
  operations: CashOperation[];
  skipped: SkippedRow[];
  splits: IbkrSplitMarker[];
  isinChanges: IbkrIsinChangeMarker[];
  optionContracts: OptionContract[];
  transactionTaxes: TransactionTax[];
  warnings: string[];
}

/** Pseudo-ISIN akcji nieobecnej w ContractInfo (awaryjny — ContractInfo zwykle kompletne). */
const stockPseudoIsin = (symbol: string) => `IBKR:${symbol}`;

/** "TSM(US8740391003) Cash Dividend ..." → { symbol, isin }. */
function parseCashDescriptionInstrument(
  description: string,
): { symbol: string; isin: string } | null {
  const m = description.match(/^(\S+?)\(([A-Z]{2}[A-Z0-9]{9}\d)\)/);
  return m ? { symbol: m[1], isin: m[2] } : null;
}

export function mapIbkrStatement(
  statement: IbkrStatement,
  importBatch: string,
): IbkrMappedStatement {
  const warnings: string[] = [];
  const skipped: SkippedRow[] = [];
  const transactions: Transaction[] = [];
  const operations: CashOperation[] = [];

  const stockBySymbol = new Map(statement.stockInstruments.map((s) => [s.symbol, s]));
  const bondBySymbol = new Map(statement.bondInstruments.map((b) => [b.symbol, b]));

  // ── Trades ──
  let rowNum = 0;
  for (const trade of statement.trades) {
    rowNum++;
    if (trade.codes.includes('Ca')) {
      skipped.push({ row: rowNum, reason: 'unknown_type', paperName: trade.symbol });
      warnings.push(`IBKR: pominięto anulowaną transakcję ${trade.symbol} (${trade.dateTime})`);
      continue;
    }
    if (trade.codes.includes('T')) {
      // Transfery między kontami idą sekcją Transfers — wiersz w Trades byłby duplikatem
      continue;
    }
    if (trade.quantity === 0) {
      skipped.push({ row: rowNum, reason: 'invalid_quantity', paperName: trade.symbol });
      continue;
    }

    switch (trade.assetClass) {
      case 'Stocks':
        transactions.push(mapStockTrade(trade, stockBySymbol, warnings));
        break;
      case 'Equity and Index Options': {
        const tx = mapOptionTrade(trade, warnings);
        if (tx) transactions.push(tx);
        else skipped.push({ row: rowNum, reason: 'unknown_type', paperName: trade.symbol });
        break;
      }
      case 'Bonds': {
        const tx = mapBondTrade(trade, bondBySymbol, warnings);
        if (tx) transactions.push(tx);
        else skipped.push({ row: rowNum, reason: 'unknown_type', paperName: trade.symbol });
        break;
      }
      case 'Forex':
        mapForexTrade(trade, operations, warnings, importBatch);
        break;
      default:
        skipped.push({ row: rowNum, reason: 'unknown_type', paperName: trade.symbol });
        warnings.push(
          `IBKR: nieobsługiwana kategoria aktywów "${trade.assetClass}" (${trade.symbol}) — wiersz pominięty`,
        );
    }
  }
  for (const tx of transactions) tx.importBatch = importBatch;

  // ── Dywidendy + podatek u źródła ──
  operations.push(
    ...mapDividendsWithWht(statement.dividends, statement.withholdingTaxes, importBatch, warnings),
  );

  // ── Odsetki / kupony / opłaty brokera (CombInt + BrokerFees — klasyfikacja po frazach) ──
  for (const row of [...statement.interest, ...statement.brokerFees]) {
    operations.push(classifyInterestRow(row, importBatch, warnings));
  }

  // ── Opłaty (sekcja Fees = subskrypcje danych rynkowych i podobne) ──
  for (const row of statement.fees) {
    operations.push({
      date: row.date,
      operationType: 'fee',
      subkind: 'market_data',
      description: row.description,
      amount: row.amount, // znak z wyciągu (koszt = ujemny)
      currency: row.currency,
      source: 'ibkr',
      importBatch,
    });
  }

  // ── Wpłaty / wypłaty ──
  for (const row of statement.depositsWithdrawals) {
    operations.push({
      date: row.date,
      operationType: row.amount >= 0 ? 'deposit' : 'withdrawal',
      description: row.description,
      amount: row.amount,
      currency: row.currency,
      source: 'ibkr',
      importBatch,
    });
  }

  // ── Sales Tax (VAT od opłat) — w wyciągu istnieje TYLKO jako agregat w Cash Report ──
  // Data = ostatnia data aktywności w pliku (przybliżenie końca okresu wyciągu);
  // jedna operacja per waluta, żeby saldo gotówki zgadzało się z wyciągiem.
  const lastActivityDate = [
    ...statement.trades.map((t) => t.dateTime.slice(0, 10)),
    ...statement.depositsWithdrawals.map((r) => r.date),
    ...statement.fees.map((r) => r.date),
  ]
    .sort()
    .pop();
  for (const tax of statement.salesTax) {
    operations.push({
      date: lastActivityDate ?? '1970-01-01',
      operationType: 'fee',
      subkind: 'sales_tax',
      description: `Podatek VAT od opłat (Sales Tax) — suma roczna z wyciągu, ${tax.currency}`,
      amount: tax.amount,
      currency: tax.currency,
      source: 'ibkr',
      importBatch,
    });
  }

  // ── Corporate actions → markery (wiersze NIE stają się transakcjami) ──
  const { splits, isinChanges } = mapCorporateActions(statement, warnings);

  // ── Transfery Inter-Company → tylko warning ──
  if (statement.transfers.length > 0) {
    const inCount = statement.transfers.filter((t) => t.direction === 'In').length;
    const outCount = statement.transfers.length - inCount;
    const counter = statement.transfers[0].counterAccount;
    warnings.push(
      `IBKR: pominięto ${statement.transfers.length} pozycji transferu między kontami ` +
        `(${statement.account ?? '?'} ↔ ${counter}, In: ${inCount}, Out: ${outCount}) — ` +
        `oba konta importujesz do jednego portfela, więc ciągłość pozycji wynika z historii transakcji.`,
    );
  }

  // ── Transactions Tax (np. francuski FTT) → doliczenie do prowizji transakcji ──
  const transactionTaxes: TransactionTax[] = [];
  for (const row of statement.transactionTaxes) {
    const stock = stockBySymbol.get(row.symbol);
    if (!stock) {
      warnings.push(
        `IBKR: podatek transakcyjny "${row.description}" (${row.symbol}) bez instrumentu w ContractInfo — pominięto`,
      );
      continue;
    }
    transactionTaxes.push({
      isin: stock.isin,
      date: row.date,
      amount: Math.abs(row.amount),
      description: `${row.description} (${row.symbol})`,
    });
  }

  return {
    transactions,
    operations,
    skipped,
    splits,
    isinChanges,
    optionContracts: buildOptionContracts(statement),
    transactionTaxes,
    warnings,
  };
}

function mapStockTrade(
  trade: IbkrTrade,
  stockBySymbol: Map<string, IbkrStatement['stockInstruments'][number]>,
  warnings: string[],
): Transaction {
  const instrument = stockBySymbol.get(trade.symbol);
  if (!instrument) {
    warnings.push(
      `IBKR: brak ${trade.symbol} w Financial Instrument Information — użyto pseudo-ISIN ${stockPseudoIsin(trade.symbol)}`,
    );
  }
  const side: 'K' | 'S' = trade.quantity > 0 ? 'K' : 'S';
  const value = roundTo2(Math.abs(trade.proceeds));
  const commission = roundTo2(Math.abs(trade.commFee));
  return {
    date: trade.dateTime,
    paperName: instrument?.description ?? trade.symbol,
    isin: instrument?.isin ?? stockPseudoIsin(trade.symbol),
    quantity: Math.abs(trade.quantity),
    side,
    price: trade.tPrice,
    value,
    commission,
    total: computeTotal(side, value, commission),
    currency: trade.currency,
    paymentCurrency: trade.currency,
    category: instrument?.type === 'ETF' ? 'etf' : 'stock',
    source: 'ibkr',
  };
}

function mapOptionTrade(trade: IbkrTrade, warnings: string[]): Transaction | null {
  const parsed = parseOptionSymbol(trade.symbol);
  if (!parsed) {
    warnings.push(`IBKR: nierozpoznany symbol opcji "${trade.symbol}" — wiersz pominięty`);
    return null;
  }
  const side: 'K' | 'S' = trade.quantity > 0 ? 'K' : 'S';
  // Proceeds zawiera mnożnik kontraktu (qty × premia × 100); dla wygaśnięcia (kod Ep) = 0
  const value = roundTo2(Math.abs(trade.proceeds));
  const commission = roundTo2(Math.abs(trade.commFee));
  return {
    date: trade.dateTime,
    paperName: trade.symbol,
    isin: toOptionPseudoIsin(parsed),
    quantity: Math.abs(trade.quantity),
    side,
    price: trade.tPrice,
    value,
    commission,
    total: computeTotal(side, value, commission),
    currency: trade.currency,
    paymentCurrency: trade.currency,
    category: 'option',
    source: 'ibkr',
  };
}

function mapBondTrade(
  trade: IbkrTrade,
  bondBySymbol: Map<string, IbkrStatement['bondInstruments'][number]>,
  warnings: string[],
): Transaction | null {
  const symbol = normalizeBondSymbol(trade.symbol);
  const instrument = bondBySymbol.get(symbol);
  if (!instrument) {
    warnings.push(
      `IBKR: obligacja "${symbol}" bez wpisu w Financial Instrument Information — wiersz pominięty`,
    );
    return null;
  }
  const side: 'K' | 'S' = trade.quantity > 0 ? 'K' : 'S';
  const value = roundTo2(Math.abs(trade.proceeds));
  const commission = roundTo2(Math.abs(trade.commFee));
  return {
    date: trade.dateTime,
    paperName: instrument.description,
    isin: instrument.isin,
    // IBKR podaje qty jako nominał (2000 = 2000 USD wartości nominalnej) przy cenie w % nominału.
    // Normalizujemy do jednostek o nominale 100: inferBondNominal w silniku wyliczy wtedy
    // nominal=100 (value / (qty × price%)) i bondPriceMultiplier zadziała bez żadnych zmian.
    quantity: Math.abs(trade.quantity) / 100,
    side,
    price: trade.tPrice,
    value,
    commission,
    total: computeTotal(side, value, commission),
    currency: trade.currency,
    paymentCurrency: trade.currency,
    category: 'bond',
    source: 'ibkr',
  };
}

/** Forex ("USD.PLN", qty=1270, T.Price=4.24497, proceeds=-5391.11 PLN) → para nóg fx_exchange. */
function mapForexTrade(
  trade: IbkrTrade,
  operations: CashOperation[],
  warnings: string[],
  importBatch: string,
): void {
  const pair = parseForexSymbol(trade.symbol);
  if (!pair) {
    warnings.push(`IBKR: nierozpoznany symbol forex "${trade.symbol}" — wiersz pominięty`);
    return;
  }
  const date = trade.dateTime.slice(0, 10);
  const fxPair = `${pair.base}/${pair.quote}`;
  // Konwencja fxRate jak Bossa/DEGIRO: PLN (quote) za 1 jednostkę waluty bazowej
  const fxRate = trade.tPrice;
  const description = `Wymiana ${fxPair} @ ${trade.tPrice}`;
  // Noga w walucie bazowej: znak z ilości (kupno USD → +USD)
  operations.push({
    date,
    operationType: 'fx_exchange',
    description,
    amount: trade.quantity,
    currency: pair.base,
    fxRate,
    fxPair,
    source: 'ibkr',
    importBatch,
  });
  // Noga w walucie kwotowanej: proceeds ma już właściwy znak (kupno USD → ujemne PLN)
  operations.push({
    date,
    operationType: 'fx_exchange',
    description,
    amount: roundTo2(trade.proceeds),
    currency: pair.quote,
    fxRate,
    fxPair,
    source: 'ibkr',
    importBatch,
  });
  if (trade.commFee !== 0) {
    operations.push({
      date,
      operationType: 'fee',
      subkind: 'fx_commission',
      description: `Prowizja przewalutowania ${fxPair}`,
      // Prowizje forex są w walucie bazowej konta (nagłówek "Comm in PLN") — także
      // dla par bez PLN (EUR.USD); waluta bloku byłaby błędna.
      amount: roundTo2(trade.commFee),
      currency: trade.commCurrency ?? pair.quote,
      source: 'ibkr',
      importBatch,
    });
  }
}

/**
 * Netting reversali + parowanie dywidenda↔podatek per (data, symbol, waluta).
 * Wynik: jedna operacja `dividend` netto z opisem "(podatek N%)" — wzorzec DEGIRO.
 */
function mapDividendsWithWht(
  dividends: IbkrCashRow[],
  whtRows: IbkrCashRow[],
  importBatch: string,
  warnings: string[],
): CashOperation[] {
  type Group = {
    date: string;
    symbol: string;
    isin: string;
    currency: string;
    net: number;
    description: string;
  };

  const nonInstrumentOps: CashOperation[] = [];
  const groupBy = (rows: IbkrCashRow[], label: string): Map<string, Group> => {
    const groups = new Map<string, Group>();
    for (const row of rows) {
      const inst = parseCashDescriptionInstrument(row.description);
      if (!inst) {
        // Np. "Withholding @ 20% on Credit Interest for Apr-2025" — podatek u źródła od
        // odsetek, bez instrumentu. Importujemy jako opłatę, żeby saldo gotówki się zgadzało.
        nonInstrumentOps.push({
          date: row.date,
          operationType: 'fee',
          description: `Podatek u źródła: ${row.description}`,
          amount: row.amount,
          currency: row.currency,
          source: 'ibkr',
          importBatch,
        });
        warnings.push(
          `IBKR ${label}: opis bez instrumentu "${row.description}" — zaimportowano jako opłatę`,
        );
        continue;
      }
      const key = `${row.date}|${inst.symbol}|${row.currency}`;
      const group = groups.get(key);
      if (group) group.net = roundTo2(group.net + row.amount);
      else
        groups.set(key, {
          date: row.date,
          symbol: inst.symbol,
          isin: inst.isin,
          currency: row.currency,
          net: row.amount,
          description: row.description,
        });
    }
    return groups;
  };

  const divGroups = groupBy(dividends, 'Dividends');
  const whtGroups = groupBy(whtRows, 'Withholding Tax');
  const operations: CashOperation[] = [...nonInstrumentOps];

  for (const [key, div] of divGroups) {
    const tax = whtGroups.get(key);
    whtGroups.delete(key);
    if (div.net === 0 && (!tax || tax.net === 0)) continue; // pełny reversal — grupa znika
    const gross = div.net;
    const taxAmount = tax ? Math.abs(tax.net) : 0;
    const netAmount = roundTo2(gross - taxAmount);
    const taxPct = gross > 0 ? Math.round((taxAmount / gross) * 100) : 0;
    const descParts = [div.description.replace(/\s*\([^)]*\)\s*$/, '')];
    if (taxPct > 0) descParts.push(`(podatek ${taxPct}%)`);
    if (gross < 0) {
      warnings.push(
        `IBKR: ujemna dywidenda netto ${div.symbol} ${div.date} (${gross} ${div.currency}) — korekta z poprzedniego okresu, zaimportowano ze znakiem ujemnym`,
      );
    }
    operations.push({
      date: div.date,
      operationType: 'dividend',
      description: descParts.join(' '),
      amount: netAmount,
      currency: div.currency,
      ticker: div.symbol,
      source: 'ibkr',
      importBatch,
    });
  }

  // Podatek bez dywidendy w tym samym pliku = korekta WHT z poprzedniego okresu
  for (const tax of whtGroups.values()) {
    if (tax.net === 0) continue;
    warnings.push(
      `IBKR: podatek u źródła ${tax.symbol} ${tax.date} bez dywidendy w tym pliku — zaimportowano jako samodzielną korektę`,
    );
    operations.push({
      date: tax.date,
      operationType: 'dividend',
      description: `Korekta podatku u źródła: ${tax.description}`,
      amount: roundTo2(tax.net),
      currency: tax.currency,
      ticker: tax.symbol,
      source: 'ibkr',
      importBatch,
    });
  }

  return operations;
}

/** Klasyfikacja wierszy CombInt/BrokerFees po frazach kluczowych opisu. */
function classifyInterestRow(
  row: IbkrCashRow,
  importBatch: string,
  warnings: string[],
): CashOperation {
  const base = {
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    source: 'ibkr' as const,
    importBatch,
  };
  const d = row.description;

  if (/Bond Coupon Payment/i.test(d)) {
    // "Bond Coupon Payment (T 2 7/8 05/15/32 - United States Treasury ...)"
    const ticker = normalizeBondSymbol(d.match(/\(([^-)]+)/)?.[1]?.trim() ?? '');
    return {
      ...base,
      operationType: 'dividend',
      subkind: 'coupon',
      description: `Kupon obligacji: ${d}`,
      ticker: ticker || undefined,
    };
  }
  if (/Purchase Accrued Interest/i.test(d)) {
    // Odsetki naliczone zapłacone przy zakupie obligacji — ujemny "kupon", netuje się
    // z pierwszym otrzymanym kuponem w panelu Dywidendy (ekonomicznie poprawne).
    const ticker = normalizeBondSymbol(d.replace(/.*Purchase Accrued Interest/i, '').trim());
    return {
      ...base,
      operationType: 'dividend',
      subkind: 'coupon',
      description: `Odsetki naliczone przy zakupie obligacji: ${d}`,
      ticker: ticker || undefined,
    };
  }
  if (/Investment Loan Interest|Debit Interest|Loan Interest/i.test(d)) {
    return {
      ...base,
      operationType: 'fee',
      subkind: 'margin_interest',
      description: `Odsetki od kredytu (margin): ${d}`,
    };
  }
  if (/Borrow Fee/i.test(d)) {
    // "Stock Borrow Fees" (2021-2023) i "USD Borrow Fees" (2024+) to ten sam koszt
    return {
      ...base,
      operationType: 'fee',
      subkind: 'borrow_fee',
      description: `Opłata za pożyczenie akcji: ${d}`,
    };
  }
  if (/SYEP|Managed Securities/i.test(d)) {
    if (row.amount > 0) {
      return {
        ...base,
        operationType: 'other',
        subkind: 'lending_income',
        description: `Przychód z pożyczania akcji (SYEP): ${d}`,
      };
    }
    return {
      ...base,
      operationType: 'fee',
      subkind: 'lending_income',
      description: `Opłata SYEP: ${d}`,
    };
  }
  if (/Credit Interest/i.test(d) || (/Interest/i.test(d) && row.amount > 0)) {
    return { ...base, operationType: 'other', subkind: 'interest', description: `Odsetki: ${d}` };
  }

  warnings.push(
    `IBKR: nierozpoznany wiersz odsetek/opłat "${d}" (${row.amount} ${row.currency}) — zaimportowano jako "${row.amount > 0 ? 'inne' : 'opłata'}"`,
  );
  return row.amount > 0
    ? { ...base, operationType: 'other', description: d }
    : { ...base, operationType: 'fee', description: d };
}

/** Corporate Actions → markery splitów i zmian ISIN. */
function mapCorporateActions(
  statement: IbkrStatement,
  warnings: string[],
): { splits: IbkrSplitMarker[]; isinChanges: IbkrIsinChangeMarker[] } {
  const splits: IbkrSplitMarker[] = [];
  const isinChanges: IbkrIsinChangeMarker[] = [];

  // Grupujemy po prefiksie opisu (część przed trailing "(TICKER, NAZWA, ISIN)") — split
  // i zmiana ISIN generują 1-2 wiersze z tym samym prefiksem a różnym instrumentem wynikowym.
  type CaRow = IbkrStatement['corporateActions'][number] & {
    prefix: string;
    resultTicker?: string;
    resultIsin?: string;
    sourceIsin?: string;
  };
  const rows: CaRow[] = statement.corporateActions.map((row) => {
    const trailing = row.description.match(
      /\(([A-Z0-9.\s]+),\s*[^,]+,\s*([A-Z]{2}[A-Z0-9]{9}\d)\)\s*$/,
    );
    const source = row.description.match(/^(\S+?)\(([A-Z]{2}[A-Z0-9]{9}\d)\)/);
    return {
      ...row,
      prefix: row.description.replace(/\s*\([A-Z0-9.\s]+,[^)]+\)\s*$/, ''),
      resultTicker: trailing?.[1]?.trim(),
      resultIsin: trailing?.[2],
      sourceIsin: source?.[2],
    };
  });

  const byPrefix = new Map<string, CaRow[]>();
  for (const row of rows) {
    const list = byPrefix.get(row.prefix) ?? [];
    list.push(row);
    byPrefix.set(row.prefix, list);
  }

  for (const [prefix, group] of byPrefix) {
    const splitMatch = prefix.match(/Split (\d+) for (\d+)/i);
    const isinChangeMatch = /CUSIP\/ISIN Change/i.test(prefix);
    const gained = group.find((r) => r.quantity > 0);
    const lost = group.find((r) => r.quantity < 0);

    if (splitMatch) {
      const ratio = Number(splitMatch[1]) / Number(splitMatch[2]);
      const source = group[0];
      const newIsin = gained?.resultIsin ?? source.sourceIsin;
      const oldIsin = lost?.resultIsin ?? source.sourceIsin;
      if (!newIsin) {
        warnings.push(`IBKR: split bez rozpoznanego ISIN ("${prefix}") — pominięto`);
        continue;
      }
      // Reverse split ze zmianą ISIN (SPCE): najpierw zmiana ISIN, potem split na NOWYM ISIN
      if (oldIsin && oldIsin !== newIsin) {
        isinChanges.push({
          oldIsin,
          newIsin,
          symbol: gained?.resultTicker ?? source.prefix.split('(')[0],
          date: source.date,
        });
      }
      splits.push({
        isin: newIsin,
        ticker: gained?.resultTicker ?? prefix.split('(')[0],
        exDate: source.date,
        ratio,
      });
    } else if (isinChangeMatch) {
      const oldIsin = group[0].sourceIsin ?? lost?.resultIsin;
      const newIsin = gained?.resultIsin;
      if (!oldIsin || !newIsin || oldIsin === newIsin) {
        warnings.push(`IBKR: zmiana ISIN bez pary starego/nowego ISIN ("${prefix}") — pominięto`);
        continue;
      }
      isinChanges.push({
        oldIsin,
        newIsin,
        symbol: gained?.resultTicker ?? '',
        date: group[0].date,
      });
    } else {
      warnings.push(
        `IBKR: nieobsłużone zdarzenie korporacyjne "${prefix}" — wiersze pominięte, zweryfikuj pozycję ręcznie`,
      );
    }
  }

  return { splits, isinChanges };
}

/**
 * Kontrakty opcyjne: unia ContractInfo i symboli z Trades (gdyby ContractInfo było
 * niekompletne). Ticker OCC liczony deterministycznie z symbolu tradowego — identyczny
 * wynik dla importu i ręcznego dodawania; waluta z wierszy Trades (fallback USD).
 */
function buildOptionContracts(statement: IbkrStatement): OptionContract[] {
  const currencyBySymbol = new Map<string, string>();
  for (const trade of statement.trades) {
    if (trade.assetClass === 'Equity and Index Options') {
      currencyBySymbol.set(trade.symbol, trade.currency);
    }
  }

  const contracts = new Map<string, OptionContract>();
  const add = (tradeSymbol: string, multiplier: number, listingExch?: string) => {
    const parsed = parseOptionSymbol(tradeSymbol);
    if (!parsed) return;
    const isin = toOptionPseudoIsin(parsed);
    if (contracts.has(isin)) return;
    contracts.set(isin, {
      isin,
      occTicker: toOccTicker(parsed),
      underlying: parsed.underlying,
      expiry: parsed.expiry,
      strike: parsed.strike,
      optionType: parsed.optionType,
      multiplier,
      listingExch,
      currency: currencyBySymbol.get(tradeSymbol) ?? 'USD',
    });
  };

  for (const inst of statement.optionInstruments) {
    add(inst.tradeSymbol, inst.multiplier, inst.listingExch);
  }
  for (const trade of statement.trades) {
    if (trade.assetClass === 'Equity and Index Options') add(trade.symbol, 100);
  }
  return [...contracts.values()];
}
