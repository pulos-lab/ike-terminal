import { describe, it, expect } from 'vitest';
import type { CashOperation, Transaction } from 'shared';
import { parseBossaTransactions } from '../../bossa-transactions.js';
import { parseBossaOperations } from '../../bossa-operations.js';
import { parseDegiroTransactions } from '../../degiro-transactions.js';
import { parseDegiroOperations } from '../../degiro-operations.js';
import { parseMbankTransactions } from '../../mbank-transactions.js';
import { parseWithProfile } from '../engine.js';
import { BOSSA_TRANSACTIONS_PROFILE } from '../profiles/bossa-transactions.profile.js';
import { BOSSA_OPERATIONS_PROFILE } from '../profiles/bossa-operations.profile.js';
import { DEGIRO_TRANSACTIONS_PROFILE } from '../profiles/degiro-transactions.profile.js';
import { DEGIRO_ACCOUNT_PROFILE } from '../profiles/degiro-account.profile.js';
import { MBANK_TRANSACTIONS_PROFILE } from '../profiles/mbank-transactions.profile.js';

/**
 * Golden testy parytetu: te same CSV parsowane przez parser WBUDOWANY oraz
 * silnik generyczny z golden profilem → identyczny wynik modulo pole `source`.
 * To jest dowód, że spec ImportProfile jest dość ekspresyjny dla realnych
 * formatów — istniejące parsery pozostają nietknięte.
 */

const BATCH = 'batch-golden';

/** Normalizacja do porównania: source ujednolicone, undefined-y usunięte. */
function normTx(tx: Transaction): Record<string, unknown> {
  const { source: _source, ...rest } = tx;
  return JSON.parse(JSON.stringify(rest));
}

function normOp(op: CashOperation): Record<string, unknown> {
  const { source: _source, ...rest } = op;
  return JSON.parse(JSON.stringify(rest));
}

const opSortKey = (op: Record<string, unknown>) =>
  `${op.date}|${op.operationType}|${op.amount}|${op.currency}|${op.ticker ?? ''}`;

describe('golden parity — Bossa transakcje (hisPW)', () => {
  // Realny układ kolumn: data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta
  const csv = [
    'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta',
    '25.02.2026 09:47:27;MINERAL-NC;PLMNRLM00010;868;S;0,88;763,84;0,00;763,84;PLN',
    '10.01.2025 10:00:00;KGHM;PLKGHM000017;10;K;150,50;1505,00;5,85;1510,85;PLN',
    '03.03.2025 11:30:00;CDR;PLOPTTC00011;5;K;300,00;1500,00;5,00;1505,00;',
    '07.07.2025 12:00:00;AAPL;US0378331005;3;K;200,00;600,00;2,00;602,00;USD',
  ].join('\n');

  it('wynik identyczny z parseBossaTransactions (modulo source)', () => {
    const builtin = parseBossaTransactions(csv, BATCH);
    const generic = parseWithProfile(csv, BOSSA_TRANSACTIONS_PROFILE, BATCH);

    expect(generic.transactions.data.map(normTx)).toEqual(builtin.data.map(normTx));
    expect(generic.transactions.skipped).toEqual(builtin.skipped);
  });

  it('obligacja Catalyst: kategoria bond + wartość bez cross-checku', () => {
    const bondCsv = [
      'data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta',
      '12.05.2025 09:00:00;DS1030;PL0000111456;23;K;101,78;23909,40;0,00;23909,40;PLN',
    ].join('\n');
    const builtin = parseBossaTransactions(bondCsv, BATCH);
    const generic = parseWithProfile(bondCsv, BOSSA_TRANSACTIONS_PROFILE, BATCH);

    expect(generic.transactions.data.map(normTx)).toEqual(builtin.data.map(normTx));
    expect(generic.transactions.data[0].category).toBe('bond');
  });
});

describe('golden parity — Bossa operacje (zakres wspólny)', () => {
  // Wiersze obsługiwane deklaratywnie (bez markerów rekoncyliacji).
  const csv = [
    'data;tytuł operacji;szczegóły;kwota;waluta',
    '2026-02-17;Wymiana waluty PLN/USD 3.5713;;-5871,00;PLN',
    '2026-02-17;Wymiana waluty PLN/USD 3.5713;;1644,11;USD',
    '2025-06-10;Wypłata dywidendy netto NVO 73% PLN;;73,00;PLN',
    '2025-01-05;Przelew do DM BO 123;;1000,00;PLN',
    '2025-03-01;Opłata za prowadzenie rachunku;;-12,00;PLN',
    '2025-04-01;Zwrot prowizji;;5,00;PLN',
    '2025-05-01;Rozliczenie transakcji 555;;-100,00;PLN',
  ].join('\n');

  it('typy/kwoty/waluty/fx identyczne z parseBossaOperations', () => {
    const builtin = parseBossaOperations(csv, BATCH);
    const generic = parseWithProfile(csv, BOSSA_OPERATIONS_PROFILE, BATCH);

    // Opisy mogą się różnić (parser wbudowany humanizuje tytuły) — porównujemy
    // pola wchodzące do klucza dedup + fxRate/fxPair/subkind.
    const strip = (op: CashOperation) => ({
      date: op.date,
      operationType: op.operationType,
      amount: op.amount,
      currency: op.currency,
      ticker: op.ticker,
      fxRate: op.fxRate,
      fxPair: op.fxPair,
      subkind: op.subkind,
    });
    const sortKey = (o: ReturnType<typeof strip>) =>
      `${o.date}|${o.operationType}|${o.amount}|${o.currency}`;

    const a = builtin.data.map(strip).sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
    const b = generic.operations.data
      .map(strip)
      .sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
  });
});

describe('golden parity — DEGIRO transakcje (format NOWY)', () => {
  const header =
    'Data,Czas,Produkt,ISIN,Giełda referencyjna,Miejsce wykonania,Liczba,Kurs,,Wartość lokalna,,Wartość EUR,Kurs wymiany,Opłaty AutoFX,Opłata transakcyjna DEGIRO i/lub opłata stron,Razem EUR,Identyfikator zlecenia,';
  const csv = [
    header,
    '27-03-2024,11:41,ML SYSTEM SA,PLMLSTM00015,WSE,XWAR,-70,"43,7000",PLN,"3059,00",PLN,"709,30","4,3127","0,00",,"709,30",,94fb340e',
    '15-05-2024,14:02,APPLE INC,US0378331005,NSY,XNAS,"0,5","180,00",USD,"90,00",USD,"83,00","1,0843","0,10",,"83,10",,11aa22bb',
    '01-02-2024,09:30,RIO TINTO,GB0007188757,LSE,XLON,10,"5512,00",GBX,"55120,00",GBX,"645,00","85,45","0,00",,"645,00",,33cc44dd',
    '10-06-2024,10:00,SPAC CORP,US1111111111,NSY,XNAS,5,"0,00",USD,"50,00",USD,"46,00","1,08","0,00",,"46,00",,55ee66ff',
  ].join('\n');

  it('wynik identyczny z parseDegiroTransactions (modulo source)', () => {
    const builtin = parseDegiroTransactions(csv, BATCH);
    const generic = parseWithProfile(csv, DEGIRO_TRANSACTIONS_PROFILE, BATCH);

    expect(generic.transactions.data.map(normTx)).toEqual(builtin.data.map(normTx));
    // Corporate action (kurs 0, wartość ≠ 0) pominięta przez obu z tym samym powodem.
    expect(builtin.skipped.map((s) => s.reason)).toContain('corporate_action');
    expect(generic.operations.skipped.map((s) => s.reason)).toContain('corporate_action');
  });
});

describe('golden parity — DEGIRO operacje (Account)', () => {
  const header = 'Data,Czas,Data,Produkt,ISIN,Opis,Kurs,Zmiana,,Saldo,,Identyfikator zlecenia';
  const csv = [
    header,
    '03-04-2024,09:00,03-04-2024,APPLE INC,US0378331005,Dywidenda,,USD,"10,00",USD,"110,00",',
    '03-04-2024,09:00,03-04-2024,APPLE INC,US0378331005,Podatek Dywidendowy,,USD,"-1,50",USD,"100,00",',
    '05-04-2024,12:00,05-04-2024,,,Depozyt,,PLN,"1000,00",PLN,"1000,00",',
    '06-04-2024,12:00,06-04-2024,,,Wypłata,,PLN,"-500,00",PLN,"500,00",',
    '07-04-2024,10:00,07-04-2024,EUR/PLN,,FX Withdrawal,"4,3127",PLN,"-431,27",PLN,"68,73",ord-1',
    '07-04-2024,10:00,07-04-2024,EUR/PLN,,FX Credit,"4,3127",EUR,"100,00",EUR,"100,00",ord-1',
    '09-04-2024,15:00,09-04-2024,USD/PLN,,FX Credit,"3,9000",USD,"355,00",USD,"355,00",',
    '08-04-2024,11:00,08-04-2024,,,Odsetki,,EUR,"-2,00",EUR,"98,00",',
  ].join('\n');

  it('operacje identyczne z parseDegiroOperations (z opisami, modulo source)', () => {
    const builtin = parseDegiroOperations(csv, BATCH);
    const generic = parseWithProfile(csv, DEGIRO_ACCOUNT_PROFILE, BATCH);

    const a = builtin.data.map(normOp).sort((x, y) => opSortKey(x).localeCompare(opSortKey(y)));
    const b = generic.operations.data
      .map(normOp)
      .sort((x, y) => opSortKey(x).localeCompare(opSortKey(y)));
    expect(b).toEqual(a);
  });
});

describe('golden parity — mBank transakcje', () => {
  const csv = [
    'mBank eMakler — eksport',
    'Rachunek: 00 1111 2222 3333',
    '',
    'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta',
    '02.01.2025 10:30:00;KGHM;WWA-GPW;K;10;150,50;PLN;5,85;PLN;1505,00;PLN',
    '05.02.2025 11:00:00;PKNORLEN;WWA-GPW;S;20;65,00;PLN;5,00;PLN;1300,00;PLN',
    '07.03.2025 16:00:00;AAPL;USA-NASDAQ;K;2;180,00;USD;1,00;USD;360,00;USD',
  ].join('\n');

  it('wynik identyczny z parseMbankTransactions (modulo source)', () => {
    const builtin = parseMbankTransactions(csv, BATCH);
    const generic = parseWithProfile(csv, MBANK_TRANSACTIONS_PROFILE, BATCH);

    expect(generic.transactions.data.map(normTx)).toEqual(builtin.data.map(normTx));
    expect(builtin.data[0].isin).toBe('KGHM'); // pseudo-ISIN = nazwa papieru
    expect(generic.transactions.data[0].isin).toBe('KGHM');
  });
});
