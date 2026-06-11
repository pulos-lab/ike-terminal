import { createHash } from 'node:crypto';
import Papa from 'papaparse';

/**
 * Fingerprint formatu CSV — klucz biblioteki profili importu generycznego.
 *
 * Fingerprint = sha256(znormalizowane nazwy nagłówków, z zachowaniem kolejności,
 * + delimiter). Indeks wiersza nagłówka celowo NIE wchodzi do fingerprinta —
 * eksporty z preludium metadanych (mBank: ~34 linie) mają zmienną długość
 * preludium, a sam układ kolumn pozostaje stały.
 *
 * Dopasowanie jest EXACT-MATCH z założenia: broker, który dodał/zmienił kolumnę,
 * NIE może po cichu dostać profilu ze starymi indeksami. Do podpowiedzi
 * "podobny format" służy jaccardSimilarity (sugestie-szablony w UI/LLM).
 */

const CANDIDATE_DELIMITERS = [';', ',', '\t', '|'] as const;
const MAX_SCAN_ROWS = 60;

export interface HeaderCandidate {
  /** Surowe nazwy nagłówków (oryginalna pisownia — do UI i profilu). */
  headers: string[];
  delimiter: (typeof CANDIDATE_DELIMITERS)[number];
  /** 0-based indeks wiersza nagłówka w sparsowanym pliku. */
  headerRowIndex: number;
  /** Wiersze danych następujące po nagłówku (do próbki/digestów). */
  sampleRows: string[][];
}

/** Normalizacja nazwy nagłówka: BOM, trim, lowercase, pojedyncze spacje, bez diakrytyków. */
export function normalizeHeaderForFingerprint(name: string): string {
  return (
    name
      .replace(/^﻿/, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      // NFKD nie rozkłada ł/Ł — ręcznie, żeby "papier wartościowy" == "papier wartosciowy"
      .replace(/ł/g, 'l')
  );
}

export function computeFingerprint(headers: string[], delimiter: string): string {
  const normalized = headers.map(normalizeHeaderForFingerprint);
  return createHash('sha256')
    .update(normalized.join('\x1f') + '\x1e' + delimiter)
    .digest('hex');
}

const DATE_LIKE = /^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;
const NUMBER_LIKE = /^-?[\d\s.,]+$/;

/**
 * Heurystyka: znajdź najbardziej prawdopodobny wiersz nagłówka i delimiter.
 * Dla każdego delimitera parsujemy pierwsze MAX_SCAN_ROWS wierszy i punktujemy
 * wiersze-kandydatów: dużo niepustych, UNIKALNYCH komórek, z których <30%
 * wygląda na liczby/daty (nagłówki to etykiety, nie dane).
 * Zwraca null, gdy żaden kandydat nie ma ≥2 kolumn.
 */
export function locateHeaderCandidate(content: string): HeaderCandidate | null {
  let best: { candidate: HeaderCandidate; score: number } | null = null;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const parsed = Papa.parse<string[]>(content.trim(), {
      delimiter,
      header: false,
      skipEmptyLines: true,
      preview: MAX_SCAN_ROWS + 20, // nagłówek + zapas wierszy danych na próbkę
    });
    const rows = parsed.data;
    if (rows.length === 0) continue;

    const scanLimit = Math.min(rows.length, MAX_SCAN_ROWS);
    for (let i = 0; i < scanLimit; i++) {
      const cells = rows[i].map((c) => String(c ?? '').trim());
      const nonEmpty = cells.filter((c) => c !== '');
      if (nonEmpty.length < 2) continue;

      const distinct = new Set(nonEmpty.map((c) => c.toLowerCase()));
      const dataLike = nonEmpty.filter((c) => DATE_LIKE.test(c) || NUMBER_LIKE.test(c)).length;
      if (dataLike / nonEmpty.length >= 0.3) continue;

      // Nagłówek powinien opisywać kolumny także w wierszach danych poniżej:
      // premiuj kandydatów, po których następują wiersze o zbliżonej liczbie kolumn.
      const next = rows[i + 1];
      const widthBonus = next && Math.abs(next.length - cells.length) <= 2 ? 2 : 0;

      const score = distinct.size + widthBonus - i * 0.01; // przy remisie: wcześniejszy wiersz
      if (!best || score > best.score) {
        best = {
          score,
          candidate: {
            headers: cells,
            delimiter,
            headerRowIndex: i,
            sampleRows: rows.slice(i + 1, i + 21).map((r) => r.map((c) => String(c ?? ''))),
          },
        };
      }
    }
  }

  return best?.candidate ?? null;
}

/** Podobieństwo Jaccarda zbiorów znormalizowanych nagłówków — do sugestii profili. */
export function jaccardSimilarity(headersA: string[], headersB: string[]): number {
  const a = new Set(headersA.map(normalizeHeaderForFingerprint));
  const b = new Set(headersB.map(normalizeHeaderForFingerprint));
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const h of a) if (b.has(h)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
