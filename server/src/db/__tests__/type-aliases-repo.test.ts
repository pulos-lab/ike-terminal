import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR musi być ustawiony PRZED importem config/imports-db (czytane przy load)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-type-aliases-'));
process.env.DATA_DIR = tmpDir;

describe('type-aliases-repo — unknown_type_reports', () => {
  let repo: typeof import('../type-aliases-repo.js');
  let importsDb: typeof import('../imports-db.js');

  beforeAll(async () => {
    repo = await import('../type-aliases-repo.js');
    importsDb = await import('../imports-db.js');
  });

  afterAll(() => {
    importsDb.closeImportsDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pierwsze zgłoszenie tworzy agregat (isNew=true), próbka i sugestia zapisane', () => {
    const r = repo.upsertUnknownTypeReport({
      broker: 'XTB',
      rawType: 'Dividend Equivalent',
      kind: 'classified',
      headers: ['Type', 'Amount'],
      sampleCells: ['Dividend Equivalent', '***'],
      suggestion: { classifiedAs: 'dividend', note: 'to dywidenda syntetyczna' },
      reporterId: 'user-1',
    });
    expect(r.isNew).toBe(true);
    // normalizacja klucza: lower(trim)
    expect(r.report).toMatchObject({
      broker: 'xtb',
      rawType: 'dividend equivalent',
      kind: 'classified',
      occurrenceCount: 1,
      reporterCount: 1,
      status: 'open',
    });
    expect(r.report.suggestions[0]).toMatchObject({ classifiedAs: 'dividend' });
    expect(r.report.sampleCells).toEqual(['Dividend Equivalent', '***']);
  });

  it('kolejne zgłoszenia agregują: licznik rośnie, reporter dedup, bez maila (isNew=false)', () => {
    const again = repo.upsertUnknownTypeReport({
      broker: 'xtb',
      rawType: '  DIVIDEND EQUIVALENT ',
      kind: 'classified',
      suggestion: { classifiedAs: 'dividend' },
      reporterId: 'user-2',
    });
    expect(again.isNew).toBe(false);
    expect(again.report.occurrenceCount).toBe(2);
    expect(again.report.reporterCount).toBe(2);

    // ten sam user ponownie — licznik wystąpień rośnie, reporterów nie
    const same = repo.upsertUnknownTypeReport({
      broker: 'xtb',
      rawType: 'dividend equivalent',
      kind: 'classified',
      reporterId: 'user-2',
    });
    expect(same.report.occurrenceCount).toBe(3);
    expect(same.report.reporterCount).toBe(2);
  });

  it('inny kind tego samego typu = osobny agregat (feature-gap ≠ luka parsera)', () => {
    const gap = repo.upsertUnknownTypeReport({
      broker: 'xtb',
      rawType: 'dividend equivalent',
      kind: 'unsupported',
      reporterId: 'user-1',
    });
    expect(gap.isNew).toBe(true);
    expect(repo.listUnknownTypeReports({ kind: 'unsupported' })).toHaveLength(1);
    expect(repo.listUnknownTypeReports({ kind: 'classified' })).toHaveLength(1);
  });

  it('cap sugestii — powyżej 20 nie dopisujemy', () => {
    for (let i = 0; i < 25; i++) {
      repo.upsertUnknownTypeReport({
        broker: 'ibkr',
        rawType: 'warrants',
        kind: 'classified',
        suggestion: { note: `sugestia ${i}` },
        reporterId: `u${i}`,
      });
    }
    const report = repo
      .listUnknownTypeReports({ kind: 'classified' })
      .find((r) => r.broker === 'ibkr')!;
    expect(report.suggestions).toHaveLength(20);
    expect(report.occurrenceCount).toBe(25);
  });

  it('setUnknownTypeReportStatus — review z notą', () => {
    const report = repo.listUnknownTypeReports({ kind: 'unsupported' })[0];
    expect(repo.setUnknownTypeReportStatus(report.id, 'wont_fix', 'admin-1', 'poza zakresem')).toBe(
      true,
    );
    const after = repo.getUnknownTypeReport(report.id);
    expect(after).toMatchObject({ status: 'wont_fix', reviewNote: 'poza zakresem' });
    expect(repo.listUnknownTypeReports({ status: 'open', kind: 'unsupported' })).toHaveLength(0);
  });
});

describe('type-aliases-repo — operation_type_aliases', () => {
  let repo: typeof import('../type-aliases-repo.js');

  beforeAll(async () => {
    repo = await import('../type-aliases-repo.js');
  });

  it('upsert tworzy alias approved; getApprovedAliasesForBroker zwraca mapę', () => {
    const alias = repo.upsertOperationTypeAlias({
      broker: 'XTB',
      rawType: ' Dividend Equivalent ',
      target: { kind: 'parser_type', value: 'dividend' },
      status: 'approved',
      actorUserId: 'admin-1',
      reportId: 1,
    });
    expect(alias).toMatchObject({
      broker: 'xtb',
      rawType: 'dividend equivalent',
      targetKind: 'parser_type',
      targetValue: 'dividend',
      status: 'approved',
    });

    const map = repo.getApprovedAliasesForBroker('xtb');
    expect(map.get('dividend equivalent')).toEqual({ kind: 'parser_type', value: 'dividend' });
    // inny broker — pusta mapa
    expect(repo.getApprovedAliasesForBroker('ibkr').size).toBe(0);
  });

  it('drugi upsert tego samego (broker, typ) to UPDATE (UNIQUE), nie duplikat', () => {
    repo.upsertOperationTypeAlias({
      broker: 'xtb',
      rawType: 'dividend equivalent',
      target: { kind: 'ignore' },
      status: 'approved',
      actorUserId: 'admin-1',
    });
    const aliases = repo.listOperationTypeAliases('xtb');
    expect(aliases.filter((a) => a.rawType === 'dividend equivalent')).toHaveLength(1);
    expect(repo.getApprovedAliasesForBroker('xtb').get('dividend equivalent')).toEqual({
      kind: 'ignore',
      value: undefined,
    });
  });

  it('revoke wyłącza alias — znika z mapy approved, wiersz zostaje w liście', () => {
    const alias = repo.listOperationTypeAliases('xtb')[0];
    expect(repo.revokeOperationTypeAlias(alias.id, 'admin-1', 'pomyłka')).toBe(true);
    expect(repo.getApprovedAliasesForBroker('xtb').size).toBe(0);
    expect(repo.listOperationTypeAliases('xtb')[0]?.status).toBe('revoked');
    // revoke nie-approved → false
    expect(repo.revokeOperationTypeAlias(alias.id, 'admin-1')).toBe(false);
  });
});
