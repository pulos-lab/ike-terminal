import { describe, it, expect } from 'vitest';
import { parseBossaOperations } from '../bossa-operations.js';

const CSV_HEADER = 'data;tytuł operacji;szczegóły;kwota;waluta';

function buildCsv(lines: string[]): string {
  return [CSV_HEADER, ...lines].join('\n');
}

describe('parseBossaOperations — kupony obligacji', () => {
  it('"Wypłata odsetek DS1030" → dividend + subkind=coupon + ticker', () => {
    const csv = buildCsv(['2024-04-25;Wypłata odsetek DS1030;;125,00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('dividend');
    expect(result.data[0].subkind).toBe('coupon');
    expect(result.data[0].ticker).toBe('DS1030');
    expect(result.data[0].description).toBe('Kupon DS1030');
  });

  it('"Odsetki FPC0733" (bez "Wypłata") → coupon', () => {
    const csv = buildCsv(['2024-07-21;Odsetki FPC0733;;56,25;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.data[0].operationType).toBe('dividend');
    expect(result.data[0].subkind).toBe('coupon');
    expect(result.data[0].ticker).toBe('FPC0733');
  });

  it('"Wypłata kuponu KGH0631" → coupon (korporacyjna z bond-map)', () => {
    const csv = buildCsv(['2024-06-26;Wypłata kuponu KGH0631;;257,50;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.data[0].operationType).toBe('dividend');
    expect(result.data[0].subkind).toBe('coupon');
  });

  it('"Odsetki od środków pieniężnych" → NIE coupon (odsetki od salda, nie obligacja)', () => {
    const csv = buildCsv(['2024-04-25;Odsetki od środków pieniężnych;;1,23;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('other');
    expect(result.data[0].subkind).toBeUndefined();
    // nieznany tytuł → warning w skipped
    expect(result.skipped.some((s) => s.reason === 'unknown_operation_type')).toBe(true);
  });
});

describe('parseBossaOperations — wykup obligacji', () => {
  it('"Wykup obligacji DS1030" → RedemptionMarker kind=bond z nominałem z mapy', () => {
    const csv = buildCsv(['2030-10-25;Wykup obligacji DS1030;;10000,00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.redemptions).toHaveLength(1);
    expect(result.redemptions[0].kind).toBe('bond');
    expect(result.redemptions[0].ticker).toBe('DS1030');
    expect(result.redemptions[0].nominal).toBe(1000);
    expect(result.redemptions[0].amount).toBe(10000);
    expect(result.skipped.some((s) => s.reason === 'redemption_reconciled')).toBe(true);
  });

  it('"Wykup papierów wartościowych FPC0733" → RedemptionMarker kind=bond', () => {
    const csv = buildCsv(['2033-07-21;Wykup papierów wartościowych FPC0733;;5000,00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.redemptions).toHaveLength(1);
    expect(result.redemptions[0].kind).toBe('bond');
    expect(result.redemptions[0].ticker).toBe('FPC0733');
  });

  it('"Wykup obligacji NIEZNANY123" (ticker nie wygląda na obligację) → fallback other + warning', () => {
    const csv = buildCsv(['2030-01-01;Wykup obligacji NIEZNANY123;;1000,00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.redemptions).toHaveLength(0);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('other');
    expect(result.skipped.some((s) => s.reason === 'unknown_operation_type')).toBe(true);
  });

  it('brak kolizji: "Wykup certyfikatów INTLGLD46805" zostaje certificate', () => {
    const csv = buildCsv(['2024-05-10;Wykup certyfikatów INTLGLD46805;;2500,00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.redemptions).toHaveLength(1);
    expect(result.redemptions[0].kind).toBe('certificate');
  });

  it('brak kolizji: "Wykup PW - wyrównanie SOLV" zostaje CapitalReturnMarker', () => {
    const csv = buildCsv(['2024-05-10;Wykup PW - wyrównanie SOLV;;15,00;PLN']);
    const result = parseBossaOperations(csv, 'batch-test');

    expect(result.redemptions).toHaveLength(0);
    expect(result.capitalReturns).toHaveLength(1);
    expect(result.capitalReturns[0].kind).toBe('redemption_adjustment');
  });
});
