import { describe, it, expect } from 'vitest';
import { parseIbkrFile, isIbkrFormat } from '../ibkr/index.js';

/**
 * IBKR coverage probe — żywa checklista typów operacji, które parser IBKR
 * OBSŁUGUJE vs POMIJA/WRZUCA DO FALLBACKU.
 *
 * Motywacja: cudze/egzotyczne wyciągi zawierają typy zdarzeń, których nasz parser
 * nie umie zaksięgować. Publiczne sample IBKR mają STARY schemat DOM ("Classic",
 * `id="tblTransactions"` bez `_U…Body`) i parser ich nie wykrywa — więc nie da się
 * ich użyć jako sondy. Zamiast tego budujemy MINIMALNE fixtury w NOWYM formacie
 * ("Bootstrap", `id="tbl…_U…Body"` + `table table-bordered`) — identycznym jak realne
 * wyciągi 2021-2025 — z JEDNYM wierszem danego typu i przepuszczamy je przez REALNY
 * `parseIbkrFile`.
 *
 * Każdy test asertuje BIEŻĄCE zachowanie:
 *   - HANDLED  → powstaje marker/operacja właściwego typu, brak warninga
 *   - DROPPED  → warning "nieobsłużone…" i wiersz pominięty
 *   - FALLBACK → zaimportowany jako generyczne other/fee + warning "nierozpoznany…"
 *
 * Gdy zaimplementujemy któryś z DROPPED/FALLBACK, test tutaj PĘKNIE — to sygnał,
 * żeby przenieść typ do HANDLED i dopisać właściwą asercję. Katalog typów pochodzi
 * z enumów IBKR (`ibflex`: Reorg / CashAction).
 */

// ── Fixture builders — wierny NOWY format Activity Statement ────────────────────
const ACCT = 'U000';

function sectionBody(section: string, inner: string): string {
  return `<div id="tbl${section}_${ACCT}Body" class="sectionContent" style="position: absolute; display: none">
<div class="table-responsive">
<table width="100%" cellpadding="0" cellspacing="0" border="0" class="table table-bordered">
${inner}
</table></div></div>`;
}

interface CorpRow {
  desc: string;
  qty: number;
  reportDate?: string;
  dateTime?: string;
  currency?: string;
  asset?: string;
}

/** Sekcja Corporate Actions z podanymi wierszami (grupowane pod Stocks/USD domyślnie). */
function corpSection(rows: CorpRow[]): string {
  const head = `<thead><tr>
<th align="left">Report Date</th><th align="left">Date/Time</th>
<th align="left">Description</th><th align="right">Quantity</th>
<th align="right">Proceeds</th><th align="right">Value</th>
<th align="right">Realized P/L</th><th align="right">Code</th>
</tr></thead>`;
  const body = rows
    .map((r) => {
      const asset = `<tr><td class="header-asset" colspan="8">${r.asset ?? 'Stocks'}</td></tr>`;
      const cur = `<tr><td class="header-currency" colspan="8">${r.currency ?? 'USD'}</td></tr>`;
      const data = `<tr><td>${r.reportDate ?? '2024-03-01'}</td><td>${r.dateTime ?? '2024-02-28, 20:25:00'}</td><td>${r.desc}</td><td align="right">${r.qty}</td><td align="right">0.00</td><td align="right">0.00</td><td align="right">0.00</td><td align="right">&nbsp;</td></tr>`;
      return asset + cur + data;
    })
    .join('\n');
  return sectionBody('CorporateActions', head + body);
}

interface CashRow {
  desc: string;
  amount: number;
  date?: string;
  currency?: string;
}

/** Sekcja gotówkowa (CombInt / CombFees / BrokerFees) — Date | Description | Amount. */
function cashSection(section: string, rows: CashRow[]): string {
  const head = `<thead><tr><th align="left">Date</th><th align="left">Description</th><th align="right">Amount</th></tr></thead>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td class="header-currency" colspan="3">${r.currency ?? 'USD'}</td></tr>` +
        `<tr><td>${r.date ?? '2024-06-15'}</td><td>${r.desc}</td><td align="right">${r.amount}</td></tr>`,
    )
    .join('\n');
  return sectionBody(section, head + body);
}

/** Sklej minimalny wyciąg: literały detekcji + pusty CombDepWith (warunek wykrycia) + sekcje. */
function statement(...sections: string[]): Buffer {
  const html = `<!DOCTYPE html><html><head><title>Activity Statement</title></head><body>
<div>Interactive Brokers</div>
${sectionBody('CombDepWith', '<thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>')}
${sections.join('\n')}
</body></html>`;
  return Buffer.from(html, 'utf-8');
}

const parse = (...sections: string[]) => parseIbkrFile(statement(...sections), 'test-batch');

describe('IBKR coverage — fixtury detekcji i szkielet', () => {
  it('minimalny syntetyczny wyciąg jest wykrywany jako IBKR', () => {
    expect(isIbkrFormat(statement())).toBe(true);
  });
});

// ── Corporate Actions (Reorg) ──────────────────────────────────────────────────
describe('IBKR coverage — Corporate Actions (Reorg)', () => {
  it('HANDLED: Forward Split → marker splitu, brak warninga', () => {
    const out = parse(
      corpSection([
        { desc: 'AMZN(US0231351067) Split 20 for 1 (AMZN, AMAZON.COM INC, US0231351067)', qty: 950 },
      ]),
    );
    expect(out.splits).toHaveLength(1);
    expect(out.splits[0]).toMatchObject({ ticker: 'AMZN', ratio: 20 });
    expect(out.warnings.some((w) => /nieobsłużone/.test(w))).toBe(false);
  });

  it('HANDLED: Reverse Split → marker splitu z ułamkowym ratio', () => {
    const out = parse(
      corpSection([
        { desc: 'MCHP(US5950171042) Split 1 for 2 (MCHP, MICROCHIP TECHNOLOGY INC, US5950171042)', qty: -50 },
      ]),
    );
    expect(out.splits).toHaveLength(1);
    expect(out.splits[0].ratio).toBeCloseTo(0.5);
  });

  it('HANDLED: CUSIP/ISIN Change → marker zmiany ISIN, brak warninga', () => {
    const out = parse(
      corpSection([
        { desc: 'CCIV(US1714391026) CUSIP/ISIN Change to (US5494981039) (CCIV, CHURCHILL CAPITAL CORP IV-A, US1714391026)', qty: -85 },
        { desc: 'CCIV(US1714391026) CUSIP/ISIN Change to (US5494981039) (LCID, LUCID GROUP INC, US5494981039)', qty: 85 },
      ]),
    );
    expect(out.isinChanges).toHaveLength(1);
    expect(out.isinChanges[0]).toMatchObject({ oldIsin: 'US1714391026', newIsin: 'US5494981039' });
    expect(out.warnings.some((w) => /nieobsłużone/.test(w))).toBe(false);
  });

  /**
   * DROPPED — typy Reorg, których parser NIE obsługuje (pomijane z warningiem).
   * Opisy wzorowane na konwencji IBKR `TICKER(ISIN) <Zdarzenie> … (RESULT, NAZWA, ISIN)`;
   * dokładne brzmienie dla typów nie napotkanych na naszych kontach jest przybliżone,
   * ale asercja (pominięcie) zależy tylko od BRAKU dopasowania do Split/ISIN Change.
   */
  const DROPPED_REORG: Array<{ code: string; name: string; desc: string; qty: number }> = [
    { code: 'TC', name: 'Merger / przejęcie', desc: 'ABCD(US1111111111) Merged(Acquisition) 1 for 1 (WXYZ, ACQUIRER INC, US2222222222)', qty: -100 },
    { code: 'SO', name: 'Spinoff', desc: 'ABCD(US1111111111) Spinoff  1 for 5 (SPIN, SPINCO INC, US3333333333)', qty: 20 },
    { code: 'SD', name: 'Stock Dividend', desc: 'ABCD(US1111111111) Stock Dividend 1 for 10 (ABCD, SOME CORP, US1111111111)', qty: 10 },
    { code: 'RI', name: 'Rights Issue', desc: 'ABCD(US1111111111) Subscribable Rights Issue 1 for 4 (ABCD.RTS, SOME CORP RIGHTS, US4444444444)', qty: 25 },
    { code: 'TO', name: 'Tender / wezwanie', desc: 'ABCD(US1111111111) Tendered to (US5555555555) 1 for 1 (CASH, TENDER OFFER, US5555555555)', qty: -100 },
    { code: 'DW', name: 'Delist / worthless', desc: 'ABCD(US1111111111) Delisted (Worthless) (ABCD, SOME CORP, US1111111111)', qty: -100 },
    { code: 'BM', name: 'Bond Maturity / wykup', desc: 'T 2 7/8 05/15/32(US91282CEF10) Bond Maturity for (US91282CEF10) 1000 (T, US TREASURY, US91282CEF10)', qty: -1000 },
  ];

  it.each(DROPPED_REORG)('DROPPED: [$code] $name → warning + brak markera', ({ desc, qty }) => {
    const out = parse(corpSection([{ desc, qty }]));
    expect(out.splits).toHaveLength(0);
    expect(out.isinChanges).toHaveLength(0);
    expect(out.warnings.some((w) => /nieobsłużone zdarzenie korporacyjne/.test(w))).toBe(true);
  });
});

// ── Operacje gotówkowe (CashAction / CombInt) ──────────────────────────────────
describe('IBKR coverage — operacje gotówkowe (CombInt / opłaty)', () => {
  it('HANDLED: Credit Interest (dodatni) → operacja "other", brak warninga', () => {
    const out = parse(cashSection('CombInt', [{ desc: 'USD Credit Interest for Jun-2024', amount: 1.23 }]));
    expect(out.operations.some((o) => o.operationType === 'other')).toBe(true);
    expect(out.warnings.some((w) => /nierozpoznany wiersz odsetek/.test(w))).toBe(false);
  });

  it('HANDLED: Debit Interest (margin) → fee/margin_interest, brak warninga', () => {
    const out = parse(cashSection('CombInt', [{ desc: 'USD Debit Interest for Jun-2024', amount: -2.5 }]));
    const fee = out.operations.find((o) => o.operationType === 'fee');
    expect(fee?.subkind).toBe('margin_interest');
    expect(out.warnings.some((w) => /nierozpoznany wiersz odsetek/.test(w))).toBe(false);
  });

  /**
   * FALLBACK — typy CashAction bez dedykowanej klasyfikacji: importowane jako
   * generyczne other/fee + warning. Ekonomicznie „są w saldzie", ale nie mają
   * właściwego subkind (nie wpadną do panelu odsetek/dywidend/pożyczek).
   */
  const FALLBACK_CASH: Array<{ name: string; desc: string; amount: number; expectType: 'fee' | 'other' }> = [
    { name: 'Payment In Lieu Of Dividend', desc: 'ABCD (US1111111111) Payment In Lieu Of Dividend', amount: 4.2, expectType: 'other' },
    { name: 'Broker Interest Paid', desc: 'USD Broker Interest Paid for Jun-2024', amount: -0.8, expectType: 'fee' },
    { name: 'Commission Adjustment', desc: 'Commission Adjustment - trade correction', amount: -0.15, expectType: 'fee' },
    { name: 'Advisor Fees', desc: 'Advisor Fees for Q2-2024', amount: -12.0, expectType: 'fee' },
  ];

  it.each(FALLBACK_CASH)('FALLBACK: $name → generyczne $expectType + warning', ({ desc, amount, expectType }) => {
    const out = parse(cashSection('CombInt', [{ desc, amount }]));
    expect(out.warnings.some((w) => /nierozpoznany wiersz odsetek\/opłat/.test(w))).toBe(true);
    expect(out.operations.some((o) => o.operationType === expectType && !o.subkind)).toBe(true);
  });
});
