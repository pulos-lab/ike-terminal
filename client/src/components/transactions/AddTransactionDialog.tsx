import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TickerAutocomplete } from '@/components/shared/TickerAutocomplete';
import { FieldError } from '@/components/ui/field-error';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
import { usePortfolio } from '@/lib/portfolio-context';
import { formatNumber } from '@/lib/formatters';
import { useFormValidation, type FieldErrors } from '@/lib/use-form-validation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { SpinOffChildWarning } from 'shared';
import { toOccTicker, optionDisplayName } from 'shared';

/**
 * Dialog ręcznego dodawania transakcji (kupno / sprzedaż dowolnego tickera).
 *
 * Uwaga: sprzedaż konkretnej otwartej pozycji ma własny inline flow w `TradesPage`
 * ("Sprzedaj" button w rzędzie pozycji — context-aware, prefilled qty/price). Ten dialog
 * obsługuje generyczny add (K lub S) poza kontekstem istniejącej pozycji.
 *
 * Pola: data, ticker, side, kategoria, ilość, cena (w walucie notowania), prowizja,
 * waluta zakupu (paymentCurrency), kurs FX (gdy paymentCurrency ≠ waluta notowania).
 * Auto-calc prowizji + pre-fill kursu FX live z pricesData.fx.
 */
const PAYMENT_CURRENCIES = ['auto', 'PLN', 'USD', 'EUR', 'GBP'] as const;

/** Heurystyka dla quoteCurrency gdy user wpisuje ticker ręcznie (bez wyboru z autocomplete). */
function inferQuoteFromTicker(t: string): string {
  const up = t.toUpperCase();
  if (up.endsWith('.WA') || up.endsWith('.NC')) return 'PLN';
  return '';
}

interface AddTransactionDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AddTransactionDialog({ open, onClose }: AddTransactionDialogProps) {
  const qc = useQueryClient();
  const { activeSettings } = usePortfolio();

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [ticker, setTicker] = useState('');
  const [side, setSide] = useState<'K' | 'S'>('K');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [commission, setCommission] = useState('0');
  const [commissionTouched, setCommissionTouched] = useState(false);
  /** Waluta notowania papieru — z TickerAutocomplete result lub heurystycznie z suffixu. */
  const [quoteCurrency, setQuoteCurrency] = useState<string>('');
  /** Waluta zakupu/rozliczenia — wybór usera. 'auto' = równa walucie notowania (brak FX). */
  const [paymentCurrency, setPaymentCurrency] = useState<string>('auto');
  const [fxRate, setFxRate] = useState('');
  const [category, setCategory] = useState<'stock' | 'etf' | 'cfd' | 'bond' | 'option'>('stock');
  // Parametry kontraktu opcyjnego (category === 'option'). Ticker OCC i pseudo-ISIN
  // generuje backend z tych pól — identycznie jak import IBKR.
  const [optUnderlying, setOptUnderlying] = useState('');
  const [optStrike, setOptStrike] = useState('');
  const [optExpiry, setOptExpiry] = useState('');
  const [optType, setOptType] = useState<'C' | 'P'>('C');
  const [optCurrency, setOptCurrency] = useState('USD');
  /** Ostrzeżenie z serwera: ticker jest dzieckiem zastosowanego spin-offu —
   *  pozycja mogła już powstać automatycznie; wymagamy jawnego potwierdzenia. */
  const [spinOffWarning, setSpinOffWarning] = useState<SpinOffChildWarning | null>(null);

  const { data: pricesData } = useQuery({
    queryKey: QUERY_KEYS.livePrices,
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });

  const isOption = category === 'option';
  const OPTION_MULTIPLIER = 100; // US equity options — zawsze 100

  // Podgląd kontraktu opcyjnego (ticker OCC jak w Yahoo) — gdy pola są kompletne.
  const optParsed =
    isOption && optUnderlying.trim() && optExpiry && parseFloat(optStrike) > 0
      ? {
          underlying: optUnderlying.trim().toUpperCase(),
          expiry: optExpiry,
          strike: parseFloat(optStrike),
          optionType: optType,
        }
      : null;

  // Efektywna waluta notowania: explicit (z autocomplete / auto-fetch) lub heurystyka z suffixu.
  const effectiveQuote = isOption ? optCurrency : quoteCurrency || inferQuoteFromTicker(ticker);
  // Efektywna waluta zakupu: 'auto' fallback = waluta notowania (brak przewalutowania).
  const effectivePayment = paymentCurrency !== 'auto' ? paymentCurrency : effectiveQuote;
  const showFxRate = Boolean(
    effectiveQuote && effectivePayment && effectivePayment !== effectiveQuote,
  );

  const formErrors = useMemo(() => {
    const e: FieldErrors<
      | 'date'
      | 'ticker'
      | 'quantity'
      | 'price'
      | 'fxRate'
      | 'optUnderlying'
      | 'optStrike'
      | 'optExpiry'
    > = {};
    if (!date) e.date = 'Podaj datę';
    if (isOption) {
      if (!optUnderlying.trim()) e.optUnderlying = 'Podaj ticker instrumentu bazowego';
      if (!optStrike || parseFloat(optStrike) <= 0) e.optStrike = 'Strike musi być większy od 0';
      if (!optExpiry) e.optExpiry = 'Wybierz datę wygaśnięcia';
      else if (optExpiry < date) e.optExpiry = 'Wygaśnięcie nie może być przed datą transakcji';
    } else if (!ticker.trim()) {
      e.ticker = 'Podaj ticker';
    }
    if (!quantity || parseFloat(quantity) <= 0) e.quantity = 'Ilość musi być większa od 0';
    if (!price || parseFloat(price) <= 0) e.price = 'Cena musi być większa od 0';
    if (showFxRate && (!fxRate || parseFloat(fxRate) <= 0)) e.fxRate = 'Podaj kurs przeliczenia';
    return e;
  }, [
    date,
    ticker,
    quantity,
    price,
    showFxRate,
    fxRate,
    isOption,
    optUnderlying,
    optStrike,
    optExpiry,
  ]);
  const { submitGuard, fieldError, reset: resetValidation } = useFormValidation(formErrors);

  // Reset state przy otwarciu dialogu
  useEffect(() => {
    if (!open) return;
    setDate(today);
    setTicker('');
    setSide('K');
    setQuantity('');
    setPrice('');
    setCommission('0');
    setCommissionTouched(false);
    setQuoteCurrency('');
    setPaymentCurrency('auto');
    setFxRate('');
    setCategory('stock');
    setOptUnderlying('');
    setOptStrike('');
    setOptExpiry('');
    setOptType('C');
    setOptCurrency('USD');
    setSpinOffWarning(null);
    resetValidation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Pre-fill kursu FX broker'a — działa gdy quote = USD/EUR/GBP i payment = PLN.
  // fxRate w aplikacji to: 1 unit `quote` = fxRate × `payment` (np. 1 USD = 4.00 PLN).
  const getLiveFxRate = (quote: string, payment: string): string => {
    const fx = pricesData?.fx;
    if (!fx) return '';
    if (payment !== 'PLN') return '';
    if (quote === 'USD' && fx.USDPLN) return fx.USDPLN.toFixed(4);
    if (quote === 'EUR' && fx.EURPLN) return fx.EURPLN.toFixed(4);
    if (quote === 'GBP' && fx.GBPPLN) return fx.GBPPLN.toFixed(4);
    return '';
  };

  // Auto-fetch waluty notowania z backendu gdy user wpisuje ticker ręcznie (bez wyboru z listy).
  // Bez tego — dla AAPL/MSFT/SPGI/… effectiveQuote='' → showFxRate=false → fxRate nie ustawiony →
  // auto-calc prowizji nie konwertuje, pole "Kurs przeliczenia" się nie pokazuje.
  // Yahoo search NIE zwraca currency, więc używamy dedykowanego /ticker-info (lokalny ticker_map
  // → Yahoo price fetch fallback).
  useEffect(() => {
    if (quoteCurrency) return; // już znamy z autocomplete
    const t = ticker.trim();
    if (t.length < 2) return;
    if (inferQuoteFromTicker(t)) return; // .WA/.NC — heurystyka wystarczy
    const timer = setTimeout(async () => {
      try {
        const info = await api.getTickerInfo(t);
        if (info?.currency) setQuoteCurrency(info.currency);
      } catch {
        /* network error — silent */
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [ticker, quoteCurrency]);

  // Auto-calc prowizji. Settings są wyrażone w walucie notowania (PL → PLN, FOREIGN → quote).
  // Gdy paymentCurrency ≠ quote, wynik konwertujemy przez fxRate na paymentCurrency, żeby pole
  // pokazywało liczbę zgodną z tym, co broker faktycznie pobiera (np. 19 PLN dla AAPL/PLN).
  const calcCommission = (
    tk: string,
    qty: string,
    prc: string,
    paymentCcy: string,
    quoteCcy: string,
    fxRateStr: string,
  ): string => {
    const q = parseFloat(qty);
    const p = parseFloat(prc);
    if (!q || !p || q <= 0 || p <= 0) return '0';
    const value = q * p;
    const isPolish = tk.endsWith('.WA') || tk.endsWith('.NC');
    const rate = isPolish
      ? activeSettings?.commissionPl || 0
      : activeSettings?.commissionForeign || 0;
    const min = isPolish
      ? activeSettings?.minCommissionPl || 0
      : activeSettings?.minCommissionForeign || 0;
    if (rate <= 0 && min <= 0) return '0';
    // Prowizja w walucie notowania (quote).
    const commQuote = Math.max((value * rate) / 100, min);
    // Konwersja na paymentCurrency jeśli różna od quote (i mamy fxRate).
    const fx = parseFloat(fxRateStr);
    const commPayment =
      paymentCcy && quoteCcy && paymentCcy !== quoteCcy && fx > 0 ? commQuote * fx : commQuote;
    return (Math.round(commPayment * 100) / 100).toString();
  };

  useEffect(() => {
    if (commissionTouched) return;
    if (isOption) return; // prowizje opcyjne są kwotowe per kontrakt — bez auto-calc
    if (!ticker || !quantity || !price) return;
    setCommission(
      calcCommission(ticker, quantity, price, effectivePayment, effectiveQuote, fxRate),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, quantity, price, commissionTouched, effectivePayment, effectiveQuote, fxRate]);

  useEffect(() => {
    if (!showFxRate) {
      setFxRate('');
      return;
    }
    setFxRate(getLiveFxRate(effectiveQuote, effectivePayment));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveQuote, effectivePayment, pricesData, showFxRate]);

  const createMut = useMutation({
    mutationFn: (opts?: { confirmSpinOff?: boolean }) => {
      const fxNum = parseFloat(fxRate);
      const commInput = parseFloat(commission) || 0;
      // Pole prowizji jest w paymentCurrency gdy ≠ quote. Backend oczekuje w walucie notowania
      // (zgodnie z value/price/total) — konwertujemy przez fxRate.
      const commQuote = showFxRate && fxNum > 0 ? commInput / fxNum : commInput;
      return api.createTransaction({
        date,
        ticker: isOption && optParsed ? toOccTicker(optParsed) : ticker,
        side,
        quantity: parseFloat(quantity),
        price: parseFloat(price),
        commission: Math.round(commQuote * 100) / 100,
        // `currency` (quote) zostaje przyjęte z ticker_map na backendzie —
        // wysyłamy tylko jeśli user explicit zmienił via TickerAutocomplete (rzadko).
        paymentCurrency: paymentCurrency !== 'auto' ? paymentCurrency : undefined,
        fxRate: showFxRate && fxNum > 0 ? fxNum : undefined,
        category,
        currency: isOption ? optCurrency : undefined,
        option:
          isOption && optParsed
            ? {
                underlying: optParsed.underlying,
                strike: optParsed.strike,
                expiry: optParsed.expiry,
                optionType: optParsed.optionType,
                multiplier: OPTION_MULTIPLIER,
              }
            : undefined,
        confirmSpinOff: opts?.confirmSpinOff,
      });
    },
    onSuccess: (data) => {
      // Miękkie ostrzeżenie (200 + requiresConfirmation): walor jest dzieckiem
      // spin-offu — pokazujemy panel potwierdzenia zamiast zamykać dialog.
      if (data.requiresConfirmation) {
        setSpinOffWarning(data.warning);
        return;
      }
      invalidatePortfolio(qc);
      toast.success(
        `Dodano ${side === 'K' ? 'kupno' : 'sprzedaż'} ${
          isOption && optParsed ? optionDisplayName(optParsed) : ticker
        }: ${quantity} @ ${price}`,
      );
      onClose();
    },
    onError: (e: Error) => errorToast('Nie udało się dodać', e),
  });

  // Podgląd wartości transakcji w paymentCurrency (z uwzględnieniem prowizji).
  // Prowizja jest już w paymentCurrency (input pola), więc dodajemy/odejmujemy bezpośrednio.
  const optMult = isOption ? OPTION_MULTIPLIER : 1;
  const plnPreview = (() => {
    if (!showFxRate || !fxRate || !quantity || !price) return null;
    const valuePayment = parseFloat(quantity) * parseFloat(price) * optMult * parseFloat(fxRate);
    const commPayment = parseFloat(commission) || 0;
    return side === 'K' ? valuePayment + commPayment : valuePayment - commPayment;
  })();
  // Podgląd wartości kontraktu opcyjnego w walucie notowania (mnożnik ×100 zaskakuje).
  const optionValuePreview =
    isOption && quantity && price ? parseFloat(quantity) * parseFloat(price) * optMult : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !createMut.isPending && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Dodaj transakcję</DialogTitle>
          <DialogDescription>
            Ręczne dodanie transakcji (kupno lub sprzedaż). Wlicza się do MWR/XIRR. Dla sprzedaży z
            otwartej pozycji użyj przycisku "Sprzedaj" w rzędzie pozycji.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Data *</label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-invalid={!!fieldError('date')}
            />
            <FieldError error={fieldError('date')} />
          </div>
          {!isOption && (
            <div>
              <label className="text-xs text-muted-foreground">Ticker *</label>
              <TickerAutocomplete
                value={ticker}
                onChange={(v, result) => {
                  setTicker(v);
                  // Aktualizuj walutę notowania z TickerAutocomplete result. Gdy user wpisuje
                  // ręcznie bez wyboru z listy — result undefined, czyść (heurystyka z suffixu
                  // zadziała w effectiveQuote).
                  if (result?.currency) setQuoteCurrency(result.currency);
                  else setQuoteCurrency('');
                }}
                placeholder="np. AAPL, CDR.WA"
              />
              <FieldError error={fieldError('ticker')} />
            </div>
          )}
          {isOption && (
            <div>
              <label className="text-xs text-muted-foreground">Instrument bazowy *</label>
              <Input
                value={optUnderlying}
                onChange={(e) => setOptUnderlying(e.target.value.toUpperCase())}
                placeholder="np. AAPL"
                aria-invalid={!!fieldError('optUnderlying')}
              />
              <FieldError error={fieldError('optUnderlying')} />
            </div>
          )}

          <div>
            <label className="text-xs text-muted-foreground">Typ *</label>
            <Select value={side} onValueChange={(v) => setSide(v as 'K' | 'S')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="K">Kupno (K)</SelectItem>
                <SelectItem value="S">Sprzedaż (S)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Kategoria</label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as 'stock' | 'etf' | 'cfd' | 'bond' | 'option')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stock">Stock</SelectItem>
                <SelectItem value="etf">ETF</SelectItem>
                <SelectItem value="cfd">CFD</SelectItem>
                <SelectItem value="bond">Obligacja</SelectItem>
                <SelectItem value="option">Opcja</SelectItem>
              </SelectContent>
            </Select>
            {category === 'bond' && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Ticker serii Catalyst (np. DS1030), cena w % wartości nominalnej (np. 98,50)
              </p>
            )}
          </div>

          {isOption && (
            <p className="md:col-span-2 -mt-1 text-[11px] text-muted-foreground">
              Wartość = liczba kontraktów × premia za akcję × 100. Sprzedaż bez wcześniejszego kupna
              otwiera pozycję krótką (wystawienie opcji).
            </p>
          )}

          {isOption && (
            <>
              <div>
                <label className="text-xs text-muted-foreground">Typ opcji *</label>
                <Select value={optType} onValueChange={(v) => setOptType(v as 'C' | 'P')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="C">CALL</SelectItem>
                    <SelectItem value="P">PUT</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Strike *</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={optStrike}
                  onChange={(e) => setOptStrike(e.target.value)}
                  placeholder="np. 150"
                  aria-invalid={!!fieldError('optStrike')}
                />
                <FieldError error={fieldError('optStrike')} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Data wygaśnięcia *</label>
                <Input
                  type="date"
                  value={optExpiry}
                  min={date}
                  onChange={(e) => setOptExpiry(e.target.value)}
                  aria-invalid={!!fieldError('optExpiry')}
                />
                <FieldError error={fieldError('optExpiry')} />
                {!optExpiry && !fieldError('optExpiry') && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Dzień wygaśnięcia kontraktu (zwykle piątek).
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Waluta kontraktu</label>
                <Select value={optCurrency} onValueChange={setOptCurrency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                    <SelectItem value="PLN">PLN</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {optParsed && (
                <div className="md:col-span-2 -mt-1">
                  <p className="text-[11px] text-muted-foreground font-mono">
                    Kontrakt: {optionDisplayName(optParsed)} · ticker {toOccTicker(optParsed)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    1 kontrakt = {OPTION_MULTIPLIER} akcji instrumentu bazowego.
                  </p>
                </div>
              )}
            </>
          )}

          <div>
            <label className="text-xs text-muted-foreground">
              {isOption ? 'Liczba kontraktów *' : 'Ilość *'}
            </label>
            <Input
              type="number"
              step={isOption ? '1' : '0.0001'}
              min="0"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0"
              aria-invalid={!!fieldError('quantity')}
            />
            <FieldError error={fieldError('quantity')} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {isOption ? 'Premia za akcję *' : 'Cena *'}
              {effectiveQuote && <span className="ml-1 opacity-60">({effectiveQuote})</span>}
            </label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              aria-invalid={!!fieldError('price')}
            />
            <FieldError error={fieldError('price')} />
            {optionValuePreview != null && optionValuePreview > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                Wartość: <strong>{formatNumber(optionValuePreview)}</strong> {optCurrency}
              </p>
            )}
          </div>

          <div>
            <label className="text-xs text-muted-foreground">
              Prowizja
              {effectivePayment && (
                <span className="ml-1 opacity-60">({effectivePayment})</span>
              )}{' '}
              {!commissionTouched && <span className="text-[10px] opacity-60">(auto)</span>}
            </label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={commission}
              onChange={(e) => {
                setCommission(e.target.value);
                setCommissionTouched(true);
              }}
              placeholder="0"
            />
          </div>
          {!isOption && (
            <div>
              <label className="text-xs text-muted-foreground">
                Waluta zakupu
                {effectiveQuote && (
                  <span className="text-[10px] ml-1 opacity-60">(notowanie: {effectiveQuote})</span>
                )}
              </label>
              <Select value={paymentCurrency} onValueChange={setPaymentCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c === 'auto' ? 'Auto (= waluta notowania)' : c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {showFxRate && (
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground">
                Kurs przeliczenia {effectiveQuote}/{effectivePayment} *
                <span className="text-[10px] ml-1 opacity-60">
                  (live: {getLiveFxRate(effectiveQuote, effectivePayment) || '—'} — nadpisz kursem z
                  broker'a jeśli różny)
                </span>
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
                placeholder={getLiveFxRate(effectiveQuote, effectivePayment) || '0.0000'}
                aria-invalid={!!fieldError('fxRate')}
              />
              <FieldError error={fieldError('fxRate')} />
              {plnPreview && (
                <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                  Wartość w {effectivePayment}: <strong>{formatNumber(plnPreview)}</strong>
                </p>
              )}
            </div>
          )}
        </div>

        {spinOffWarning && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <div className="flex gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <p>{spinOffWarning.message}</p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={spinOffWarning ? () => setSpinOffWarning(null) : onClose}
            disabled={createMut.isPending}
          >
            Anuluj
          </Button>
          {spinOffWarning ? (
            <Button
              variant="destructive"
              onClick={() => {
                setSpinOffWarning(null);
                createMut.mutate({ confirmSpinOff: true });
              }}
              disabled={createMut.isPending}
            >
              {createMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Dodaj mimo to
            </Button>
          ) : (
            <Button
              onClick={submitGuard(() => createMut.mutate(undefined))}
              disabled={createMut.isPending}
            >
              {createMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Dodaj
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
