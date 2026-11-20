import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { decodeCSVBuffer } from '../encoding.js';
import { detectAllMatches } from '../registry.js';
import { isPkoFormat, parsePkoTransactions } from '../pko-transactions.js';
import { parseNumber } from '../utils.js';

/**
 * Golden test PKO na REALNYCH plikach (skip gdy katalogu brak — `import/` jest
 * gitignorowany, test chodzi lokalnie).
 *
 * Sedno: uzgodnienie z WIERSZEM PODSUMOWANIA raportu. To jedyna suma kontrolna,
 * jaką PKO daje — z haczykiem, że obejmuje także wiersze „Unieważnione", więc
 * porównujemy ją z sumą WSZYSTKICH wierszy pliku (import + skipy anulowane),
 * a nie z tym, co wpada do portfela.
 */

const PKO_DIR = path.resolve(__dirname, '../../../../import/pko');
const ARCHIVE_SAMPLE = path.resolve(
  __dirname,
  '../../../../import/public-samples/pl-archiwum-2021/myfund__PKOBP.csv',
);

function listCsv(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => path.join(dir, f));
}

/** Kolumna z wiersza podsumowania (bez daty i waloru) surowego CSV. */
function summaryRow(csv: string): string[] | null {
  const lines = csv.split('\n').filter((l) => l.trim() !== '');
  const last = lines[lines.length - 1].split(';');
  return last[0].trim() === '' && last.some((c) => c.trim() !== '') ? last : null;
}

describe.skipIf(!fs.existsSync(PKO_DIR))('golden — realne pliki import/pko', () => {
  const files = listCsv(PKO_DIR);

  it('wykrywają się jako PKO i tylko jako PKO', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      expect(isPkoFormat(csv), path.basename(file)).toBe(true);
      expect(detectAllMatches(csv).transactions, path.basename(file)).toEqual(['pko']);
    }
  });

  it('parsują się bez column_shift, a każdy wiersz ma rozstrzygnięcie', () => {
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      const dataRows = csv.split('\n').filter((l) => l.trim() !== '').length - 1; // bez nagłówka
      const result = parsePkoTransactions(csv, 'golden');
      expect(
        result.skipped.filter((s) => s.reason === 'column_shift'),
        path.basename(file),
      ).toHaveLength(0);
      // Żaden wiersz nie ginie po drodze: transakcja albo świadomy skip.
      expect(result.data.length + result.skipped.length, path.basename(file)).toBe(dataRows);
      // Realny rachunek złotowy — bez kursów i bez pseudo-fx.
      expect(result.data.every((t) => t.currency === 'PLN' && t.paymentCurrency === 'PLN')).toBe(
        true,
      );
      // Pseudo-ISIN = skrót GPW (bez ISIN-ów w pliku), pozycja resolvowana po nazwie.
      expect(result.data.every((t) => t.isin === t.paperName)).toBe(true);
    }
  });

  it('sumy pliku uzgadniają się z wierszem podsumowania (razem z anulowanymi)', () => {
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      const summary = summaryRow(csv);
      if (!summary) continue; // raport bez stopki
      const result = parsePkoTransactions(csv, 'golden');

      // Stopka liczy WSZYSTKIE wiersze raportu, także „Unieważnione", których nie
      // importujemy — dlatego dokładamy ich kwoty z surowego pliku.
      const cancelledRows = csv
        .split('\n')
        .filter((l) => l.includes(';Unieważnione;'))
        .map((l) => l.split(';'));
      const header = csv
        .split('\n')[0]
        .split(';')
        .map((h) => h.trim().toLowerCase());
      const idx = (name: string) => header.findIndex((h) => h.replace(/^﻿/, '') === name);
      const qtyIdx = idx('ilość');
      const valIdx = idx('wartość');
      const comIdx = idx('prowizja');

      const qty =
        result.data.reduce((s, t) => s + t.quantity, 0) +
        cancelledRows.reduce((s, r) => s + parseNumber(r[qtyIdx]), 0);
      const value =
        result.data.reduce((s, t) => s + t.value, 0) +
        cancelledRows.reduce((s, r) => s + parseNumber(r[valIdx]), 0);
      const commission =
        result.data.reduce((s, t) => s + t.commission, 0) +
        cancelledRows.reduce((s, r) => s + parseNumber(r[comIdx]), 0);

      expect(qty, `${path.basename(file)}: ilość`).toBe(parseNumber(summary[qtyIdx]));
      expect(value, `${path.basename(file)}: wartość`).toBeCloseTo(parseNumber(summary[valIdx]), 2);
      expect(commission, `${path.basename(file)}: prowizja`).toBeCloseTo(
        parseNumber(summary[comIdx]),
        2,
      );
    }
  });

  it('prowizja per zlecenie trzyma jedną stawkę (fills rozdzielają ją byle jak)', () => {
    for (const file of files) {
      const csv = decodeCSVBuffer(fs.readFileSync(file));
      const header = csv
        .split('\n')[0]
        .split(';')
        .map((h) => h.trim().toLowerCase());
      const orderIdx = header.findIndex((h) => h === 'id zlecenia');
      if (orderIdx < 0) continue;
      const perOrder = new Map<string, { value: number; commission: number }>();
      for (const line of csv.split('\n').slice(1)) {
        const cells = line.split(';');
        if (cells.length <= orderIdx || !cells[orderIdx]?.trim()) continue;
        if (!line.includes(';Zrealizowane;')) continue;
        const key = cells[orderIdx].trim();
        const acc = perOrder.get(key) ?? { value: 0, commission: 0 };
        acc.value += parseNumber(cells[header.indexOf('wartość')]);
        acc.commission += parseNumber(cells[header.indexOf('prowizja')]);
        perOrder.set(key, acc);
      }
      expect(perOrder.size).toBeGreaterThan(0);
      const rates = [...perOrder.values()].map((o) => o.commission / o.value);
      const min = Math.min(...rates);
      const max = Math.max(...rates);
      // Jedna stawka na całym rachunku — rozrzut poniżej 0,01 pkt proc. Gdyby
      // parser gubił prowizję z części fills, ta asercja pęka pierwsza.
      expect(max - min, `${path.basename(file)}: rozrzut stawki`).toBeLessThan(0.0001);
    }
  });
});

describe.skipIf(!fs.existsSync(ARCHIVE_SAMPLE))('golden — archiwalny sampel PKO z 2021', () => {
  it('pokolenie 2021 klasyfikuje się jako PKO i parsuje w całości', () => {
    const csv = decodeCSVBuffer(fs.readFileSync(ARCHIVE_SAMPLE));
    expect(detectAllMatches(csv).transactions).toEqual(['pko']);
    const result = parsePkoTransactions(csv, 'golden');
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0);
    // Sufiks rynku zachowany — resolver używa go do rozpoznania NewConnectu.
    expect(result.data.some((t) => t.paperName.endsWith('-NC'))).toBe(true);
  });
});
