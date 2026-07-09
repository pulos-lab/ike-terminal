import Papa from 'papaparse';
import type {
  CashOperation,
  OperationType,
  RedemptionMarker,
  IpoSubscriptionMarker,
  CapitalReturnMarker,
  SkippedRow,
} from 'shared';
import {
  lookupTenderPrice,
  lookupIpoSubscription,
  isBondInstrument,
  findBondByTicker,
} from 'shared';
import { normalizeForDetect, parseNumber } from './utils.js';

/**
 * Parse Bossa cash operations CSV
 * Format: semicolon delimited, windows-1250 encoding (pre-decoded), comma decimals
 * Columns: data;tytuł operacji;szczegóły;kwota;waluta
 * Date format: YYYY-MM-DD
 */
/** Valid date format: YYYY-MM-DD */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Detect Bossa cash operations CSV (operacje_bez_transakcji.csv).
 * Nagłówek w pierwszej linii: data;tytuł operacji;szczegóły;kwota;waluta —
 * wymagamy FAKTYCZNYCH nazw kolumn po splicie średnikiem (delimiter Bossy),
 * nie luźnych substringów.
 */
export function isBossaOperationsFormat(csvContent: string): boolean {
  const headerCols = (csvContent.split('\n')[0] || '').split(';').map(normalizeForDetect);
  return (
    headerCols.includes('data') &&
    headerCols.includes('kwota') &&
    headerCols.includes('tytul operacji')
  );
}

export interface BossaOperationsParseResult {
  data: CashOperation[];
  skipped: SkippedRow[];
  /**
   * Markery domykające pozycje (Wykup certyfikatów, Rozliczenie oferty).
   * Nie są zapisywane jako CashOperation — reconciliation w import-service tworzy z nich
   * syntetyczną sprzedaż. Dzięki temu to samo cashflow nie jest liczone dwa razy (raz jako
   * deposit, raz jako wpływ ze sprzedaży).
   */
  redemptions: RedemptionMarker[];
  /**
   * Markery subskrypcji IPO — pary (Zapisy na akcje + Zwrot nadpłaty) dla emisji znajdujących
   * się w `ipo-subscriptions-map`. Reconciliation tworzy z nich syntetyczną K transakcję
   * z poprawnym qty (netto / ipoPrice), eliminując "pozycję znikąd" w portfelu.
   */
  ipoSubscriptions: IpoSubscriptionMarker[];
  /**
   * Markery zwrotu kapitału z istniejącej pozycji: obniżenie wartości nominalnej
   * (np. GETIN 2022-12-30), "Wykup PW - wyrównanie" (np. SOLV). Reconciliation wstawia
   * je jako CashOperation(type='capital_return', subkind=marker.kind) — to zapewnia:
   *   - brak zafałszowanego `deposit` w MWR denominator
   *   - widoczność w Zdarzeniach korporacyjnych
   *   - qty pozycji bez zmian (nikt nie sprzedał akcji)
   *   - amount wchodzi do portfolio_value (cash na koncie) → MWR/TWR poprawnie traktują
   *     to jak zrealizowany zwrot z trzymania pozycji.
   */
  capitalReturns: CapitalReturnMarker[];
  /**
   * Ostrzeżenia parsera (po polsku) — np. niesparowany leg subskrypcji IPO
   * (Zapisy na akcje bez Zwrotu nadpłaty lub odwrotnie), nieznana emisja spoza
   * `ipo-subscriptions-map`. Import-service dokleja je do crossFileWarnings.
   */
  warnings?: string[];
}

export function parseBossaOperations(
  csvContent: string,
  importBatch: string,
): BossaOperationsParseResult {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ';',
    header: true,
    skipEmptyLines: true,
  });

  // Validate that the CSV has expected headers — return empty array (not throw)
  const headers = result.meta?.fields || [];
  const hasDataCol = headers.some((h) => h.toLowerCase() === 'data');
  const hasKwotaCol = headers.some((h) => h.toLowerCase() === 'kwota');
  if (!hasDataCol || !hasKwotaCol) {
    return { data: [], skipped: [], redemptions: [], ipoSubscriptions: [], capitalReturns: [] };
  }

  const operations: CashOperation[] = [];
  const skipped: SkippedRow[] = [];

  // Dwa etapy: najpierw zbieramy wszystkie wiersze (potrzebujemy parować prowizje wezwań skupu),
  // potem emitujemy CashOperation + RedemptionMarker.
  type ParsedRow = {
    rowNum: number;
    dateStr: string;
    title: string;
    details: string;
    amount: number;
    currency: string;
  };
  const parsedRows: ParsedRow[] = [];

  const rows = result.data as any[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const dateStr = row['data']?.trim();
    const title = row['tytuł operacji']?.trim() || row['tytu\u0142 operacji']?.trim() || '';
    const details = row['szczegóły']?.trim() || row['szczeg\u00f3\u0142y']?.trim() || '';
    const amount = parseNumber(row['kwota']);
    const currency = row['waluta']?.trim() || 'PLN';

    if (!dateStr) {
      skipped.push({ row: rowNum, reason: 'missing_date', paperName: title });
      continue;
    }
    if (!DATE_RE.test(dateStr)) {
      skipped.push({ row: rowNum, reason: 'invalid_date', paperName: title });
      continue;
    }
    if (amount === 0) {
      skipped.push({ row: rowNum, reason: 'zero_amount', paperName: title });
      continue;
    }

    parsedRows.push({ rowNum, dateStr, title, details, amount, currency });
  }

  // Pre-scan: zbierz prowizje wezwań skupu parowane po (ticker, date) — żeby kolejność wierszy
  // w CSV (prowizja vs główny wiersz) nie wpływała na wynik.
  const offerCommissions = new Map<string, number>();
  const offerMainRows = new Map<string, { rowNum: number; amount: number }>();
  for (const pr of parsedRows) {
    const prowizjaMatch = pr.title.match(/Rozliczenie oferty - prowizja\s+(\S+)/);
    if (prowizjaMatch) {
      offerCommissions.set(`${prowizjaMatch[1]}|${pr.dateStr}`, Math.abs(pr.amount));
      continue;
    }
    const mainMatch = pr.title.match(/^Rozliczenie oferty\s+(\S+)/);
    if (mainMatch) {
      offerMainRows.set(`${mainMatch[1]}|${pr.dateStr}`, { rowNum: pr.rowNum, amount: pr.amount });
    }
  }

  // Pre-scan IPO: parujemy `Zapisy na akcje X` z `Zwrot nadpłaty X` po normalizowanym tickerze.
  // Normalizacja: "BIOCELTIX S.A." → "BIOCELTIX", "BIOCELTIX" → "BIOCELTIX".
  // Dwa wiersze powinny mieć podobną datę (± kilka dni); rekord finalny używa daty Zwrotu
  // jako `allocationDate` (wtedy akcje fizycznie trafiają na rachunek).
  type IpoRowInfo = {
    rowNum: number;
    dateStr: string;
    amount: number;
    series?: string;
    rawTitle: string;
  };
  const ipoSubRows = new Map<string, IpoRowInfo>();
  const ipoRefundRows = new Map<string, IpoRowInfo>();
  for (const pr of parsedRows) {
    const subMatch = pr.title.match(/^Zapisy na akcje\s+(.+?)(?:\s+SERIA\s+(\S+))?$/i);
    if (subMatch) {
      const normTicker = normalizeCompanyName(subMatch[1]);
      ipoSubRows.set(normTicker, {
        rowNum: pr.rowNum,
        dateStr: pr.dateStr,
        amount: pr.amount,
        series: subMatch[2],
        rawTitle: pr.title,
      });
      continue;
    }
    // Zwrot nadpłaty — odróżniamy od "Zwrot nadpłaty - przekroczony limit IKE/IKZE" (nie IPO)
    if (pr.title.startsWith('Zwrot nadpłaty') || pr.title.startsWith('Zwrot nadp\u0142aty')) {
      if (pr.title.includes('przekroczony limit')) continue;
      const refMatch = pr.title.match(/Zwrot nadp(?:łaty|\u0142aty)\s+(.+?)(?:\s+S\.A\.)?$/);
      if (refMatch) {
        const normTicker = normalizeCompanyName(refMatch[1]);
        ipoRefundRows.set(normTicker, {
          rowNum: pr.rowNum,
          dateStr: pr.dateStr,
          amount: pr.amount,
          rawTitle: pr.title,
        });
      }
    }
  }

  const redemptions: RedemptionMarker[] = [];
  const ipoSubscriptions: IpoSubscriptionMarker[] = [];
  const capitalReturns: CapitalReturnMarker[] = [];
  const warnings: string[] = [];
  const ipoConsumedRows = new Set<number>(); // rowNum wierszy Zapisy/Zwrot skonsumowanych przez marker IPO

  // Budowanie markerów IPO: dla każdej pary (Zapisy ↔ Zwrot) po normalizowanym tickerze
  // sprawdź mapę. Jeśli znana — emituj marker i oznacz oba wiersze jako skonsumowane.
  // Niesparowane legi (Zapisy bez Zwrotu lub odwrotnie) oraz pary spoza mapy NIE giną —
  // wpadają niżej jako zwykły withdrawal/deposit, ale dostają warning: cashflow jest
  // zachowany, natomiast pozycja z przydziału akcji NIE powstanie automatycznie.
  for (const [normTicker, sub] of ipoSubRows) {
    const refund = ipoRefundRows.get(normTicker);
    if (!refund) {
      warnings.push(
        `Wiersz ${sub.rowNum}: znaleziono zapis IPO "${sub.rawTitle}" (${sub.dateStr}), ale bez ` +
          `pasującego wiersza "Zwrot nadpłaty ${normTicker}" — nie udało się go rozliczyć. ` +
          `Kwota została zaksięgowana jako wypłata gotówki; pozycję z przydziału akcji ` +
          `może być konieczne dodać ręcznie w panelu Transakcje.`,
      );
      continue;
    }
    const entry = lookupIpoSubscription(normTicker, sub.dateStr);
    if (!entry) {
      // Nieznane IPO (brak w ipo-subscriptions-map) — oba wiersze wpadną jako zwykły
      // withdrawal/deposit; warning, bo akcje z przydziału nie pojawią się w portfelu.
      warnings.push(
        `Subskrypcja IPO "${sub.rawTitle}" (${sub.dateStr}) ze zwrotem nadpłaty ` +
          `(${refund.dateStr}) nie figuruje w mapie znanych emisji — nie udało się jej ` +
          `rozliczyć automatycznie. Przepływy gotówkowe zostały zaimportowane, ale pozycję ` +
          `z przydziału akcji może być konieczne dodać ręcznie w panelu Transakcje.`,
      );
      continue;
    }
    ipoSubscriptions.push({
      subscriptionDate: sub.dateStr,
      allocationDate: refund.dateStr,
      ticker: entry.ticker,
      isin: entry.isin,
      ipoPrice: entry.ipoPrice,
      subscriptionAmount: Math.abs(sub.amount),
      refundAmount: refund.amount,
      currency: 'PLN',
      series: entry.series,
      sourceUrl: entry.source,
    });
    ipoConsumedRows.add(sub.rowNum);
    ipoConsumedRows.add(refund.rowNum);
  }

  // Osierocony leg zwrotu: "Zwrot nadpłaty X" bez wcześniejszego "Zapisy na akcje X".
  // Wpadnie niżej jako deposit (cashflow zachowany), ale subskrypcji nie da się rozliczyć.
  for (const [normTicker, refund] of ipoRefundRows) {
    if (ipoSubRows.has(normTicker)) continue;
    warnings.push(
      `Wiersz ${refund.rowNum}: znaleziono zwrot nadpłaty IPO "${refund.rawTitle}" ` +
        `(${refund.dateStr}), ale bez pasującego wiersza "Zapisy na akcje ${normTicker}" — ` +
        `nie udało się go rozliczyć. Kwota została zaksięgowana jako wpłata gotówki; ` +
        `zweryfikuj, czy pozycja z przydziału akcji nie wymaga ręcznego dodania w panelu Transakcje.`,
    );
  }

  for (const pr of parsedRows) {
    const { rowNum, dateStr, title, details, amount, currency } = pr;

    // 0. IPO subscription / refund pair skonsumowane przez marker → skip obu wierszy.
    //    Cashflow reprezentuje syntetyczna K transakcja generowana przez reconciliation.
    if (ipoConsumedRows.has(rowNum)) {
      skipped.push({ row: rowNum, reason: 'redemption_reconciled', paperName: title });
      continue;
    }

    // 1. Wykup certyfikatów (kind='certificate') — all-or-nothing, reconciliation zamknie pełne openQty.
    const certMatch = title.match(/Wykup certyfikat(?:ów|\u00f3w)\s+(\S+)/);
    if (certMatch) {
      redemptions.push({
        date: `${dateStr}T00:00:00`,
        ticker: certMatch[1],
        amount,
        commission: 0,
        description: humanizeDescription(title),
        currency,
        source: 'bossa',
        kind: 'certificate',
      });
      skipped.push({ row: rowNum, reason: 'redemption_reconciled', paperName: title });
      continue;
    }

    // 2. Rozliczenie oferty (wezwanie skupu) — sprawdź mapę cen.
    const tenderMainMatch = title.match(/^Rozliczenie oferty\s+(\S+)/);
    if (tenderMainMatch) {
      const ticker = tenderMainMatch[1];
      const entry = lookupTenderPrice(ticker, dateStr);
      if (entry) {
        // Znane wezwanie: emit RedemptionMarker, pair z prowizją; nie wstawiamy deposit.
        const commission = offerCommissions.get(`${ticker}|${dateStr}`) ?? 0;
        redemptions.push({
          date: `${dateStr}T00:00:00`,
          ticker,
          amount,
          commission,
          description: humanizeDescription(title),
          currency,
          source: 'bossa',
          kind: 'tender',
          tenderPrice: entry.pricePerShare,
          sourceUrl: entry.source,
        });
        skipped.push({ row: rowNum, reason: 'redemption_reconciled', paperName: title });
        continue;
      }
      // Nieznane wezwanie: wpadnie niżej do classifyOperation → deposit, service doda warning.
    }

    // 3. Prowizja od Rozliczenie oferty dla ZNANEGO wezwania → skip (zużyta przy markerze).
    // Dla NIEZNANEGO wezwania → spada do classifyOperation jako fee.
    const prowizjaMatch = title.match(/Rozliczenie oferty - prowizja\s+(\S+)/);
    if (prowizjaMatch) {
      const mainRow = offerMainRows.get(`${prowizjaMatch[1]}|${dateStr}`);
      if (mainRow && lookupTenderPrice(prowizjaMatch[1], dateStr)) {
        skipped.push({ row: rowNum, reason: 'redemption_reconciled', paperName: title });
        continue;
      }
    }

    // 4. Obniżenie wartości nominalnej (np. GETIN 8250 PLN 2022-12-30) — zwrot kapitału
    // z istniejącej pozycji bez zmiany qty. Emit CapitalReturnMarker zamiast deposit/other.
    // Engine traktuje to jak "dywidendę w kapitale" — wchodzi do totalValue ale NIE do
    // totalDeposited. MWR/TWR odzwierciedlą to jako zrealizowany zwrot z trzymania.
    const nominalReductionMatch = title.match(
      /Obni(?:żenie|\u017cenie) warto(?:ści|\u015bci) nominalnej\s+(\S+)/,
    );
    if (nominalReductionMatch) {
      capitalReturns.push({
        kind: 'nominal_reduction',
        date: `${dateStr}T00:00:00`,
        ticker: nominalReductionMatch[1],
        amount,
        currency,
        source: 'bossa',
        description: humanizeDescription(title),
        originalTitle: title,
      });
      skipped.push({ row: rowNum, reason: 'capital_return_reconciled', paperName: title });
      continue;
    }

    // 5. Wykup PW - wyrównanie TICKER (np. SOLV) — końcowa korekta/dopłata po wcześniejszym
    // wykupie papieru wartościowego. Emit CapitalReturnMarker z kind='redemption_adjustment'.
    // Widoczne w Zdarzeniach korporacyjnych; wcześniej wpadało w 'unknown → other' (niewidoczne).
    const warrantAdjustMatch = title.match(/Wykup PW\s*-\s*wyr(?:ównanie|\u00f3wnanie)\s+(\S+)/);
    if (warrantAdjustMatch) {
      capitalReturns.push({
        kind: 'redemption_adjustment',
        date: `${dateStr}T00:00:00`,
        ticker: warrantAdjustMatch[1],
        amount,
        currency,
        source: 'bossa',
        description: humanizeDescription(title),
        originalTitle: title,
      });
      skipped.push({ row: rowNum, reason: 'capital_return_reconciled', paperName: title });
      continue;
    }

    // 6. Wykup obligacji w terminie (Catalyst) — emit RedemptionMarker(kind='bond');
    // reconciliation policzy qty = round(amount / nominal) (wspiera częściowy wykup).
    // Wzorce defensywne (realne tytuły Bossy dla obligacji niezweryfikowane — brak danych):
    // "Wykup obligacji DS1030" / "Wykup papierów wartościowych DS1030" / "Wykup PW DS1030".
    // Warunek isBondInstrument chroni przed przechwyceniem nie-obligacji — taki tytuł
    // spada do classifyOperation → 'unknown' → 'other' + warning (nic nie ginie).
    // Kolejność ważna: "Wykup certyfikatów" (krok 1) i "Wykup PW - wyrównanie" (krok 5)
    // są przechwytywane wyżej.
    const bondRedemptionMatch = title.match(
      /^Wykup (?:obligacji|papierów wartościowych|PW)\s+(\S+)/,
    );
    if (bondRedemptionMatch && isBondInstrument(bondRedemptionMatch[1])) {
      const bondTicker = bondRedemptionMatch[1].toUpperCase();
      redemptions.push({
        date: `${dateStr}T00:00:00`,
        ticker: bondTicker,
        amount,
        commission: 0,
        description: humanizeDescription(title),
        currency,
        source: 'bossa',
        kind: 'bond',
        nominal: findBondByTicker(bondTicker)?.nominal,
      });
      skipped.push({ row: rowNum, reason: 'redemption_reconciled', paperName: title });
      continue;
    }

    // 7. Kupon/odsetki od obligacji — przychód z pozycji, księgowany jak dywidenda
    // z subkind='coupon' (wchodzi do totalDividends i panelu Dywidendy z badge "Kupon").
    // Warunek isBondInstrument odróżnia od odsetek od salda gotówki ("Odsetki od środków...")
    // — te spadają niżej do classifyOperation → unknown/other jak dotychczas.
    const couponMatch =
      title.match(
        /^(?:Wypłata\s+)?[Oo]dset(?:ek|ki)(?:\s+(?:od\s+obligacji|z\s+tytułu\s+obligacji))?\s+(\S+)/,
      ) || title.match(/^Wypłata kuponu\s+(\S+)/i);
    if (couponMatch && isBondInstrument(couponMatch[1])) {
      operations.push({
        date: `${dateStr}T00:00:00`,
        operationType: 'dividend',
        description: humanizeDescription(title),
        details: details || undefined,
        amount,
        currency,
        ticker: couponMatch[1].toUpperCase(),
        source: 'bossa',
        importBatch,
        subkind: 'coupon',
      });
      continue;
    }

    const operationType = classifyOperation(title);

    // Settlement records (Rozliczenie transakcji) → skip, należą do transakcji.
    if (operationType === 'skip') {
      skipped.push({ row: rowNum, reason: 'settlement_record', paperName: title });
      continue;
    }

    // Nieznany typ operacji → zapisujemy jako `other` (żeby zachować cashflow),
    // ale dodatkowo oznaczamy w `skipped` z `unknown_operation_type` — UI pokaże w warnings
    // żeby user mógł ręcznie zweryfikować klasyfikację (P3+P7).
    if (operationType === 'unknown') {
      skipped.push({ row: rowNum, reason: 'unknown_operation_type', paperName: title });
    }

    // Nieznane wezwanie skupu — Bossa parser wpuszcza "Rozliczenie oferty TICKER" tu
    // (gdy ticker NIE jest w tender-offers-map, krok 2 wyżej nie wyemitował RedemptionMarker).
    // Wcześniej wpadało jako `deposit` → inflowowało XIRR/MWR. Teraz → `corporate_action_pending`
    // z subkind='unknown_tender' — neutralne dla MWR, widoczne w Zdarzeniach korporacyjnych z CTA
    // "Domknij" (user dodaje synthetic SELL przez endpoint resolve).
    let effectiveType: OperationType = operationType === 'unknown' ? 'other' : operationType;
    let subkind: CashOperation['subkind'] = undefined;
    const tenderFallbackMatch = title.match(/^Rozliczenie oferty\s+(\S+)/);
    if (tenderFallbackMatch && operationType === 'deposit') {
      effectiveType = 'corporate_action_pending';
      subkind = 'unknown_tender';
    }

    // Sign check: jeśli classifyOperation sklasyfikowało jako 'deposit' ale kwota jest UJEMNA,
    // to faktycznie wypływ gotówki — reklasyfikuj na 'withdrawal'. Typowe przypadki:
    //   - "Zwrot nadpłaty — przekroczony limit IKE/IKZE" (broker oddaje user'owi nadpłatę
    //     która przekroczyła roczny limit wpłat, cash wychodzi z rachunku)
    //   - ewentualne "Przelew" z ujemnym znakiem (choć Bossa zwykle używa dedykowanych tytułów)
    // Bez tego fixa engine filtruje deposity wymagając amount>0 (line 1092 portfolio-engine.ts),
    // więc ujemne deposity zostają cichaczem zignorowane z MWR/XIRR — totalWithdrawn nie
    // powiększa licznika, a cash balance i tak spada — return % przekłamany w dół.
    if (effectiveType === 'deposit' && amount < 0) {
      effectiveType = 'withdrawal';
    }

    const ticker = parseDividendTicker(title);
    const fxInfo = parseFxRate(title);

    operations.push({
      date: `${dateStr}T00:00:00`,
      operationType: effectiveType,
      description: humanizeDescription(title),
      details: details || undefined,
      amount,
      currency,
      ticker: ticker || undefined,
      fxRate: fxInfo?.rate,
      fxPair: fxInfo?.pair,
      source: 'bossa',
      importBatch,
      subkind,
    });
  }

  return {
    data: operations,
    skipped,
    redemptions,
    ipoSubscriptions,
    capitalReturns,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Normalizuj nazwę spółki z tytułu Bossy do klucza matchingu z mapą IPO.
 * Usuwa suffiksy "S.A.", "SA", "S. A.", nadmiarowe spacje. Przykłady:
 *   "BIOCELTIX S.A."  → "BIOCELTIX"
 *   "BIOCELTIX"       → "BIOCELTIX"
 *   "BIOCELTIX S. A." → "BIOCELTIX"
 */
function normalizeCompanyName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+S\.\s*A\.\s*$/i, '')
    .replace(/\s+SA\s*$/i, '')
    .trim();
}

/** Generate human-readable description from raw Bossa operation title */
function humanizeDescription(title: string): string {
  if (title === 'Zwrot prowizji') return 'Zwrot prowizji';
  if (title.startsWith('Przelew do DM')) return 'Zasilenie konta';
  if (title.startsWith('Przelew wewnętrzny') || title.startsWith('Przelew wewn\u0119trzny'))
    return title;

  // Dywidendy: "Wypłata dywidendy brutto ASBIS" → "Dywidenda brutto ASBIS"
  const divMatch =
    title.match(/Wypłata dywidendy\s+(.*)/i) || title.match(/Wyp\u0142ata dywidendy\s+(.*)/i);
  if (divMatch) return `Dywidenda ${divMatch[1]}`;

  // Rozliczenie oferty — humanize dla ewentualnych edge-case'ów (głównie idzie jako RedemptionMarker)
  const offerFeeMatch = title.match(/Rozliczenie oferty - prowizja\s+(\S+)/);
  if (offerFeeMatch) return `Prowizja od oferty skupu ${offerFeeMatch[1]}`;
  const offerMatch = title.match(/Rozliczenie oferty\s+(\S+)/);
  if (offerMatch) return `Wykup w ofercie skupu ${offerMatch[1]}`;

  // Wykup certyfikatów (głównie idzie jako RedemptionMarker)
  const certMatch = title.match(/Wykup certyfikat(?:ów|\u00f3w)\s+(\S+)/);
  if (certMatch) return `Wykup certyfikatów ${certMatch[1]}`;

  // Zapisy na akcje: "Zapisy na akcje BIOCELTIX S.A. SERIA G" → "Subskrypcja akcji BIOCELTIX (seria G)"
  const subMatch = title.match(/Zapisy na akcje\s+(.+?)(?:\s+SERIA\s+(\S+))?$/i);
  if (subMatch) {
    const name = subMatch[1].replace(/\s+S\.A\.$/, '');
    return subMatch[2]
      ? `Subskrypcja akcji ${name} (seria ${subMatch[2]})`
      : `Subskrypcja akcji ${name}`;
  }

  if (title.includes('przekroczony limit')) return 'Zwrot nadpłaty — przekroczony limit IKE/IKZE';
  const refundMatch = title.match(/Zwrot nadp(?:łaty|\u0142aty)\s+(.+?)(?:\s+S\.A\.)?$/);
  if (refundMatch)
    return `Zwrot nadpłaty z subskrypcji ${refundMatch[1].replace(/\s+S\.A\.$/, '')}`;

  const nominalMatch = title.match(
    /Obni(?:żenie|[\u017c]enie) warto(?:ści|[\u015b]ci) nominalnej\s+(\S+)/,
  );
  if (nominalMatch) return `Zwrot kapitału ${nominalMatch[1]} (obniżenie nominału)`;

  // Wykup PW - wyrównanie TICKER → "Wyrównanie wykupu TICKER"
  const warrantAdjust = title.match(/Wykup PW\s*-\s*wyr(?:ównanie|[\u00f3]wnanie)\s+(\S+)/);
  if (warrantAdjust) return `Wyrównanie wykupu ${warrantAdjust[1]}`;

  // Obligacje: tylko gdy ticker faktycznie wygląda na obligację (spójnie z główną pętlą)
  const bondRedemption = title.match(/^Wykup (?:obligacji|papierów wartościowych|PW)\s+(\S+)/);
  if (bondRedemption && isBondInstrument(bondRedemption[1]))
    return `Wykup obligacji ${bondRedemption[1].toUpperCase()}`;
  const coupon =
    title.match(/^(?:Wypłata\s+)?[Oo]dset(?:ek|ki)(?:\s+od\s+obligacji)?\s+(\S+)/) ||
    title.match(/^Wypłata kuponu\s+(\S+)/i);
  if (coupon && isBondInstrument(coupon[1])) return `Kupon ${coupon[1].toUpperCase()}`;

  return title;
}

/**
 * Klasyfikacja operacji. Zwraca:
 * - konkretny OperationType dla rozpoznanych typów
 * - 'skip' dla settlement records (Rozliczenie transakcji)
 * - 'unknown' dla nierozpoznanego tytułu (traktowane jako 'other' + dodane do warnings przez caller)
 *
 * UWAGA: Wykup certyfikatów i Rozliczenie oferty NIE przechodzą już przez tę funkcję —
 * są przechwytywane wcześniej jako RedemptionMarker (source-of-truth = synthetic sell
 * z reconciliation, nie deposit).
 */
function classifyOperation(title: string): OperationType | 'skip' | 'unknown' {
  if (title.includes('Rozliczenie transakcji')) return 'skip';

  // Wezwania skupu (tender offers):
  //   - `Rozliczenie oferty - prowizja TICKER` → prowizja brokera = fee
  //   - `Rozliczenie oferty TICKER` (główny wpływ) → deposit (cashflow widoczny w Gotówce)
  // NIE tworzymy tu syntetycznej sprzedaży — nie wiemy z CSV ile akcji poszło na tender
  // (broker podaje tylko kwotę netto, nie cenę ani liczbę szt). User dostaje warning
  // z prośbą o ręczne dodanie sprzedaży w panelu Transakcje. Patrz: bulkImport flow.
  if (title.includes('Rozliczenie oferty - prowizja')) return 'fee';
  if (title.startsWith('Rozliczenie oferty')) return 'deposit';

  if (title.includes('Przelew')) {
    // Kierunek (deposit/withdrawal) rozpozna caller po znaku amount — tu wystarczy klasyfikacja.
    // Konwencja istniejąca: zwracamy 'deposit' dla dodatnich, 'withdrawal' dla ujemnych.
    // Robimy to przez odczyt amount z closure w wywołaniu — ale classifyOperation dostaje tylko title,
    // więc zwracamy rozpoznany typ, a caller zadecyduje o deposit vs withdrawal jeśli trzeba.
    // Prosty heurystyk: Przelew wewnętrzny = deposit (bo zwyczajowo zasila konto), Przelew do DM = deposit.
    // Dla withdrawal (Przelew z rachunku gdzieś dalej) Bossa używa innych tytułów.
    return 'deposit';
  }
  if (title.toLowerCase().includes('dywidendy')) return 'dividend';
  if (title.includes('Wymiana waluty')) return 'fx_exchange';
  if (title.startsWith('Opłata za') || title.startsWith('Op\u0142ata za')) return 'fee';
  if (title.includes('Zwrot prowizji')) return 'commission_refund';
  // P6: Zwrot prowizji (90 wierszy w eksporcie testowym) pozostaje osobnym cashflowem.
  // NIE parujemy go do konkretnej transakcji — transakcje mają już `prowizja` zapłaconą
  // w kolumnie `prowizja` z hisPW, a zwrot to niezależne cash-eventy (często z anulowanych zleceń).
  // Dashboard XIRR liczy cashflow z wpłat/wypłat, więc zwrot jako `commission_refund`
  // nie zniekształca metryk. Parowanie heurystyczne miałoby duże ryzyko false-positive.
  if (title.includes('Zapisy na akcje') || title.includes('Zapisy na obligacje'))
    return 'withdrawal';
  if (title.includes('Zwrot nadpłaty') || title.includes('Zwrot nadp\u0142aty')) return 'deposit'; // caller może zmienić na withdrawal wg znaku
  // UWAGA: "Obniżenie wartości nominalnej" i "Wykup PW - wyrównanie" NIE przechodzą już przez
  // tę funkcję — są przechwytywane w głównej pętli jako CapitalReturnMarker.

  return 'unknown';
}

/**
 * Extract dividend ticker from title
 * "Wypłata dywidendy PLAYWAY" -> "PLAYWAY"
 * "Wypłata dywidendy netto NVO 73% PLN" -> "NVO"
 */
function parseDividendTicker(title: string): string | null {
  const match = title.match(/dywidendy(?:\s+(?:netto|brutto))?\s+(\w+)/i);
  return match ? match[1] : null;
}

/**
 * Extract FX rate from title
 * "Wymiana waluty PLN/USD 3.5713" -> { pair: "PLN/USD", rate: 3.5713 }
 */
function parseFxRate(title: string): { pair: string; rate: number } | null {
  const match = title.match(/Wymiana waluty (\w+\/\w+) ([\d.]+)/);
  if (match) {
    return { pair: match[1], rate: parseFloat(match[2]) };
  }
  return null;
}
