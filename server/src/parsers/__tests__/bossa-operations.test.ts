import { describe, it, expect } from 'vitest';
import { parseBossaOperations, isBossaOperationsFormat } from '../bossa-operations.js';

/**
 * Testy klasyfikacji zdarzeń korporacyjnych przez parser Bossa po P17.
 *
 * Przed P17:
 *   - "Obniżenie wartości nominalnej GETIN" → `deposit` (zawyżało mianownik MWR).
 *   - "Wykup PW - wyrównanie SOLV" → `unknown → other` (ukryte).
 *   - "Rozliczenie oferty X" (ticker spoza mapy) → `deposit` (phantom wpłata).
 *
 * Po P17:
 *   - Obniżenie nominału → `CapitalReturnMarker(kind='nominal_reduction')`, `skipped: capital_return_reconciled`.
 *   - Wykup PW wyrównanie → `CapitalReturnMarker(kind='redemption_adjustment')`, `skipped: capital_return_reconciled`.
 *   - Nieznany tender → `CashOperation(operation_type='corporate_action_pending', subkind='unknown_tender')`.
 */

const CSV_HEADER = 'data;tytuł operacji;szczegóły;kwota;waluta';

function buildCsv(lines: string[]): string {
  return [CSV_HEADER, ...lines].join('\n');
}

describe('isBossaOperationsFormat', () => {
  it('detects real Bossa operations header', () => {
    expect(isBossaOperationsFormat(CSV_HEADER + '\n')).toBe(true);
  });

  it('NIE klasyfikuje pierwszej linii zawierającej słowa data/kwota/tytuł operacji luzem', () => {
    // Stary detektor (substring na pierwszej linii w import-service) dawał tu false-positive.
    expect(isBossaOperationsFormat('raport: data i kwota oraz tytuł operacji\n')).toBe(false);
  });

  it('NIE klasyfikuje nagłówka operacji mBank (Data,Opis,Kwota)', () => {
    expect(isBossaOperationsFormat('Data,Opis,Kwota\n')).toBe(false);
  });

  it('rejects empty content', () => {
    expect(isBossaOperationsFormat('')).toBe(false);
  });
});

describe('parseBossaOperations — P17 corporate actions', () => {
  it('Obniżenie wartości nominalnej → CapitalReturnMarker(nominal_reduction), NIE deposit', () => {
    const csv = buildCsv(['2022-12-30;Obniżenie wartości nominalnej GETIN;;8250.00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    // Żadnego CashOperation('deposit') dla tego wiersza
    expect(result.data.find((op) => op.operationType === 'deposit')).toBeUndefined();

    // CapitalReturnMarker powinien się pojawić
    expect(result.capitalReturns).toHaveLength(1);
    const marker = result.capitalReturns[0];
    expect(marker.kind).toBe('nominal_reduction');
    expect(marker.ticker).toBe('GETIN');
    expect(marker.amount).toBe(8250);
    expect(marker.currency).toBe('PLN');
    expect(marker.source).toBe('bossa');
    expect(marker.description).toBe('Zwrot kapitału GETIN (obniżenie nominału)');

    // Skipped z nowym reasonem
    const skipRow = result.skipped.find((s) => s.reason === 'capital_return_reconciled');
    expect(skipRow).toBeDefined();
  });

  it('Wykup PW - wyrównanie → CapitalReturnMarker(redemption_adjustment)', () => {
    const csv = buildCsv(['2024-04-10;Wykup PW - wyrównanie SOLV (kwota brutto);;-15.76;USD']);
    const result = parseBossaOperations(csv, 'batch-test');

    // Nie trafia do CashOperation
    expect(result.data).toHaveLength(0);

    expect(result.capitalReturns).toHaveLength(1);
    const marker = result.capitalReturns[0];
    expect(marker.kind).toBe('redemption_adjustment');
    expect(marker.ticker).toBe('SOLV');
    expect(marker.amount).toBe(-15.76); // korekta ujemna — zachowujemy znak
    expect(marker.currency).toBe('USD');
    expect(marker.description).toBe('Wyrównanie wykupu SOLV');
  });

  it('Rozliczenie oferty TICKER dla nieznanego tickera → corporate_action_pending/unknown_tender', () => {
    const csv = buildCsv(['2025-11-05;Rozliczenie oferty XYZ123;;3500.00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    // Nieznany tender NIE wchodzi przez RedemptionMarker
    expect(result.redemptions).toHaveLength(0);
    // NIE powstaje synthetic deposit
    expect(result.data.find((op) => op.operationType === 'deposit')).toBeUndefined();

    // Powstaje pending entry
    const pending = result.data.find((op) => op.operationType === 'corporate_action_pending');
    expect(pending).toBeDefined();
    expect(pending?.subkind).toBe('unknown_tender');
    expect(pending?.amount).toBe(3500);
    expect(pending?.description).toBe('Wykup w ofercie skupu XYZ123');
  });

  it('Zwykły przelew → deposit (nietknięty przez P17)', () => {
    const csv = buildCsv(['2024-01-15;Przelew do DM BO;;10000.00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('deposit');
    expect(result.capitalReturns).toHaveLength(0);
  });

  it('Dywidenda → dividend (nietknięta przez P17)', () => {
    const csv = buildCsv(['2024-06-15;Wypłata dywidendy PLAYWAY;;1234.56;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('dividend');
    expect(result.data[0].ticker).toBe('PLAYWAY');
    expect(result.capitalReturns).toHaveLength(0);
  });

  it('Obniżenie nominału z ż + obniżenie nominału bez diakrytyków (unicode escape) — oba łapane', () => {
    const csv = buildCsv([
      '2022-12-30;Obniżenie wartości nominalnej GETIN;;8250.00;PLN',
      '2022-12-30;Obni\u017cenie warto\u015bci nominalnej ABCD;;1000.00;PLN',
    ]);
    const result = parseBossaOperations(csv, 'batch-test');
    expect(result.capitalReturns).toHaveLength(2);
    expect(result.capitalReturns.map((m) => m.ticker).sort()).toEqual(['ABCD', 'GETIN']);
  });

  it('Zwrot nadpłaty przekroczony limit (ujemny amount) → withdrawal, NIE deposit', () => {
    // Wcześniej classifyOperation zwracało 'deposit' dla wszystkich "Zwrot nadpłaty".
    // Dla wariantu "przekroczony limit IKE/IKZE" kwota jest UJEMNA (broker zwraca
    // nadpłatę ponad limit) — engine filtrował ujemne deposity i zniknęło z MWR.
    // Fix: parser sprawdza znak po classifyOperation i reklasyfikuje na withdrawal.
    const csv = buildCsv([
      '2020-03-03;Zwrot nadpłaty - przekroczony limit wpłat na IKE/IKZE;;-466.24;PLN',
    ]);
    const result = parseBossaOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('withdrawal');
    expect(result.data[0].amount).toBe(-466.24);
  });

  it('Zwykły zwrot nadpłaty z IPO (dodatni amount, nieznana spółka) → deposit', () => {
    // Regresja — nie chcemy przełączać deposit→withdrawal gdy kwota dodatnia.
    const csv = buildCsv(['2022-03-15;Zwrot nadpłaty UNKNOWNCO S.A.;;150.00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('deposit');
    expect(result.data[0].amount).toBe(150);
  });

  it('pusty plik (brak headerów) → empty result z capitalReturns', () => {
    const result = parseBossaOperations('', 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.capitalReturns).toHaveLength(0);
    expect(result.redemptions).toHaveLength(0);
    expect(result.ipoSubscriptions).toHaveLength(0);
  });
});

describe('parseBossaOperations — osierocone legi subskrypcji IPO', () => {
  it('Zapisy na akcje bez Zwrotu nadpłaty → warning, brak markera, cashflow zachowany', () => {
    const csv = buildCsv(['2021-03-15;Zapisy na akcje BIOCELTIX S.A. SERIA G;;-10000.00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    // Brak markera (para niekompletna)
    expect(result.ipoSubscriptions).toHaveLength(0);

    // Cashflow NIE ginie — leci jako withdrawal
    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('withdrawal');
    expect(result.data[0].amount).toBe(-10000);

    // Warning po polsku z prośbą o ręczną weryfikację pozycji
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain('Zapisy na akcje BIOCELTIX S.A. SERIA G');
    expect(result.warnings![0]).toContain('Zwrot nadpłaty');
    expect(result.warnings![0]).toContain('ręcznie');
  });

  it('Zwrot nadpłaty bez Zapisów na akcje → warning, brak markera, deposit zachowany', () => {
    const csv = buildCsv(['2021-04-10;Zwrot nadpłaty BIOCELTIX;;8000.00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.ipoSubscriptions).toHaveLength(0);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('deposit');

    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('Zwrot nadpłaty BIOCELTIX');
    expect(result.warnings![0]).toContain('Zapisy na akcje');
  });

  it('kompletna para ze znanej emisji → marker, bez warningów', () => {
    // BIOCELTIX 2021-03-15 jest w ipo-subscriptions-map
    const csv = buildCsv([
      '2021-03-15;Zapisy na akcje BIOCELTIX S.A. SERIA G;;-10000.00;PLN',
      '2021-04-10;Zwrot nadpłaty BIOCELTIX;;8000.00;PLN',
    ]);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.ipoSubscriptions).toHaveLength(1);
    expect(result.ipoSubscriptions[0].ticker).toBe('BIOCELTIX');
    expect(result.warnings).toBeUndefined();
  });

  it('kompletna para spoza mapy emisji → warning o nierozliczonej subskrypcji, cashflow zachowany', () => {
    const csv = buildCsv([
      '2023-05-01;Zapisy na akcje FOOCORP S.A.;;-5000.00;PLN',
      '2023-05-20;Zwrot nadpłaty FOOCORP;;3000.00;PLN',
    ]);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.ipoSubscriptions).toHaveLength(0);
    // Oba legi wpadają jako zwykłe operacje (withdrawal + deposit)
    expect(result.data.map((o) => o.operationType).sort()).toEqual(['deposit', 'withdrawal']);

    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('FOOCORP');
    expect(result.warnings![0]).toContain('mapie znanych emisji');
  });
});
