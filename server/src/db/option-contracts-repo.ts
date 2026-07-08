import { getDb } from './connection.js';
import type { OptionContract } from 'shared';

/**
 * Repo metadanych kontraktów opcyjnych (tabela `option_contracts`).
 * Klucz = pseudo-ISIN 'OPT:{ticker OCC}' — ten sam, którym transakcje i ticker_map
 * identyfikują instrument. Zapis przy imporcie IBKR i ręcznym dodaniu opcji.
 */

interface OptionContractRow {
  isin: string;
  occ_ticker: string;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: 'C' | 'P';
  multiplier: number;
  listing_exch: string | null;
  currency: string;
}

function rowToContract(row: OptionContractRow): OptionContract {
  return {
    isin: row.isin,
    occTicker: row.occ_ticker,
    underlying: row.underlying,
    expiry: row.expiry,
    strike: row.strike,
    optionType: row.option_type,
    multiplier: row.multiplier,
    listingExch: row.listing_exch ?? undefined,
    currency: row.currency,
  };
}

export function upsertOptionContracts(portfolioId: string, contracts: OptionContract[]): void {
  if (contracts.length === 0) return;
  const db = getDb(portfolioId);
  const stmt = db.prepare(`
    INSERT INTO option_contracts
      (isin, occ_ticker, underlying, expiry, strike, option_type, multiplier, listing_exch, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(isin) DO UPDATE SET
      occ_ticker = excluded.occ_ticker,
      underlying = excluded.underlying,
      expiry = excluded.expiry,
      strike = excluded.strike,
      option_type = excluded.option_type,
      multiplier = excluded.multiplier,
      listing_exch = COALESCE(excluded.listing_exch, option_contracts.listing_exch),
      currency = excluded.currency
  `);
  const insertMany = db.transaction((items: OptionContract[]) => {
    for (const c of items) {
      stmt.run(
        c.isin,
        c.occTicker,
        c.underlying,
        c.expiry,
        c.strike,
        c.optionType,
        c.multiplier,
        c.listingExch ?? null,
        c.currency,
      );
    }
  });
  insertMany(contracts);
}

/** Mapa isin → kontrakt dla silnika (mnożnik, expiry) i widoków (optionMeta). */
export function getOptionContractsMap(portfolioId: string): Map<string, OptionContract> {
  const db = getDb(portfolioId);
  const rows = db.prepare('SELECT * FROM option_contracts').all() as OptionContractRow[];
  return new Map(rows.map((r) => [r.isin, rowToContract(r)]));
}
