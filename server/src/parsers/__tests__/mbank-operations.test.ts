import { describe, it, expect } from 'vitest';
import { parseMbankOperations, isMbankOperationsFormat } from '../mbank-operations.js';

const HEADER = 'Data,Opis,Kwota';

function buildCsv(lines: string[]): string {
  return [HEADER, ...lines].join('\n');
}

describe('isMbankOperationsFormat', () => {
  it('detects comma-delimited operations header', () => {
    expect(isMbankOperationsFormat('Data,Opis,Kwota\n')).toBe(true);
  });

  it('detects semicolon-delimited operations header', () => {
    expect(isMbankOperationsFormat('Data;Opis;Kwota\n')).toBe(true);
  });

  it('rejects transaction file (has Papier column)', () => {
    expect(
      isMbankOperationsFormat(
        'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Data\n',
      ),
    ).toBe(false);
  });

  it('rejects empty content', () => {
    expect(isMbankOperationsFormat('')).toBe(false);
  });

  it('detects header preceded by bank metadata lines (real export ~34 lines)', () => {
    const csv = ['mBank S.A.', 'eMakler', '', 'Historia finansowa', '', 'Data;Opis;Kwota'].join(
      '\n',
    );
    expect(isMbankOperationsFormat(csv)).toBe(true);
  });

  it('NIE klasyfikuje CSV, w którym data/opis/kwota występują tylko w wierszu danych', () => {
    // Słowa "data", "opis", "kwota" pojawiają się w treści wiersza, ale NIE są
    // nazwami kolumn — luźny substring-matching dawał tu false-positive.
    const csv =
      'kolumna1;kolumna2;kolumna3\n' + '2024-01-02;przelew z opisem: kwota za data koncertu;100\n';
    expect(isMbankOperationsFormat(csv)).toBe(false);
  });

  it('NIE klasyfikuje nagłówka operacji Bossa (data;tytuł operacji;szczegóły;kwota;waluta)', () => {
    expect(isMbankOperationsFormat('data;tytuł operacji;szczegóły;kwota;waluta\n')).toBe(false);
  });
});

describe('parseMbankOperations', () => {
  it('parses dividend with ISIN, tax rate, and FX rate', () => {
    const csv = buildCsv([
      '16.04.2026 11:24:34,Dywidenda z 4 PW: US5951121038 DP: 2026-03-30 stawka brutto w wal.: 0.15 stawka pod.: 15% kurs przewalutowania: 3.590368 |DVCA10480,1',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('dividend');
    expect(result.data[0].ticker).toBe('US5951121038');
    expect(result.data[0].amount).toBe(1);
    expect(result.data[0].currency).toBe('PLN');
    expect(result.data[0].fxRate).toBeCloseTo(3.590368);
    expect(result.data[0].description).toContain('US5951121038');
    expect(result.data[0].description).toContain('4 szt');
  });

  it('parses bank deposit (WYC.BK)', () => {
    const csv = buildCsv(['03.03.2026 14:08:00,WYC.BK: 600622 POZ: 1788464 ikze,6 000']);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('deposit');
    expect(result.data[0].amount).toBe(6000);
    expect(result.data[0].currency).toBe('PLN');
  });

  it('skips order blocks (Blokada)', () => {
    const csv = buildCsv([
      '03.03.2026 16:06:34,Blokada \u015brodk\u00f3w pod zlecenie kupna nr 105360056,-5 648',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('settlement_record');
  });

  it('skips order unblocks (Odblokowanie)', () => {
    const csv = buildCsv([
      '23.03.2026 12:31:27,Odblokowanie \u015brodk\u00f3w pod zlecenie nr 105815419,720',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('settlement_record');
  });

  it('skips transaction settlements (WYC with PW)', () => {
    const csv = buildCsv([
      '19.02.2026 12:01:08,WYC: 112082964 NOT: 119127638 ZLC: 105038258 PW: PLKMPTR00012,88',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('settlement_record');
  });

  it('classifies unknown operations as other', () => {
    const csv = buildCsv(['01.01.2026 10:00:00,Jaki\u015b nieznany typ operacji,100']);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('other');
  });

  it('returns empty result for empty CSV', () => {
    const result = parseMbankOperations('', 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('rozpoznaje przelewy spoza prefiksów WYC.BK/WYP.BK (kierunek ze znaku kwoty)', () => {
    // Wzorce z realnych rachunków; numery zmienione. Przed poprawką wszystkie
    // te wiersze lądowały jako 'other' i nie zasilały cash flow.
    const csv = buildCsv([
      '05.01.2025 10:00:00,Uzn. konta podst. środkami z banku. Dysp. nr: 11111111,"5 000,00"',
      '06.01.2025 10:00:00,PL10000001 R:22222222 Przelew z r-ku brokerskiego na bankowy - wolne środki,"-1 200,00"',
      '07.01.2025 10:00:00,Przelew z r-ku R:22222222 w BM - więcej informacji,"-300,00"',
      '08.01.2025 10:00:00,PRZELEW NA IKZE 33333333,"10 000,00"',
      '09.01.2025 10:00:00,33333333 ZASILENIE IKZE,"2 500,00"',
      '10.01.2025 10:00:00,33333333 DOPŁATA DO LIMITU IKZE 2021 OS SAMOZATRUDNIONA,"3 155,40"',
      '11.01.2025 10:00:00,IKZE 2025,"15 611,40"',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(7);
    expect(result.data.map((o) => o.operationType)).toEqual([
      'deposit',
      'withdrawal',
      'withdrawal',
      'deposit',
      'deposit',
      'deposit',
      'deposit',
    ]);
  });

  it('nie bierze za przelew zwrotu z redukcji IPO ani korekty dywidendy', () => {
    const csv = buildCsv([
      '12.01.2025 10:00:00,BRMW3820201130_716 ipo mobruk - redukcja zwrot srodkow,"1 000,00"',
      '13.01.2025 10:00:00,Korekta dywidendy CY1000031710 (ASBIS) z dnia 2022-12-05,"27,10"',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data.map((o) => o.operationType)).toEqual(['other', 'other']);
  });

  it('„IKE/IKZE WYPELNIONY LIMIT" to wiersz informacyjny, nie operacja gotówkowa', () => {
    // Kwota w tym wierszu to ustawowy limit wpłat na dany rok. Księgowany jako
    // operacja dokładał na rachunek kilkadziesiąt tysięcy fantomowych złotych.
    const csv = buildCsv([
      '01.01.2024 13:07:17,IKE WYPELNIONY LIMIT,23 472,00',
      '01.01.2025 13:11:00,IKZE WYPEŁNIONY LIMIT,10 407,60',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.reason)).toEqual(['summary_row', 'summary_row']);
  });
});
