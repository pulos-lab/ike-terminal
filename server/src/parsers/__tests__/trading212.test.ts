import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseT212File, isT212Format } from '../trading212/index.js';
import { classifyT212Action } from '../trading212/t212-actions.js';
import { mapT212Columns, parseT212Time } from '../trading212/t212-columns.js';
import { classifyFile } from '../../services/import-service.js';

const SAMPLES = path.resolve(__dirname, '../../../../import/public-samples/trading212');
const hasSamples = fs.existsSync(SAMPLES);
const sample = (rel: string) => fs.readFileSync(path.join(SAMPLES, rel));

const HEADER =
  'Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,Total,Currency (Total),Withholding tax,Currency (Withholding tax),Notes,ID';
const csv = (...rows: string[]) => Buffer.from([HEADER, ...rows].join('\n'), 'utf8');

// ── Jednostkowe: pułapki formatu ────────────────────────────────────────────

describe('Trading 212 — klasyfikacja Action', () => {
  it('"Market look" NIE jest transakcją mimo prefiksu "Market"', () => {
    // Realna próbka (Sidekick, katalog Invalid/) wygląda identycznie jak
    // "Market buy" — ten sam papier, ilość i cena. Dopasowanie po prefiksie
    // zaimportowałoby ją jako zakup.
    expect(classifyT212Action('Market look')).toBeNull();
    expect(classifyT212Action('Market buy')).toEqual({ kind: 'trade', side: 'K' });
  });

  it('"Dividend adjustment" nie wpada w rodzinę dywidend', () => {
    expect(classifyT212Action('Dividend adjustment')).toEqual({ kind: 'dividend_adjustment' });
    expect(classifyT212Action('Dividend (Dividends paid by us corporations)')).toEqual({
      kind: 'dividend',
    });
  });
});

describe('Trading 212 — mapowanie kolumn', () => {
  it('akceptuje alias "Time (UTC)" i BOM', () => {
    const withBom =
      '﻿Action,Time (UTC),ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Total,Currency (Total)';
    const cols = mapT212Columns(withBom.split(','));
    expect(cols).not.toBeNull();
    expect(cols!.time).toBe(1);
  });

  it('radzi sobie z DRUGIM porządkiem kolumn (Notes,ID zaraz po Name)', () => {
    const alt =
      'Action,Time,ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total)';
    const cols = mapT212Columns(alt.split(','));
    expect(cols).not.toBeNull();
    expect(cols!.shares).toBe(7); // nie 5 — dlatego indeksy pozycyjne są wykluczone
    expect(cols!.notes).toBe(5);
  });

  it('odrzuca plik bez kolumn rdzenia', () => {
    expect(mapT212Columns(['Data', 'Opis', 'Kwota'])).toBeNull();
  });

  it('czas: ułamki sekund obcięte, śmieć odrzucony', () => {
    expect(parseT212Time('2025-03-24 07:24:24.095')).toBe('2025-03-24T07:24:24');
    expect(parseT212Time('nie data')).toBeNull();
  });
});

describe('Trading 212 — konwencje kwot', () => {
  it('wypłata z DODATNIĄ kwotą w pliku zostaje wypłatą (znak z typu, nie z pliku)', async () => {
    const r = await parseT212File(
      csv('Withdrawal,2025-02-01 11:00:00,,,,,,,,100.00,EUR,,,,w-1'),
      'b',
    );
    expect(r.operations.data).toHaveLength(1);
    expect(r.operations.data[0].operationType).toBe('withdrawal');
    expect(r.operations.data[0].amount).toBe(-100);
  });

  it('wydatek kartą to wypłata, a zwrot i cashback to wpłaty', async () => {
    const r = await parseT212File(
      csv(
        'Card debit,2025-02-01 11:00:00,,,,,,,,-4.30,EUR,,,,c-1',
        'Card credit,2025-02-02 11:00:00,,,,,,,,4.30,EUR,,,,c-2',
        'Spending cashback,2025-02-03 11:00:00,,,,,,,,1.74,EUR,,,,c-3',
      ),
      'b',
    );
    expect(r.operations.data.map((o) => [o.operationType, o.amount])).toEqual([
      ['withdrawal', -4.3],
      ['deposit', 4.3],
      ['deposit', 1.74],
    ]);
  });

  it('kurs z pliku jest quote-per-payment → fxRate zapisujemy odwrócony', async () => {
    const r = await parseT212File(
      csv(
        'Market buy,2025-03-14 09:30:02,US0378331005,AAPL,Apple,2,100.00,USD,1.10,182.00,EUR,,,,o-1',
      ),
      'b',
    );
    const tx = r.transactions.data[0];
    expect(tx.currency).toBe('USD');
    expect(tx.paymentCurrency).toBe('EUR');
    expect(tx.value).toBe(200);
    expect(tx.fxRate).toBeCloseTo(1 / 1.1, 5); // ~0,909 EUR za 1 USD
  });

  it('"Not available" w kursie nie staje się liczbą', async () => {
    const r = await parseT212File(
      csv(
        'Dividend (Dividend),2025-05-10 08:00:00,US0378331005,AAPL,Apple,4,0.25,USD,Not available,0.85,EUR,0.15,USD,,d-1',
      ),
      'b',
    );
    const [dividend, tax] = r.operations.data;
    expect(dividend.operationType).toBe('dividend');
    expect(dividend.amount).toBe(0.85);
    expect(dividend.currency).toBe('EUR');
    // Podatek u źródła bywa w INNEJ walucie niż kwota, która wpłynęła.
    expect(tax.operationType).toBe('fee');
    expect(tax.amount).toBe(-0.15);
    expect(tax.currency).toBe('USD');
  });

  it('nieznany typ operacji trafia do kwarantanny, nie do importu', async () => {
    const r = await parseT212File(csv('Nowy typ,2025-01-01 10:00:00,,,,,,,,1.00,EUR,,,,x-1'), 'b');
    expect(r.transactions.data).toHaveLength(0);
    expect(r.operations.data).toHaveLength(0);
    const s = r.operations.skipped[0];
    expect(s.reason).toBe('unknown_operation_type');
    // Kwalifikacja do skrzynki jest podwójna (reason + raw) — bez `raw`
    // isQuarantineEligible odrzuca wiersz i ticket nigdy nie powstaje.
    expect(s.raw?.rawType).toBe('nowy typ');
    expect(s.raw?.headers?.[0]).toBe('Action');
    expect(s.raw?.cells[0]).toBe('Nowy typ');
    expect(s.raw?.hint?.date).toBe('2025-01-01');
    expect(s.raw?.hint?.amount).toBe(1);
    expect(s.raw?.hint?.currency).toBe('EUR');
  });

  it('transfer papierów: sprzedaż po cenie z pliku + równoważąca wypłata', async () => {
    const r = await parseT212File(
      csv(
        'Transfer out,2025-02-28 08:25:01,DE000A3GK2N1,XBTI,DDA Bitcoin,595,3.41943,EUR,1.0,2034.56,EUR,,,,t-1',
      ),
      'b',
    );
    const tx = r.transactions.data[0];
    expect(tx.side).toBe('S');
    expect(tx.value).toBe(2034.56);
    expect(tx.syntheticOrigin).toBe('transfer_out');
    // Sama sprzedaż dopisałaby gotówkę, która nigdy nie wpłynęła.
    const wd = r.operations.data[0];
    expect(wd.operationType).toBe('withdrawal');
    expect(wd.amount).toBe(-2034.56);
  });

  it('split: para open+close daje jeden marker ratio, zero transakcji', async () => {
    const r = await parseT212File(
      csv(
        'Stock split close,2025-03-24 07:24:24,CA46500E8678,ISOU,IsoEnergy,29.80478,2.070473,USD,1.0,0.00,EUR,,,,s-1',
        'Stock split open,2025-03-24 07:24:24,CA46500E8678,ISOU,IsoEnergy,7.451195,8.281893,USD,1.0,0.00,EUR,,,,s-2',
      ),
      'b',
    );
    expect(r.transactions.data).toHaveLength(0);
    expect(r.splits).toHaveLength(1);
    expect(r.splits![0].ratio).toBeCloseTo(0.25, 6); // odwrotny 1:4
  });

  it('niesparowana noga splitu ostrzega zamiast zgadywać', async () => {
    const r = await parseT212File(
      csv(
        'Stock split open,2025-03-24 07:24:24,CA46500E8678,ISOU,IsoEnergy,7.45,8.28,USD,1.0,0.00,EUR,,,,s-2',
      ),
      'b',
    );
    expect(r.splits ?? []).toHaveLength(0);
    expect(r.warnings?.join(' ')).toContain('niesparowana noga splitu');
  });

  it('wymiana walut ze starego wariantu: kwoty czytane z opisu', async () => {
    const r = await parseT212File(
      csv('Currency conversion,2023-09-25 17:31:38,,,,,,,,,,,,0.50 GBP -> 0.58 EUR,fx-1'),
      'b',
    );
    const [from, to] = r.operations.data;
    expect(from.operationType).toBe('fx_exchange');
    expect([from.amount, from.currency]).toEqual([-0.5, 'GBP']);
    expect([to.amount, to.currency]).toEqual([0.58, 'EUR']);
  });
});

// ── Regresja: rozpoznawanie roli pliku po dodaniu T212 do ścieżki combined ──

describe('classifyFile — CSV innych brokerów nie trafia do ścieżki combined', () => {
  const file = (name: string, content: string) => ({
    buffer: Buffer.from(content, 'utf8'),
    originalname: name,
  });

  it('plik transakcji mBanku dalej idzie ścieżką tekstową', async () => {
    const c = await classifyFile(
      file(
        'mbank.csv',
        'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta\n01.01.2026 10:00:00;KGHM;WWA-GPW;K;10;150;PLN;5;PLN;1500;PLN',
      ),
    );
    expect(c.broker).toBe('mbank');
    expect(c.role).toBe('transactions');
    expect(c.isBinary).toBe(false);
  });

  it('plik operacji mBanku dalej rozpoznawany jako operacje', async () => {
    const c = await classifyFile(
      file('fin.csv', 'Data;Opis;Kwota\n01.01.2026 10:00:00;Wpłata;100'),
    );
    expect(c.broker).toBe('mbank');
    expect(c.role).toBe('operations');
  });

  it('plik DEGIRO dalej idzie ścieżką tekstową', async () => {
    const c = await classifyFile(
      file(
        'degiro.csv',
        'Data,Czas,Produkt,ISIN,Giełda,Liczba,Kurs,Wartość lokalna,Wartość,Kurs wymiany,Koszty transakcyjne\n',
      ),
    );
    expect(c.broker).toBe('degiro');
    expect(c.isBinary).toBe(false);
  });

  it('CSV Trading 212 wchodzi w ścieżkę combined', async () => {
    const c = await classifyFile(file('t212.csv', HEADER + '\n'));
    expect(c.broker).toBe('trading212');
    expect(c.role).toBe('transactions');
    expect(c.isBinary).toBe(true);
  });

  it('nierozpoznany CSV zostaje nieznany (a nie „combined")', async () => {
    const c = await classifyFile(file('cokolwiek.csv', 'a,b,c\n1,2,3'));
    expect(c.role).toBe('unknown');
    expect(c.isBinary).toBe(false);
  });
});

// ── Golden: realne próbki ───────────────────────────────────────────────────

describe.skipIf(!hasSamples)('Trading 212 — golden na realnych próbkach', () => {
  it('wykrywa WSZYSTKIE warianty nagłówka jako T212', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d)) {
        const p = path.join(d, e);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.csv')) files.push(p);
      }
    };
    walk(SAMPLES);
    expect(files.length).toBeGreaterThanOrEqual(27);
    const missed = files.filter((f) => !isT212Format(fs.readFileSync(f)));
    expect(missed).toEqual([]);
  });

  it('kupno w USD: kurs, prowizja i wartość w walucie notowania', async () => {
    const r = await parseT212File(sample('sidekick/BuyOrders/single_buy_usd.csv'), 'b');
    const tx = r.transactions.data[0];
    expect(tx.isin).toBe('US67066G1040');
    expect(tx.currency).toBe('USD');
    expect(tx.paymentCurrency).toBe('EUR');
    expect(tx.fxRate).toBeCloseTo(0.9087, 4);
    expect(tx.commission).toBeCloseTo(0.02, 2); // 0,02 EUR × kurs
  });

  it('opłata w TRZECIEJ walucie (GBP przy notowaniu GBX) idzie przez przelicznik funt/pens', async () => {
    // 0,05 GBP = 5,00 GBX. Użycie kursu EUR→GBX dałoby 4,32 — zaniżenie ~17×.
    const r = await parseT212File(sample('sidekick/BuyOrders/single_buy_gbp.csv'), 'b');
    expect(r.transactions.data[0].currency).toBe('GBX');
    expect(r.transactions.data[0].commission).toBeCloseTo(5.0, 2);
  });

  it('dywidenda w akcjach i dystrybucja: zakup po cenie 0, nie dywidenda gotówkowa', async () => {
    for (const f of ['single_scrip_stock_dividend.csv', 'single_stock_dividend.csv']) {
      const r = await parseT212File(sample(`sidekick/Specials/${f}`), 'b');
      expect(r.transactions.data).toHaveLength(1);
      expect(r.transactions.data[0].price).toBe(0);
      expect(r.transactions.data[0].side).toBe('K');
      expect(r.operations.data).toHaveLength(0);
    }
  });

  it('odsetki od gotówki i z pożyczania akcji: other + subkind interest', async () => {
    for (const f of ['single_interest.csv', 'single_lending_shares.csv']) {
      const r = await parseT212File(sample(`sidekick/CashTransactions/${f}`), 'b');
      expect(r.operations.data[0].operationType).toBe('other');
      expect(r.operations.data[0].subkind).toBe('interest');
    }
  });

  it('wariant z "Time (UTC)" parsuje się tak samo jak z "Time"', async () => {
    const utc = await parseT212File(sample('sidekick/BuyOrders/single_buy_usd_time_utc.csv'), 'b');
    const plain = await parseT212File(sample('sidekick/BuyOrders/single_buy_usd.csv'), 'b');
    expect(utc.transactions.data[0].date).toBe(plain.transactions.data[0].date);
  });

  it('plik ze sklejonymi wariantami: wiersze z przesuniętymi kolumnami do kwarantanny', async () => {
    // e2g__trading212-export.csv pochodzi z publicznego repozytorium i zawiera
    // wiersze z INNEGO wariantu nagłówka pod wspólnym nagłówkiem: w kolumnie ceny
    // siedzi identyfikator zlecenia ("EOF27002856700"), a liczba pól się zgadza
    // (19/19), więc żaden strażnik liczący kolumny tego nie wykryje.
    const r = await parseT212File(sample('e2g__trading212-export.csv'), 'b');
    const shifted = r.transactions.skipped.filter((s) => s.reason === 'column_shift');
    expect(shifted.length).toBeGreaterThanOrEqual(4);
    // Żadna z tych bzdur nie może wejść do portfela.
    for (const tx of r.transactions.data) expect(Number.isFinite(tx.price)).toBe(true);
    expect(r.warnings?.some((w) => w.includes('nie pasują do kolumn'))).toBe(true);
  });
});
