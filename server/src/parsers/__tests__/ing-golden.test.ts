import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { decodeCSVBuffer } from '../encoding.js';
import { detectAllMatches } from '../registry.js';
import { isIngFormat, parseIngTransactions } from '../ing-transactions.js';
import { isIngOperationsFormat, parseIngOperations } from '../ing-operations.js';

/**
 * Golden testy ING na REALNYCH plikach (skip gdy katalogów brak — import/
 * i import/public-samples/ są gitignorowane, testy chodzą lokalnie).
 *
 * Dwa cele:
 * 1. Realne pliki z import/ING/ parsują się w całości (bez column_shift,
 *    z kompletem dywidend/markerów) — asercje domenowe na zmierzonych liczbach.
 * 2. Detektory treściowe ING (pliki bez nagłówka!) nie kłócą się z żadnym
 *    realnym samplem innych brokerów z import/public-samples/ — spacer po
 *    wszystkich CSV z asercją ≤1 brokera per rola.
 */

const IMPORT_DIR = path.resolve(__dirname, '../../../../import');
const ING_DIR = path.join(IMPORT_DIR, 'ING');
const SAMPLES_DIR = path.join(IMPORT_DIR, 'public-samples');

function listCsv(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => path.join(dir, f));
}

/** Plik walutowy historii finansowej — CASE-INSENSITIVE: eksporty użytkowników
 *  nazywają go i „…_GBP_…", i „…_cala_gbp_…". */
const hasGbpName = (f: string) => path.basename(f).toLowerCase().includes('gbp');

/** Saldo z wiersza „Saldo początkowe/końcowe" surowego CSV (kolumna 6). */
function readBalance(csv: string, label: string): number | null {
  for (const line of csv.split('\n')) {
    const cells = line.split(';');
    if (cells[3]?.trim() === label) return parseFloat(cells[5]);
  }
  return null;
}

describe.skipIf(!fs.existsSync(ING_DIR))('golden — realne pliki import/ING', () => {
  it('historiaTransakcji: wykrywa się i parsuje w całości', () => {
    const files = listCsv(ING_DIR).filter((f) => path.basename(f).startsWith('historiaTransakcji'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      expect(isIngFormat(csv), path.basename(file)).toBe(true);
      const result = parseIngTransactions(csv, 'golden');
      expect(result.skipped, path.basename(file)).toHaveLength(0);
      expect(result.data.length).toBeGreaterThan(0);
      // Wszystkie transakcje PLN z orderId; alias ZKA1→ZABKA zastosowany.
      expect(result.data.every((t) => t.currency === 'PLN' && t.orderId)).toBe(true);
      expect(result.data.some((t) => t.paperName === 'ZKA1')).toBe(false);
      // Alias delistingowy: kupno PROVIDENT (2020, GPW) dostaje ISIN wykupu
      // przymusowego z LSE — pozycję domyka syntetyczna S z pliku GBP.
      for (const t of result.data.filter((x) => x.paperName === 'PROVIDENT')) {
        expect(t.isin, `${path.basename(file)}: PROVIDENT`).toBe('GB00B1YKG049');
      }
    }
  });

  it('historiaFinansowa: klasyfikacja bez wierszy w kwarantannie, dywidendy netto', () => {
    const files = listCsv(ING_DIR).filter((f) => path.basename(f).startsWith('historiaFinansowa'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      expect(isIngOperationsFormat(csv), path.basename(file)).toBe(true);
      const result = parseIngOperations(csv, 'golden');
      // Zdrowy realny plik: zero column_shift i zero ticketów kwarantanny.
      expect(
        result.skipped.filter((s) => s.reason === 'column_shift'),
        path.basename(file),
      ).toHaveLength(0);
      expect(
        result.skipped.filter((s) => s.reason === 'unknown_operation_type' && s.raw),
        path.basename(file),
      ).toHaveLength(0);
    }
  });

  it('pliki walutowe: operacje + wykupy uzgadniają salda z wierszy Saldo', () => {
    // CASE-INSENSITIVE: „…_GBP_…" (v1) i „…_cala_gbp_…" (v2) to ta sama waluta.
    const gbpFiles = listCsv(ING_DIR).filter(
      (f) => path.basename(f).startsWith('historiaFinansowa') && hasGbpName(f),
    );
    if (gbpFiles.length === 0) return; // zestaw bez plików walutowych
    for (const file of gbpFiles) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      const result = parseIngOperations(csv, 'golden');
      const opsSum = result.data.reduce((s, o) => s + o.amount, 0);
      const redemptionSum = result.redemptions.reduce((s, r) => s + r.amount, 0);
      // Uzgodnienie z SALDAMI TEGO pliku (nie z hardkodem — generacje eksportów
      // mogą mieć różne zakresy): suma operacji + wykupy = końcowe − początkowe.
      const opening = readBalance(csv, 'Saldo początkowe');
      const closing = readBalance(csv, 'Saldo końcowe');
      expect(opening, path.basename(file)).not.toBeNull();
      expect(closing, path.basename(file)).not.toBeNull();
      expect(opsSum + redemptionSum, path.basename(file)).toBeCloseTo(closing! - opening!, 2);
      for (const red of result.redemptions) {
        expect(red, path.basename(file)).toMatchObject({
          isin: 'GB00B1YKG049',
          quantity: 360,
          tenderPrice: 2.35,
          source: 'ing',
        });
      }
    }
  });

  it('join orderId→ISIN: każdy ticker dostaje dokładnie jeden ISIN (pary per katalog)', () => {
    // Parujemy transakcje z historią finansową z TEGO SAMEGO katalogu — v2 ma
    // szerszy zakres dat niż v1 i krzyżowe pary dawałyby fałszywe rozjazdy.
    const byDir = new Map<string, { tx?: string; plnOps?: string }>();
    for (const f of listCsv(ING_DIR)) {
      const base = path.basename(f);
      const e = byDir.get(path.dirname(f)) ?? {};
      if (base.startsWith('historiaTransakcji')) e.tx = f;
      if (base.startsWith('historiaFinansowa') && !hasGbpName(f)) e.plnOps = f;
      byDir.set(path.dirname(f), e);
    }
    const pairs = [...byDir.values()].filter((e) => e.tx && e.plnOps);
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      const tx = parseIngTransactions(decodeCSVBuffer(fs.readFileSync(pair.tx!)), 'golden');
      const ops = parseIngOperations(decodeCSVBuffer(fs.readFileSync(pair.plnOps!)), 'golden');
      const isinsByTicker = new Map<string, Set<string>>();
      for (const t of tx.data) {
        const isin = t.orderId ? ops.orderIsinMap.get(t.orderId) : undefined;
        if (!isin) continue;
        if (!isinsByTicker.has(t.paperName)) isinsByTicker.set(t.paperName, new Set());
        isinsByTicker.get(t.paperName)!.add(isin);
      }
      expect(isinsByTicker.size).toBeGreaterThan(0);
      for (const [ticker, isins] of isinsByTicker) {
        expect(isins.size, `${ticker}: ${[...isins].join(', ')}`).toBe(1);
      }
      // Przydział IPO Żabki: ZKA1 (po aliasie ZABKA) joinuje do realnego ISIN-u —
      // tylko gdy ta generacja eksportu w ogóle zawiera ZABKĘ.
      if (tx.data.some((t) => t.paperName === 'ZABKA')) {
        expect(isinsByTicker.get('ZABKA')?.has('LU2910446546')).toBe(true);
      }
    }
  });
});

describe.skipIf(!fs.existsSync(SAMPLES_DIR))(
  'guard niejednoznaczności — realne sample wszystkich brokerów',
  () => {
    it('żaden CSV z public-samples nie trafia w więcej niż jednego brokera per rola', () => {
      const files = listCsv(SAMPLES_DIR);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = decodeCSVBuffer(fs.readFileSync(file));
        const matches = detectAllMatches(content);
        const rel = path.relative(SAMPLES_DIR, file);
        expect(
          matches.transactions.length,
          `${rel}: tx=${matches.transactions}`,
        ).toBeLessThanOrEqual(1);
        // Jedyna znana koincydencja ról operacji to degiro+mbank (luźny detektor
        // mBanka; kolejność rejestru rozstrzyga) — ING nie może wchodzić w cudze pliki.
        if (matches.operations.length > 1) {
          expect(matches.operations, `${rel}: ops=${matches.operations}`).toEqual([
            'degiro',
            'mbank',
          ]);
        }
      }
    });

    it('archiwalny sampel myfund__ING.csv klasyfikuje się jako transakcje ING', () => {
      const archive = path.join(SAMPLES_DIR, 'pl-archiwum-2021', 'myfund__ING.csv');
      if (!fs.existsSync(archive)) return;
      const content = decodeCSVBuffer(fs.readFileSync(archive));
      expect(detectAllMatches(content).transactions).toEqual(['ing']);
      const result = parseIngTransactions(content, 'golden');
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.skipped.filter((s) => s.reason === 'column_shift')).toHaveLength(0);
    });
  },
);
