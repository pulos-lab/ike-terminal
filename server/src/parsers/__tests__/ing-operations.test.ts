import { describe, it, expect } from 'vitest';
import { isIngOperationsFormat, parseIngOperations, parseIngDescQty } from '../ing-operations.js';

/**
 * Testy parsera historii finansowej ING BM (historiaFinansowa_*.csv).
 *
 * Księga per waluta, bez nagłówka, od najnowszych. Kluczowe zachowania:
 * rozliczenia sprzedaży i blokady = SKIP + harvest (orderId, ISIN); dywidendy
 * brutto+podatek+anulata parowane w operacje netto; wykup przymusowy →
 * RedemptionMarker z jawnym qty/ceną; wypłata nazywa się "Blokada;PZE/…"
 * (średnik w cytowanym polu).
 */

const buildCsv = (lines: string[]) => lines.map((l, i) => `${i + 1};${l}`).join('\r\n');

const SALDO_END = `24-08-2026;;Saldo końcowe;;0.00;PLN`;
const SALDO_START = `01-07-2023;;Saldo początkowe;;554.50;PLN`;

describe('isIngOperationsFormat', () => {
  it('wykrywa księgę PLN po kształcie wiersza i tokenach treści', () => {
    const csv = buildCsv([
      SALDO_END,
      `27-11-2024;Wpłaty/wypłaty;WPL/3977466/Zasilenie rachunku;58000.00;82052.22;PLN`,
    ]);
    expect(isIngOperationsFormat(csv)).toBe(true);
  });

  it('wykrywa księgę GBP (same dywidendy DVCA)', () => {
    const csv = buildCsv([
      `18-08-2026;Dywidendy;DVCA Dywidenda pieniężna GB00B1YKG049: 360 x 0,15 GBP - rozliczenie;54.00;240.12;GBP`,
    ]);
    expect(isIngOperationsFormat(csv)).toBe(true);
  });

  it('NIE łapie plików z nagłówkiem w pierwszej linii ani innych brokerów', () => {
    // NIBC-podobny eksport bankowy: kształt "lp;data;…" mają dopiero wiersze
    // danych, pierwsza linia to nagłówek → detekcja odpada na pierwszej linii.
    expect(isIngOperationsFormat('Lp;Data;Opis;Kwota;Saldo;Waluta\n1;01-01-2024;coś;1;1;PLN')).toBe(
      false,
    );
    expect(isIngOperationsFormat('Data,Opis,Kwota\n01.01.2024,WYC.BK: 1,100')).toBe(false);
    expect(isIngOperationsFormat('data;tytuł operacji;szczegóły;kwota;waluta\n')).toBe(false);
    // Wiersz księgi bez znanego tokenu treści — kształt nie wystarcza.
    expect(isIngOperationsFormat('1;01-01-2024;Inne;przelew;1.00;1.00;PLN')).toBe(false);
    expect(isIngOperationsFormat('')).toBe(false);
  });

  it('transakcje ING nie łapią się na detekcję operacji', () => {
    expect(
      isIngOperationsFormat(
        '29-08-2023 14:25:33;843790613;ETFSP500;Kupno;35;190,20;6 657,00;24.63;6 681,63',
      ),
    ).toBe(false);
  });
});

describe('parseIngDescQty — kropka w opisach to separator tysięcy', () => {
  it.each([
    ['1.000', 1000],
    ['4.900', 4900],
    ['2.000', 2000],
    ['360', 360],
    ['105', 105],
  ])('%s → %d', (token, expected) => {
    expect(parseIngDescQty(token)).toBe(expected);
  });
});

describe('parseIngOperations — łańcuch klasyfikacji', () => {
  it('wpłata WPL i wypłata "Blokada;PZE/…" (cytowany średnik) po znaku kwoty', () => {
    const csv = buildCsv([
      SALDO_END,
      `30-07-2025;Wpłaty/wypłaty;"Blokada;PZE/4279207/Z 84197451 NA PL03105010251000009228672573";-8770.63;0.00;PLN`,
      `27-11-2024;Wpłaty/wypłaty;WPL/3977466/Zasilenie rachunku;58000.00;82052.22;PLN`,
      SALDO_START,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(2);
    expect(result.data.find((o) => o.operationType === 'withdrawal')).toMatchObject({
      amount: -8770.63,
      currency: 'PLN',
      date: '2025-07-30T00:00:00',
    });
    expect(result.data.find((o) => o.operationType === 'deposit')).toMatchObject({
      amount: 58000,
    });
    // Salda = summary_row, nie lądują w kwarantannie (brak raw).
    const summaries = result.skipped.filter((s) => s.reason === 'summary_row');
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.raw === undefined)).toBe(true);
  });

  it('rozliczenia sprzedaży i blokady → skip + harvest orderId→ISIN', () => {
    const csv = buildCsv([
      `29-07-2025;Transakcje;Rozliczenie transakcji sprzedaży nr 1128 do zlecenia 937900176, PLPKN0000018, 78 x 83,84;6515.32;6515.32;PLN`,
      `27-11-2024;Blokady pod zlecenia;Anulata zlecenia kupna 905689000, PLMSTZB00018, 500 x 4.1500;1705.94;24052.22;PLN`,
      `23-09-2024;Blokady pod zlecenia;Blokada pod zlecenie kupna 898494523, PLBCT0000020, 1500 x 1.4000;-2107.77;7644.36;PLN`,
      `09-10-2024;Blokady pod zlecenia;Blokada pod zapis na IPO, 901072676, LU2910446546, 3285x21.5;-70627.50;10.54;PLN`,
      `25-11-2024;Transakcje;Aktualizacja blokady;4682.61;22346.28;PLN`,
      `13-09-2024;Blokady pod zlecenia;Zwolnienie blokady pod zlecenie kupna 895552634, PLBCT0000020, 1500 x 1.4200;2137.88;9752.13;PLN`,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(0); // nic nie księgujemy — sam skip
    expect(result.skipped.every((s) => s.reason === 'settlement_record')).toBe(true);
    expect(result.orderIsinMap.get('937900176')).toBe('PLPKN0000018');
    expect(result.orderIsinMap.get('905689000')).toBe('PLMSTZB00018');
    expect(result.orderIsinMap.get('898494523')).toBe('PLBCT0000020');
    expect(result.orderIsinMap.get('901072676')).toBe('LU2910446546');
    expect(result.orderIsinMap.get('895552634')).toBe('PLBCT0000020');
  });

  it('konflikt ISIN dla jednego zlecenia → wpis usunięty + warning', () => {
    const csv = buildCsv([
      `01-01-2024;Blokady pod zlecenia;Blokada pod zlecenie kupna 111, PLPKN0000018, 1 x 1.00;-1.00;0.00;PLN`,
      `02-01-2024;Blokady pod zlecenia;Blokada pod zlecenie kupna 111, PLPZU0000011, 1 x 1.00;-1.00;0.00;PLN`,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.orderIsinMap.has('111')).toBe(false);
    expect(result.warnings?.some((w) => w.includes('111'))).toBe(true);
  });
});

describe('parseIngOperations — dywidendy', () => {
  it('brutto + podatek parowane po ISIN i dacie w jedną operację netto', () => {
    const csv = buildCsv([
      `20-12-2024;Dywidendy;DVCA Dywidenda pieniężna PLPKN0000018: 105 x 4,15 PLN - rozliczenie;435.75;5701.99;PLN`,
      `20-12-2024;Dywidendy;DVCA Dywidenda pieniężna PLPKN0000018: 105 x 4,15 PLN - podatek;-83.00;5618.99;PLN`,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      operationType: 'dividend',
      amount: 352.75,
      currency: 'PLN',
      ticker: 'PLPKN0000018', // konwencja mBank: ISIN w polu ticker
    });
    expect(result.data[0].description).toContain('105 szt × 4.15 PLN');
    expect(result.data[0].description).toContain('podatek 19%');
  });

  it('każdy wiersz podatku parowany tylko RAZ (dwie dywidendy tego samego dnia)', () => {
    const csv = buildCsv([
      `10-06-2024;Dywidendy;DVCA Dywidenda pieniężna PLINTRL00013: 460 x 0,34 PLN - rozliczenie;156.40;500.00;PLN`,
      `10-06-2024;Dywidendy;DVCA Dywidenda pieniężna PLINTRL00013: 460 x 0,34 PLN - podatek;-30.00;470.00;PLN`,
      `10-06-2024;Dywidendy;DVCA Dywidenda pieniężna PLPZU0000011: 125 x 4,34 PLN - rozliczenie;542.50;1012.50;PLN`,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(2);
    const intrl = result.data.find((o) => o.ticker === 'PLINTRL00013');
    const pzu = result.data.find((o) => o.ticker === 'PLPZU0000011');
    expect(intrl?.amount).toBe(126.4);
    expect(pzu?.amount).toBe(542.5); // bez podatku — cudzy podatek nie odjęty
  });

  it('dywidenda GBP bez wiersza podatku (brutto = netto, ilość z kropką tysięcy)', () => {
    const csv = buildCsv([
      `18-08-2026;Dywidendy;DVCA Dywidenda pieniężna GB00B1YKG049: 360 x 0,15 GBP - rozliczenie;54.00;1086.12;GBP`,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data[0]).toMatchObject({ amount: 54, currency: 'GBP' });
    expect(result.data[0].description).not.toContain('podatek');
  });

  it('Anulata netuje brutto o tej samej kwocie; poprawione księgowanie zostaje', () => {
    // Realny przypadek z pliku GBP: +25.92, storno −25.92, ponowne +28.80.
    const csv = buildCsv([
      `28-05-2025;Dywidendy;DVCA Dywidenda pieniężna GB00B1YKG049: 360 x 0,08 GBP - rozliczenie;25.92;137.16;GBP`,
      `28-05-2025;Dywidendy;Anulata: DVCA Dywidenda pieniężna GB00B1YKG049: 360 x 0,08 GBP - rozliczenie;-25.92;111.24;GBP`,
      `28-05-2025;Dywidendy;DVCA Dywidenda pieniężna GB00B1YKG049: 360 x 0,08 GBP - rozliczenie;28.80;140.04;GBP`,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].amount).toBe(28.8);
  });

  it('niesparowana Anulata i niesparowany podatek → samodzielne korekty + warningi', () => {
    const csv = buildCsv([
      `28-05-2025;Dywidendy;Anulata: DVCA Dywidenda pieniężna GB00B1YKG049: 360 x 0,08 GBP - rozliczenie;-28.80;0.00;GBP`,
      `20-12-2024;Dywidendy;DVCA Dywidenda pieniężna PLPKN0000018: 105 x 4,15 PLN - podatek;-83.00;0.00;PLN`,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(2);
    expect(result.data.every((o) => o.operationType === 'dividend' && o.amount < 0)).toBe(true);
    expect(result.warnings?.some((w) => w.includes('storno'))).toBe(true);
    expect(result.warnings?.some((w) => w.includes('podatek'))).toBe(true);
  });
});

describe('parseIngOperations — wykup przymusowy', () => {
  it('emituje RedemptionMarker z jawnym qty i ceną z opisu (pusta kategoria!)', () => {
    const csv = buildCsv([
      `19-08-2026;;LAP1 Wykup przymusowy GB00B1YKG049: 360 x 2,35 GBP - rozliczenie;846.00;1086.12;GBP`,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(0); // cash wejdzie przez syntetyczną S
    expect(result.redemptions).toHaveLength(1);
    expect(result.redemptions[0]).toMatchObject({
      source: 'ing',
      kind: 'tender',
      isin: 'GB00B1YKG049',
      quantity: 360,
      tenderPrice: 2.35,
      amount: 846,
      currency: 'GBP',
      date: '2026-08-19T00:00:00',
    });
    expect(result.skipped[0]?.reason).toBe('redemption_reconciled');
  });
});

describe('parseIngOperations — polityka kwarantanny', () => {
  it('nieznany opis w kategorii Wpłaty/wypłaty → zaksięgowany + sygnał BEZ raw', () => {
    const csv = buildCsv([`01-02-2024;Wpłaty/wypłaty;Przelew wewnętrzny XYZ;150.00;150.00;PLN`]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data[0]).toMatchObject({ operationType: 'deposit', amount: 150 });
    const skip = result.skipped.find((s) => s.reason === 'unknown_operation_type');
    expect(skip).toBeDefined();
    expect(skip?.raw).toBeUndefined(); // zaksięgowane → bez ticketu kwarantanny
  });

  it('nieznany opis w kategorii Dywidendy → other + sygnał bez raw', () => {
    const csv = buildCsv([`01-02-2024;Dywidendy;Wyrównanie dywidendy XYZ;12.34;12.34;PLN`]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data[0]?.operationType).toBe('other');
    expect(result.skipped[0]?.raw).toBeUndefined();
  });

  it('nieznany opis w kategorii transakcyjnej/pustej → NIE księgowany, kwarantanna z raw', () => {
    const csv = buildCsv([
      `01-02-2024;Transakcje;Korekta rozliczenia XYZ;99.00;99.00;PLN`,
      `02-02-2024;;NIEZNANE ZDARZENIE ABC;10.00;10.00;PLN`,
    ]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    for (const s of result.skipped) {
      expect(s.reason).toBe('unknown_operation_type');
      expect(s.raw?.cells.length).toBeGreaterThan(0);
      expect(s.raw?.hint?.amount).toBeDefined();
    }
  });

  it('pusta kwota przy nieznanym opisie → zero_amount (nie kwarantanna)', () => {
    const csv = buildCsv([`01-02-2024;Transakcje;Notatka bez kwoty;;0.00;PLN`]);
    const result = parseIngOperations(csv, 'batch-test');
    expect(result.skipped[0]?.reason).toBe('zero_amount');
  });
});
