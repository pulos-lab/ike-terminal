/**
 * Model Black-Scholes dla opcji europejskich (equity, dywidenda q=0) — wycena, greeki
 * i odwrócenie do zmienności implikowanej (IV). Yahoo nie udostępnia greeków ani (bez
 * crumba) IV, więc liczymy je tu sami; IV wychodzi z inwersji ceny rynkowej opcji
 * (tryb „teraz") lub premii transakcji (tryb „z dnia zakupu").
 *
 * Konwencje jednostek greeków (wygodne do prezentacji):
 * - delta, gamma: na 1 jednostkę kursu bazowego (per akcja, bez mnożnika kontraktu),
 * - theta: na 1 DZIEŃ kalendarzowy (roczna /365),
 * - vega: na +1 PUNKT PROCENTOWY zmienności (na 1.0 vol /100),
 * - rho:  na +1 PUNKT PROCENTOWY stopy (na 1.0 rate /100).
 * Skalowanie do pozycji (× mnożnik × liczba kontraktów) robi konsument.
 */

export type OptionRight = 'C' | 'P';

/** Dystrybuanta standardowego rozkładu normalnego (aproksymacja erf Abramowitza-Steguna). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x); // = normPdf(x)
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Gęstość standardowego rozkładu normalnego. */
export function normPdf(x: number): number {
  return 0.3989422804014327 * Math.exp(-0.5 * x * x);
}

/**
 * Cena opcji Black-Scholes.
 * @param S kurs bazowego, @param K strike, @param T czas do wygaśnięcia w LATACH,
 * @param r stopa wolna od ryzyka (ułamek, np. 0.043), @param sigma zmienność (ułamek roczny).
 */
export function bsPrice(
  right: OptionRight,
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0 || sigma <= 0) {
    // Degeneracja: wartość = wewnętrzna (zdyskontowanie pomijalne dla T≈0).
    return right === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-r * T);
  return right === 'C'
    ? S * normCdf(d1) - K * disc * normCdf(d2)
    : K * disc * normCdf(-d2) - S * normCdf(-d1);
}

export interface BsGreeks {
  delta: number;
  gamma: number;
  /** na 1 dzień */
  theta: number;
  /** na +1 pp IV */
  vega: number;
  /** na +1 pp stopy */
  rho: number;
}

/** Greeki Black-Scholes (jednostki jak w nagłówku pliku). */
export function bsGreeks(
  right: OptionRight,
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): BsGreeks {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    // Po wygaśnięciu delta ≈ 1/0 wg moneyness, reszta 0.
    const itm = right === 'C' ? S > K : S < K;
    return { delta: itm ? (right === 'C' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-r * T);
  const pdf = normPdf(d1);

  const delta = right === 'C' ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf / (S * sigma * sqrtT);
  const vegaPerVol = S * pdf * sqrtT; // na 1.0 vol
  // Theta roczna:
  const thetaCommon = -(S * pdf * sigma) / (2 * sqrtT);
  const thetaYear =
    right === 'C'
      ? thetaCommon - r * K * disc * normCdf(d2)
      : thetaCommon + r * K * disc * normCdf(-d2);
  const rhoPerRate = right === 'C' ? K * T * disc * normCdf(d2) : -K * T * disc * normCdf(-d2); // na 1.0 rate

  return {
    delta,
    gamma,
    theta: thetaYear / 365,
    vega: vegaPerVol / 100,
    rho: rhoPerRate / 100,
  };
}

/**
 * Zmienność implikowana z ceny rynkowej — inwersja Black-Scholesa. Newton-Raphson po
 * vedze z fallbackiem na bisekcję; zwraca null, gdy cena jest poniżej wartości wewnętrznej,
 * poza granicami arbitrażu albo brak zbieżności (np. tuż przed wygaśnięciem).
 */
export function impliedVol(
  right: OptionRight,
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
): number | null {
  if (!(marketPrice > 0) || T <= 0 || S <= 0 || K <= 0) return null;
  const intrinsic = right === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  // Cena musi leżeć między wartością wewnętrzną (zdyskontowaną) a górną granicą (S dla call, K·e^-rT dla put).
  const upper = right === 'C' ? S : K * Math.exp(-r * T);
  if (marketPrice < intrinsic - 1e-6 || marketPrice > upper + 1e-6) return null;

  const LO = 0.001;
  const HI = 5;
  let sigma = 0.5;
  for (let i = 0; i < 60; i++) {
    const price = bsPrice(right, S, K, T, r, sigma);
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-6) return clampVol(sigma);
    const vegaPerVol = S * normPdf(d1of(S, K, T, r, sigma)) * Math.sqrt(T);
    if (vegaPerVol < 1e-8) break; // vega ~0 → Newton nieskuteczny, przejdź na bisekcję
    sigma -= diff / vegaPerVol;
    if (!(sigma > LO && sigma < HI)) break; // wypadło z zakresu → bisekcja
  }
  // Bisekcja jako pewny fallback.
  let lo = LO;
  let hi = HI;
  let plo = bsPrice(right, S, K, T, r, lo) - marketPrice;
  let phi = bsPrice(right, S, K, T, r, hi) - marketPrice;
  if (plo * phi > 0) return null; // brak pierwiastka w [LO,HI]
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    const pmid = bsPrice(right, S, K, T, r, mid) - marketPrice;
    if (Math.abs(pmid) < 1e-6) return clampVol(mid);
    if (plo * pmid < 0) {
      hi = mid;
      phi = pmid;
    } else {
      lo = mid;
      plo = pmid;
    }
  }
  return clampVol(0.5 * (lo + hi));
}

function d1of(S: number, K: number, T: number, r: number, sigma: number): number {
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}
function clampVol(s: number): number {
  return Math.min(5, Math.max(0.001, s));
}
