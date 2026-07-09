/**
 * Stopa wolna od ryzyka dopasowana do terminu opcji — do modelu Black-Scholes (greeki/IV).
 * Krzywa z rentowności skarbowych US (Yahoo, indeksy w %): 13-tyg. bill i obligacje 5/10/30 lat.
 * Interpolacja liniowa po terminie (krótkie DTE → krótka stopa). „Teraz" z ceny bieżącej,
 * „z dnia zakupu" z historii na daną datę. Zakłada USD (u usera opcje są USD); dla innych
 * walut to przybliżenie.
 */
import { fetchYahooPrice, fetchYahooHistory } from './yahoo-finance.js';

const TENORS: Array<{ ticker: string; years: number }> = [
  { ticker: '^IRX', years: 0.25 }, // 13-week T-bill
  { ticker: '^FVX', years: 5 },
  { ticker: '^TNX', years: 10 },
  { ticker: '^TYX', years: 30 },
];

const DEFAULT_RATE = 0.043; // fallback, gdy Yahoo niedostępne

function addDaysIso(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Rentowność (%) danego tenoru — bieżąca (date=undefined) albo ostatnia ≤ date. */
async function yieldPct(ticker: string, date?: string): Promise<number | null> {
  try {
    if (!date) {
      const yp = await fetchYahooPrice(ticker);
      return yp?.price ?? null;
    }
    // Okno 10 dni wstecz — łapie weekendy/święta; bierzemy ostatni punkt ≤ date.
    const hist = await fetchYahooHistory(ticker, addDaysIso(date, -10), date);
    const usable = hist.filter((h) => h.date <= date);
    return usable.length ? usable[usable.length - 1].close : null;
  } catch {
    return null;
  }
}

/** Zbiera dostępne punkty krzywej (rentowność w ułamku) posortowane po terminie. */
async function curve(date?: string): Promise<Array<{ years: number; rate: number }>> {
  const points = await Promise.all(
    TENORS.map(async (t) => {
      const pct = await yieldPct(t.ticker, date);
      return pct != null && Number.isFinite(pct) ? { years: t.years, rate: pct / 100 } : null;
    }),
  );
  return points
    .filter((p): p is { years: number; rate: number } => p !== null)
    .sort((a, b) => a.years - b.years);
}

/**
 * Stopa wolna od ryzyka (ułamek) dla opcji o terminie `years` lat, opcjonalnie na dzień `date`
 * (historyczna). Interpolacja liniowa; clamp poza zakresem krzywej; DEFAULT_RATE gdy brak danych.
 */
export async function riskFreeRate(years: number, date?: string): Promise<number> {
  const pts = await curve(date);
  if (pts.length === 0) return DEFAULT_RATE;
  if (pts.length === 1) return pts[0].rate;
  const y = Math.max(0, years);
  if (y <= pts[0].years) return pts[0].rate;
  if (y >= pts[pts.length - 1].years) return pts[pts.length - 1].rate;
  for (let i = 1; i < pts.length; i++) {
    if (y <= pts[i].years) {
      const a = pts[i - 1];
      const b = pts[i];
      const w = (y - a.years) / (b.years - a.years);
      return a.rate + w * (b.rate - a.rate);
    }
  }
  return pts[pts.length - 1].rate;
}
