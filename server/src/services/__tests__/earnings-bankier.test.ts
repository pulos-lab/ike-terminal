import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseBankierCalendar,
  parseBankierLongDate,
  isoFromBankierTimestamp,
  classifyBankierReport,
  isEarningsBadge,
  bankierCompanyUrl,
} from '../earnings/bankier-earnings.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(
  path.join(dir, 'fixtures', 'bankier-kalendarium-cdprojekt.html'),
  'utf-8',
);

describe('isoFromBankierTimestamp', () => {
  it('nie cofa daty o dzień mimo czasu warszawskiego', () => {
    // 1773874800 to północ 19.03.2026 czasu CET (= 18.03 23:00 UTC).
    // Naiwne toISOString() dałoby tu 2026-03-18.
    expect(isoFromBankierTimestamp('1773874800')).toBe('2026-03-19');
  });

  it('działa też w czasie letnim (CEST, UTC+2)', () => {
    // 1788300000 to północ 2.09.2026 czasu CEST (= 1.09 22:00 UTC).
    expect(isoFromBankierTimestamp('1788300000')).toBe('2026-09-02');
  });

  it('odrzuca śmieci', () => {
    expect(isoFromBankierTimestamp(undefined)).toBeNull();
    expect(isoFromBankierTimestamp('abc')).toBeNull();
    expect(isoFromBankierTimestamp('0')).toBeNull();
  });
});

describe('parseBankierLongDate', () => {
  it('parsuje wszystkie miesiące w dopełniaczu', () => {
    const cases: Array<[string, string]> = [
      ['1 Stycznia 2026 ● Czwartek', '2026-01-01'],
      ['12 Lutego 2026', '2026-02-12'],
      ['19 Marca 2026 ● Czwartek', '2026-03-19'],
      ['2 Kwietnia 2026', '2026-04-02'],
      ['28 Maja 2026 ● Czwartek', '2026-05-28'],
      ['23 Czerwca 2026 ● Wtorek', '2026-06-23'],
      ['28 Lipca 2026', '2026-07-28'],
      ['31 Sierpnia 2026', '2026-08-31'],
      ['2 Września 2026 ● Środa', '2026-09-02'],
      ['27 Października 2026', '2026-10-27'],
      ['24 Listopada 2026 ● Wtorek', '2026-11-24'],
      ['31 Grudnia 2026', '2026-12-31'],
    ];
    for (const [input, expected] of cases) {
      expect(parseBankierLongDate(input), input).toBe(expected);
    }
  });

  it('zwraca null dla nierozpoznanego tekstu', () => {
    expect(parseBankierLongDate('wkrótce')).toBeNull();
    expect(parseBankierLongDate('19 Marzec 2026')).toBeNull();
  });
});

describe('classifyBankierReport', () => {
  it('rozpoznaje raport kwartalny, półroczny i roczny', () => {
    expect(
      classifyBankierReport('Publikacja skonsolidowanego raportu za I kwartał 2026 roku.'),
    ).toEqual({
      fiscalLabel: 'I kwartał 2026',
      reportKind: 'quarterly',
    });
    expect(classifyBankierReport('Publikacja raportu za IV kwartał 2025 roku.')).toEqual({
      fiscalLabel: 'IV kwartał 2025',
      reportKind: 'quarterly',
    });
    expect(
      classifyBankierReport('Publikacja skonsolidowanego raportu za I półrocze 2026 roku.'),
    ).toEqual({
      fiscalLabel: 'I półrocze 2026',
      reportKind: 'semiannual',
    });
    expect(
      classifyBankierReport('Publikacja jednostkowego oraz skonsolidowanego raportu za 2025 rok.'),
    ).toEqual({ fiscalLabel: 'rok 2025', reportKind: 'annual' });
  });

  it('nie zgaduje okresu, gdy opis go nie podaje', () => {
    expect(classifyBankierReport('Publikacja raportu okresowego.')).toEqual({
      fiscalLabel: null,
      reportKind: null,
    });
  });
});

describe('isEarningsBadge', () => {
  it('przepuszcza wyłącznie publikacje wyników', () => {
    expect(isEarningsBadge('Wyniki spółek')).toBe(true);
    expect(isEarningsBadge('  wyniki spółek ')).toBe(true);
    expect(isEarningsBadge('WZA')).toBe(false);
    expect(isEarningsBadge('Dywidendy')).toBe(false);
    expect(isEarningsBadge('Splity')).toBe(false);
  });
});

describe('parseBankierCalendar', () => {
  it('wyciąga wyłącznie publikacje raportów, pomijając WZA', () => {
    const rows = parseBankierCalendar(fixture, 'CDPROJEKT');
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.reportDate)).toEqual([
      '2026-03-19',
      '2026-05-28',
      '2026-09-02',
      '2026-11-24',
    ]);
    // WZA z 11 marca i 23 czerwca nie mogą się przedostać.
    expect(rows.some((r) => r.reportDate === '2026-03-11' || r.reportDate === '2026-06-23')).toBe(
      false,
    );
  });

  it('opisuje okres i rodzaj raportu', () => {
    const rows = parseBankierCalendar(fixture, 'CDPROJEKT');
    expect(rows[0]).toMatchObject({ fiscalLabel: 'rok 2025', reportKind: 'annual' });
    expect(rows[1]).toMatchObject({ fiscalLabel: 'I kwartał 2026', reportKind: 'quarterly' });
    expect(rows[2]).toMatchObject({ fiscalLabel: 'I półrocze 2026', reportKind: 'semiannual' });
    expect(rows[3]).toMatchObject({ fiscalLabel: 'III kwartał 2026', reportKind: 'quarterly' });
  });

  it('terminy z obowiązkowego raportu spółki są potwierdzone i bez zmyślonej pory sesji', () => {
    const rows = parseBankierCalendar(fixture, 'CDPROJEKT');
    for (const row of rows) {
      expect(row.confidence).toBe('confirmed');
      expect(row.session).toBeNull();
      expect(row.market).toBe('PL');
      expect(row.symbolKey).toBe('CDPROJEKT');
      expect(row.source).toBe('bankier');
    }
  });

  it('pusty lub obcy HTML nie wysypuje parsera', () => {
    expect(parseBankierCalendar('', 'CDPROJEKT')).toEqual([]);
    expect(parseBankierCalendar('<html><body><p>nic</p></body></html>', 'CDPROJEKT')).toEqual([]);
  });

  it('bez sluga domyślnego i bez linku spółki wiersz jest pomijany', () => {
    expect(parseBankierCalendar(fixture)).toEqual([]);
  });
});

describe('bankierCompanyUrl', () => {
  it('składa adres strony kalendarium spółki', () => {
    expect(bankierCompanyUrl('CDPROJEKT')).toBe(
      'https://www.bankier.pl/gielda/notowania/akcje/CDPROJEKT/kalendarium',
    );
  });
});
