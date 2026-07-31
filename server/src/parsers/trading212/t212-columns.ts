/**
 * Mapowanie kolumn eksportu Trading 212 — WYŁĄCZNIE po nazwach nagłówka.
 *
 * Powód: T212 nie ma jednego układu. Na 27 realnych próbkach naliczyliśmy
 * 14 różnych nagłówków, bo broker dokłada kolumny zależnie od tego, co się
 * w okresie wydarzyło (`Withholding tax`, `Stamp duty reserve tax`, `French
 * transaction tax`, `Finra fee`, `Charge amount`, `Merchant name/category`,
 * `Currency conversion from/to amount`), a do tego występują DWA różne
 * PORZĄDKI kolumn:
 *
 *   Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,…,Notes,ID,…
 *   Action,Time,ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,…
 *
 * Każdy indeks pozycyjny byłby więc błędny w połowie plików. Mapowanie po
 * nazwach jest odporne na dokładanie, usuwanie i przestawianie kolumn — to
 * jedyne, co się w tym formacie zmienia.
 */

/** BOM, trim, lowercase, pojedyncze spacje — do porównywania nazw nagłówków. */
function norm(name: string): string {
  return name.replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Opłata/podatek transakcyjny: kwota + własna kolumna waluty. */
export interface T212FeeColumn {
  label: string;
  amount: number;
  currency: number;
}

export interface T212Columns {
  action: number;
  time: number;
  isin: number;
  ticker: number;
  name: number;
  shares: number;
  price: number;
  priceCurrency: number;
  /** Kurs w konwencji quote-per-payment (jak DEGIRO); bywa "Not available". */
  exchangeRate: number;
  /** Kwota rozliczenia W WALUCIE KONTA — NIE ilość × cena. */
  total: number;
  totalCurrency: number;
  withholdingTax: number;
  withholdingTaxCurrency: number;
  notes: number;
  id: number;
  /** Wszystkie obecne kolumny opłat i podatków transakcyjnych. */
  fees: T212FeeColumn[];
  /** Kolumny wymiany walut (nowszy wariant; starszy podaje kwoty w `Notes`). */
  fxFromAmount: number;
  fxFromCurrency: number;
  fxToAmount: number;
  fxToCurrency: number;
}

/** Indeks pierwszej pasującej nazwy albo −1. */
function idx(headers: string[], ...names: string[]): number {
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Kolumny opłat i podatków transakcyjnych doliczanych do prowizji.
 *
 * `charge amount` bywa w nagłówku, ale w ŻADNEJ z posiadanych próbek nie ma
 * wartości — traktujemy ją jak opłatę na podstawie nazwy, świadomie bez
 * potwierdzenia w danych.
 */
const FEE_COLUMNS = [
  'currency conversion fee',
  'finra fee',
  'french transaction tax',
  'stamp duty reserve tax',
  'stamp duty',
  'transaction fee',
  'charge amount',
] as const;

/**
 * Buduje mapę kolumn albo zwraca `null`, gdy plik nie wygląda na eksport T212.
 *
 * Wymagamy KOMPLETU kolumn rdzenia — one występują we wszystkich 14 wariantach
 * nagłówka, także w eksportach zawierających wyłącznie operacje gotówkowe
 * (kolumny instrumentu są wtedy puste, ale w nagłówku są).
 */
export function mapT212Columns(rawHeaders: string[]): T212Columns | null {
  const h = rawHeaders.map(norm);

  const cols: T212Columns = {
    action: idx(h, 'action'),
    // Jeden z wariantów nazywa kolumnę "Time (UTC)" — bez aliasu profil/parser
    // wywala się na pliku, który poza tym jest identyczny.
    time: idx(h, 'time', 'time (utc)'),
    isin: idx(h, 'isin'),
    ticker: idx(h, 'ticker'),
    name: idx(h, 'name'),
    shares: idx(h, 'no. of shares'),
    price: idx(h, 'price / share'),
    priceCurrency: idx(h, 'currency (price / share)'),
    exchangeRate: idx(h, 'exchange rate'),
    total: idx(h, 'total'),
    totalCurrency: idx(h, 'currency (total)'),
    withholdingTax: idx(h, 'withholding tax'),
    withholdingTaxCurrency: idx(h, 'currency (withholding tax)'),
    notes: idx(h, 'notes'),
    id: idx(h, 'id'),
    fees: [],
    fxFromAmount: idx(h, 'currency conversion from amount'),
    fxFromCurrency: idx(h, 'currency (currency conversion from amount)'),
    fxToAmount: idx(h, 'currency conversion to amount'),
    fxToCurrency: idx(h, 'currency (currency conversion to amount)'),
  };

  for (const label of FEE_COLUMNS) {
    const amount = idx(h, label);
    if (amount < 0) continue;
    cols.fees.push({ label, amount, currency: idx(h, `currency (${label})`) });
  }

  // Rdzeń formatu — brak którejkolwiek z tych kolumn = to nie jest T212.
  // Świadomie NIE wymagamy kolumn opcjonalnych (podatki, opłaty, karta).
  const required = [
    cols.action,
    cols.time,
    cols.isin,
    cols.ticker,
    cols.name,
    cols.shares,
    cols.price,
    cols.priceCurrency,
    cols.total,
    cols.totalCurrency,
  ];
  if (required.some((i) => i < 0)) return null;

  return cols;
}

/**
 * "2023-08-07 19:56:02" / "2025-03-24 07:24:24.095" → "2023-08-07T19:56:02".
 * Ułamki sekund odrzucamy (reszta aplikacji trzyma sekundy), a niepasujący
 * format zwraca `null` zamiast cichej daty-śmiecia.
 */
export function parseT212Time(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?/.exec(value.trim());
  return m ? `${m[1]}T${m[2]}` : null;
}
