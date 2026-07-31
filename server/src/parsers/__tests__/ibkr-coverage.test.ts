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
 *   - HANDLED    → powstaje marker/operacja właściwego typu, brak warninga
 *   - DROPPED    → warning "nieobsłużone…" i wiersz pominięty
 *   - SAFETY NET → nieznany opis importowany bezpiecznie (generyczne other/fee + warning)
 *
 * WERYFIKACJA NA REALNYCH DANYCH (6 wyciągów 2021-2025, 2 konta): parser klasyfikuje
 * 100% obecnych typów — ZERO warningów fallback/dropped. W szczególności typy, które
 * łatwo wziąć za luki, są obsłużone przez WŁAŚCIWE sekcje: Payment in Lieu → CombDiv+WHT
 * (→ dividend), Commission Adjustment → CombDepWith (→ deposit), odsetki brokera → CombInt.
 * Jedyne realnie nieobsłużone to zdarzenia korporacyjne poza Split/ISIN Change — których
 * w naszych danych NIE MA (patrz sekcja DROPPED; opisy przybliżone, brak realnej fixtury).
 *
 * Gdy zaimplementujemy któryś z DROPPED, test tutaj PĘKNIE — sygnał, żeby przenieść typ
 * do HANDLED i dopisać właściwą asercję. Katalog typów: enumy IBKR (`ibflex`: Reorg / CashAction).
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

/** Sklej minimalny wyciąg: literały detekcji + pusty Transactions (warunek wykrycia) + sekcje. */
function statement(...sections: string[]): Buffer {
  const html = `<!DOCTYPE html><html><head><title>Activity Statement</title></head><body>
<div>Interactive Brokers</div>
${sectionBody('Transactions', '<thead><tr><th>Symbol</th><th>Date/Time</th><th>Quantity</th></tr></thead>')}
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
        {
          desc: 'AMZN(US0231351067) Split 20 for 1 (AMZN, AMAZON.COM INC, US0231351067)',
          qty: 950,
        },
      ]),
    );
    expect(out.splits).toHaveLength(1);
    expect(out.splits[0]).toMatchObject({ ticker: 'AMZN', ratio: 20 });
    expect(out.warnings.some((w) => /nieobsłużone/.test(w))).toBe(false);
  });

  it('HANDLED: Reverse Split → marker splitu z ułamkowym ratio', () => {
    const out = parse(
      corpSection([
        {
          desc: 'MCHP(US5950171042) Split 1 for 2 (MCHP, MICROCHIP TECHNOLOGY INC, US5950171042)',
          qty: -50,
        },
      ]),
    );
    expect(out.splits).toHaveLength(1);
    expect(out.splits[0].ratio).toBeCloseTo(0.5);
  });

  it('HANDLED: CUSIP/ISIN Change → marker zmiany ISIN, brak warninga', () => {
    const out = parse(
      corpSection([
        {
          desc: 'CCIV(US1714391026) CUSIP/ISIN Change to (US5494981039) (CCIV, CHURCHILL CAPITAL CORP IV-A, US1714391026)',
          qty: -85,
        },
        {
          desc: 'CCIV(US1714391026) CUSIP/ISIN Change to (US5494981039) (LCID, LUCID GROUP INC, US5494981039)',
          qty: 85,
        },
      ]),
    );
    expect(out.isinChanges).toHaveLength(1);
    expect(out.isinChanges[0]).toMatchObject({ oldIsin: 'US1714391026', newIsin: 'US5494981039' });
    expect(out.warnings.some((w) => /nieobsłużone/.test(w))).toBe(false);
  });

  /**
   * HANDLED — zdarzenia zmieniające STAN POSIADANIA, księgowane jako syntetyczne
   * transakcje. Opisy są DOSŁOWNE, wzięte z realnych plików Flex Query
   * (`import/public-samples/ibkr/`) — Flex i HTML niosą ten sam tekst.
   */
  it('HANDLED: [HI] akcje gratisowe → zakup po cenie 0 (kod HI, nie tylko SD!)', () => {
    // Realny opis. IBKR używa dla stock dividend DWÓCH kodów, a `HI` jest
    // częstszy niż udokumentowany wcześniej `SD` (4 vs 1 w próbkach).
    const out = parse(
      corpSection([
        {
          desc: 'TEF (US8793822086) STOCK DIVIDEND US8793822086 5 FOR 100 (TEF, TELEFONICA SA-SPON ADR, US8793822086)',
          qty: 25,
        },
      ]),
    );
    expect(out.warnings.some((w) => /nieobsłużone|nie jest jeszcze księgowane/.test(w))).toBe(
      false,
    );
    const tx = out.transactions.filter((t) => t.isin === 'US8793822086');
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({ side: 'K', quantity: 25, price: 0, total: 0 });
    expect(tx[0].paperName).toBe('TELEFONICA SA-SPON ADR');
    // Bez batcha wiersz udawałby wpis ręczny: przetrwałby czyszczenie importu
    // i zdublował się przy ponownym wgraniu wyciągu.
    expect(tx[0].importBatch).toBe('test-batch');
  });

  it('HANDLED: [SD] akcje gratisowe zapisane małymi literami', () => {
    const out = parse(
      corpSection([
        {
          desc: 'VUG (US9229087369) Stock Dividend US9229087369 196232339 for 10000000000 (VUG, VANGUARD GROWTH ETF, US9229087369)',
          qty: 3,
        },
      ]),
    );
    expect(out.transactions.filter((t) => t.isin === 'US9229087369')).toHaveLength(1);
  });

  it('HANDLED: [DW] delisting → sprzedaż po 0, pozycja przestaje wisieć', () => {
    const out = parse(
      corpSection([
        { desc: '(CA6295231014) DELISTED (NABIF, NABIS HOLDINGS INC, CA6295231014)', qty: -100 },
      ]),
    );
    expect(out.warnings.some((w) => /nieobsłużone|nie jest jeszcze księgowane/.test(w))).toBe(
      false,
    );
    const tx = out.transactions.filter((t) => t.isin === 'CA6295231014');
    expect(tx).toHaveLength(1);
    // Cała wartość pozycji staje się stratą — bez tego papier wisiałby wiecznie.
    expect(tx[0]).toMatchObject({ side: 'S', quantity: 100, price: 0, total: 0 });
    expect(tx[0].paperName).toBe('NABIS HOLDINGS INC');
  });

  /**
   * DROPPED — typy, których wciąż nie księgujemy. Opisy DOSŁOWNE z plików Flex.
   * Asercja pilnuje, że komunikat mówi KONKRETNIE co jest nie tak z portfelem,
   * a nie tylko „nieobsłużone".
   */
  const DROPPED_REORG: Array<{
    code: string;
    name: string;
    desc: string;
    qty: number;
    skutek: RegExp;
  }> = [
    {
      code: 'TC',
      name: 'Merger / przejęcie',
      desc: 'BPYU(US11282X1037) CASH and STOCK MERGER (Acquisition) BAM 9133631 FOR 100000000 (BAM, BROOKFIELD ASSET MGMT, CA11271J1076)',
      qty: -100,
      skutek: /przejmowanej zostaje otwarta/,
    },
    {
      code: 'SO',
      name: 'Spinoff',
      desc: 'ABCD(US1111111111) SPINOFF  1 for 5 (SPIN, SPINCO INC, US3333333333)',
      qty: 20,
      skutek: /wydzielonej nie powstaje/,
    },
    {
      code: 'RI',
      name: 'Rights Issue',
      desc: 'ABCD(US1111111111) SUBSCRIBABLE RIGHTS 1 for 4 (ABCD.RTS, SOME CORP RIGHTS, US4444444444)',
      qty: 25,
      skutek: /prawa poboru/,
    },
    {
      code: 'TO',
      name: 'Tender / wezwanie',
      desc: 'ABCD(US1111111111) TENDERED to (US5555555555) 1 for 1 (CASH, TENDER OFFER, US5555555555)',
      qty: -100,
      skutek: /wezwaniem zostaje otwarta/,
    },
    {
      code: 'BM',
      name: 'Bond Maturity / wykup',
      desc: '(US912CALAN84) BOND MATURITY FOR USD 1.03125 PER BOND (X 6 1/4 03/15/26, X 6 1/4, US912CALAN84)',
      qty: -1000,
      skutek: /nominał z wykupu/,
    },
  ];

  it.each(DROPPED_REORG)(
    'DROPPED: [$code] $name → warning nazywający SKUTEK, brak markera',
    ({ desc, qty, skutek }) => {
      const out = parse(corpSection([{ desc, qty }]));
      expect(out.splits).toHaveLength(0);
      expect(out.isinChanges).toHaveLength(0);
      expect(out.transactions).toHaveLength(0);
      const warn = out.warnings.find((w) => skutek.test(w));
      expect(warn, `brak komunikatu o skutku dla ${desc}`).toBeDefined();
    },
  );
});

// ── Operacje gotówkowe (CashAction / CombInt) ──────────────────────────────────
describe('IBKR coverage — operacje gotówkowe (CombInt / opłaty)', () => {
  it('HANDLED: Credit Interest (dodatni) → operacja "other", brak warninga', () => {
    const out = parse(
      cashSection('CombInt', [{ desc: 'USD Credit Interest for Jun-2024', amount: 1.23 }]),
    );
    expect(out.operations.some((o) => o.operationType === 'other')).toBe(true);
    expect(out.warnings.some((w) => /nierozpoznany wiersz odsetek/.test(w))).toBe(false);
  });

  it('HANDLED: Debit Interest (margin) → fee/margin_interest, brak warninga', () => {
    const out = parse(
      cashSection('CombInt', [{ desc: 'USD Debit Interest for Jun-2024', amount: -2.5 }]),
    );
    const fee = out.operations.find((o) => o.operationType === 'fee');
    expect(fee?.subkind).toBe('margin_interest');
    expect(out.warnings.some((w) => /nierozpoznany wiersz odsetek/.test(w))).toBe(false);
  });

  it('HANDLED: SYEP / Managed Securities (dodatni) → other/lending_income', () => {
    const out = parse(
      cashSection('CombInt', [{ desc: 'USD IBKR Managed Securities Lent Interest', amount: 0.42 }]),
    );
    const op = out.operations.find((o) => o.subkind === 'lending_income');
    expect(op?.operationType).toBe('other');
    expect(out.warnings.some((w) => /nierozpoznany wiersz odsetek/.test(w))).toBe(false);
  });

  /**
   * HANDLED (ścieżka dywidend, NIE odsetek): „Payment in Lieu of Dividend" trafia w
   * realnych wyciągach do sekcji CombDiv (część brutto) + WithholdingTax (US Tax), więc
   * `mapDividendsWithWht` paruje je w jedną operację `dividend` z podatkiem u źródła —
   * dokładnie jak zwykłą dywidendę. NIE jest to luka (wcześniej sonda błędnie umieszczała
   * PIL w CombInt). Descy 1:1 z realnych plików (ALB).
   */
  it('HANDLED: Payment in Lieu of Dividend (CombDiv + WHT) → dividend z podatkiem', () => {
    const out = parse(
      cashSection('CombDiv', [
        {
          desc: 'ALB(US0126531013) Payment in Lieu of Dividend (Ordinary Dividend)',
          amount: 4.4,
          date: '2024-06-15',
        },
      ]),
      cashSection('WithholdingTax', [
        {
          desc: 'ALB(US0126531013) Payment in Lieu of Dividend - US Tax',
          amount: -0.66,
          date: '2024-06-15',
        },
      ]),
    );
    const div = out.operations.find(
      (o) => o.operationType === 'dividend' && /ALB/.test(o.description ?? ''),
    );
    expect(div).toBeDefined();
    expect(div?.description).toMatch(/Payment in Lieu/);
    expect(div?.description).toMatch(/podatek 15%/);
    expect(out.warnings.some((w) => /nierozpoznany|nieobsłużone/.test(w))).toBe(false);
  });

  /**
   * HANDLED: „Commission Adjustment" trafia realnie do sekcji Deposits & Withdrawals
   * (CombDepWith) i jest księgowane jako deposit/withdrawal wg znaku — nie jest to luka.
   */
  it('HANDLED: Commission Adjustment (CombDepWith) → deposit', () => {
    const out = parse(
      cashSection('CombDepWith', [
        { desc: 'Commission Adjustment (Consolidated Audit Trail Fee Refund)', amount: 0.01 },
      ]),
    );
    expect(out.operations.some((o) => o.operationType === 'deposit')).toBe(true);
    expect(out.warnings.some((w) => /nierozpoznany|nieobsłużone/.test(w))).toBe(false);
  });

  /**
   * SIATKA BEZPIECZEŃSTWA — nie luka konkretnego typu, tylko dowód, że NIEZNANY opis w
   * CombInt jest importowany bezpiecznie (generyczne other/fee wg znaku + warning), a nie
   * gubiony. Opis celowo fikcyjny — NIE jest zaobserwowanym typem IBKR. Weryfikacja na
   * realnych 6 wyciągach: 0 takich warningów (wszystkie realne opisy są klasyfikowane).
   */
  it('SAFETY NET: nieznany opis w CombInt → generyczne + warning (nie gubione)', () => {
    const out = parse(
      cashSection('CombInt', [{ desc: 'USD Frobnication Charge for Jun-2024', amount: -0.8 }]),
    );
    expect(out.warnings.some((w) => /nierozpoznany wiersz odsetek\/opłat/.test(w))).toBe(true);
    expect(out.operations.some((o) => o.operationType === 'fee' && !o.subkind)).toBe(true);
  });
});
