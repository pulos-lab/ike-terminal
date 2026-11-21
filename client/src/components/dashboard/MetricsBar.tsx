import { useMetricsQuery } from '@/lib/use-metrics-query';
import { plColor } from '@/components/ui/pl-badge';
import { formatCurrency, formatNumber, formatPercent, formatPLN } from '@/lib/formatters';
import { InfoPopover } from '@/components/ui/info-popover';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Target,
  ArrowLeftRight,
  Gauge,
  CalendarDays,
} from 'lucide-react';
import { useMatch } from 'react-router-dom';
import type { FxImpact, LeverageInfo, PortfolioPositionsResponse } from 'shared';
import { usePositionsQuery } from '@/lib/use-positions-query';
import { describeDayChange, quoteFreshnessText, type DayChangeView } from '@/lib/day-change';
import { cn } from '@/lib/utils';

/**
 * Progi układu paska, liczone od szerokości SAMEGO paska (zapytania kontenerowe),
 * bo ile miejsca zostaje, zależy od sidebaru, a nie od okna.
 *
 * Od najszerszego: komplet z „Wpłatami” → bez „Wpłat” → bez ikon czysto ozdobnych
 * (etykieta obok mówi to samo; ikona dźwigni zostaje zawsze — jej kolor niesie
 * ostrzeżenie) → ciaśniejsze odstępy i krój o 1 px mniejszy. Progi wynikają
 * z pomiaru na portfelu ~220 tys. zł: bez „Wpłat” i ikon wiersz zajmuje ~1020 px,
 * z ikonami ~1130 px, z „Wpłatami” ~1360 px; zapas jest na dłuższe kwoty.
 * Znaczek dźwigni dokłada ~160 px, więc portfel z dźwignią ma progi o tyle wyżej.
 */
const LAYOUT = {
  base: {
    row: 'gap-x-4 text-[13px] @min-[1040px]:gap-x-5 @min-[1040px]:text-sm @min-[1180px]:gap-x-6 @min-[1420px]:gap-x-8',
    decorIcon: 'h-3.5 w-3.5 hidden @min-[1180px]:block',
    deposits: 'hidden @min-[1420px]:flex',
  },
  withLeverage: {
    row: 'gap-x-4 text-[13px] @min-[1200px]:gap-x-5 @min-[1200px]:text-sm @min-[1340px]:gap-x-6 @min-[1580px]:gap-x-8',
    decorIcon: 'h-3.5 w-3.5 hidden @min-[1340px]:block',
    deposits: 'hidden @min-[1580px]:flex',
  },
} as const;

export function MetricsBar() {
  const { data, isError } = useMetricsQuery();
  // Dzienna zmiana idzie z widoku pozycji (jedno źródło liczby dla Portfela,
  // paska i dashboardu) — to samo zapytanie co strona Portfel, bez duplikatu.
  const { data: positions } = usePositionsQuery();
  // Na telefonie pasek jest jednym przewijanym wierszem. Na samym dashboardzie
  // chowamy go poniżej `md`, bo te same liczby pokazuje tam HeroKPI.
  const onDashboard = useMatch({ path: '/app', end: true }) !== null;
  const barVisibility = onDashboard ? 'hidden md:flex' : 'flex';

  // Błąd bez danych: pasek znika zamiast pulsować szkieletem w nieskończoność —
  // komunikat i ponowienie pokazuje strona pod spodem, tu nie ma czego dublować.
  if (!data && isError) return null;

  if (!data)
    return (
      <div className={cn(barVisibility, 'border-b px-4 md:px-6 py-3 gap-6 text-sm animate-pulse')}>
        <div className="h-4 w-32 bg-muted rounded" />
        <div className="h-4 w-32 bg-muted rounded" />
        <div className="h-4 w-24 bg-muted rounded" />
      </div>
    );

  // Badge dźwigni tylko przy realnej dźwigni — próg 1.01× odcina drobne ujemne
  // rezydua gotówkowe (literówki cen itp.) na kontach bez marginu.
  const showLeverage = !!data.leverage && data.leverage.ratio >= 1.01;
  const layout = showLeverage ? LAYOUT.withLeverage : LAYOUT.base;

  // Waluta portfela — PLN dla polskich/mixed, USD/EUR dla XTB single-currency.
  const ccy: string = data.baseCurrency || 'PLN';
  const fmt = (v: number) => formatCurrency(v, ccy);

  return (
    // Zewnętrzny element jest kontenerem zapytań, wiersz metryk — jego dzieckiem:
    // element nie może odpytywać sam siebie, a odstępy i krój też zależą od progów.
    <div className={cn(barVisibility, '@container border-b px-4 md:px-6')}>
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center py-3',
          // Pasek to ZAWSZE jeden wiersz — zawinięty do dwóch zabierał wysokość każdej
          // stronie. Co ustępuje miejsca i kiedy: patrz LAYOUT. Gdy mimo to brakuje
          // szerokości (telefon, tablet, wąskie okno), wiersz przewija się w poziomie.
          layout.row,
          'flex-nowrap overflow-x-auto whitespace-nowrap [&>*]:shrink-0',
          '[&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]',
        )}
      >
        <div className="flex items-center gap-2">
          <DollarSign className={cn(layout.decorIcon, 'text-muted-foreground')} />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Wartość
          </span>
          <span className="font-semibold tabular-nums">{fmt(data.currentValue)}</span>
        </div>
        <DayChangeSlot
          view={describeDayChange(positions?.dayChange, positions?.quotes, new Date())}
          quotes={positions?.quotes}
          iconClassName={layout.decorIcon}
        />
        {showLeverage && data.leverage && (
          <InfoPopover
            label="Dźwignia — szczegóły"
            triggerClassName="flex items-center gap-2"
            trigger={
              <>
                <Gauge
                  className={`h-3.5 w-3.5 ${data.leverage.ratio >= 2 ? 'text-loss' : 'text-amber-600 dark:text-amber-500'}`}
                />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Dźwignia
                </span>
                <span
                  className={`font-semibold tabular-nums ${data.leverage.ratio >= 2 ? 'text-loss' : 'text-amber-600 dark:text-amber-500'}`}
                >
                  {formatNumber(data.leverage.ratio, 2)}×
                </span>
              </>
            }
          >
            <LeverageTooltipBody leverage={data.leverage} />
          </InfoPopover>
        )}
        {/* Najniższy priorytet w pasku: widoczne tylko, gdy starcza miejsca na komplet. */}
        <div className={cn(layout.deposits, 'items-center gap-2')}>
          <Target className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Wpłaty
          </span>
          <span className="font-medium tabular-nums">{fmt(data.totalInvested)}</span>
        </div>
        <InfoPopover
          label="Zysk od początku — z czego wynika"
          triggerClassName="flex items-center gap-2"
          trigger={
            <>
              {data.totalReturn >= 0 ? (
                <TrendingUp className={cn(layout.decorIcon, 'text-gain')} />
              ) : (
                <TrendingDown className={cn(layout.decorIcon, 'text-loss')} />
              )}
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Zysk · od początku
              </span>
              <span className={`font-semibold tabular-nums ${plColor(data.totalReturn)}`}>
                {fmt(data.totalReturn)} ({formatPercent(data.totalReturnPct)})
              </span>
            </>
          }
        >
          <ReturnTooltipBody
            currentValue={fmt(data.currentValue)}
            invested={fmt(data.totalInvested)}
            totalReturn={fmt(data.totalReturn)}
            totalReturnPct={formatPercent(data.totalReturnPct)}
          />
        </InfoPopover>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            XIRR · rocznie
          </span>
          <span className={`font-semibold tabular-nums ${plColor(data.xirr)}`}>
            {formatPercent(data.xirr)}
          </span>
        </div>
        {data.fxImpact && (
          <InfoPopover
            label="Wpływ walut — szczegóły"
            triggerClassName="flex items-center gap-2"
            trigger={
              <>
                <ArrowLeftRight className={cn(layout.decorIcon, 'text-muted-foreground')} />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Wpływ walut
                </span>
                <span
                  className={`font-semibold tabular-nums ${plColor(data.fxImpact.fxImpactPct)}`}
                >
                  {formatPercent(data.fxImpact.fxImpactPct)}
                </span>
              </>
            }
          >
            <FxImpactTooltipBody fxImpact={data.fxImpact} />
          </InfoPopover>
        )}
      </div>
    </div>
  );
}

/**
 * „Dziś +1 234,56 zł (+0,62%)” — z dopiskiem pokrycia, gdy część pozycji nie
 * ma danych. Przy zerowym pokryciu pokazujemy „brak danych”, nigdy 0.
 */
function DayChangeSlot({
  view,
  quotes,
  iconClassName,
}: {
  view: DayChangeView | null;
  quotes: PortfolioPositionsResponse['quotes'];
  iconClassName: string;
}) {
  if (!view) return null;
  return (
    <InfoPopover
      label={`${view.label} — jak liczona jest zmiana`}
      triggerClassName="flex items-center gap-2"
      trigger={
        <>
          <CalendarDays className={cn(iconClassName, 'text-muted-foreground')} />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {view.label}
          </span>
          {view.amount !== null ? (
            <span className={`font-semibold tabular-nums ${plColor(view.amount)}`}>
              {view.amount > 0 ? '+' : ''}
              {formatCurrency(view.amount, view.currency)}
              {view.pct !== null && ` (${formatPercent(view.pct)})`}
            </span>
          ) : (
            <span className="text-muted-foreground">brak danych</span>
          )}
          {view.coverageNote && view.amount !== null && (
            <span className="text-[10px] text-muted-foreground">· {view.coverageNote}</span>
          )}
        </>
      }
    >
      <div className="text-xs space-y-1.5">
        <p className="font-semibold">
          {view.label === 'Dziś'
            ? 'Zmiana wartości pozycji od poprzedniego zamknięcia'
            : 'Zmiana wartości pozycji na ostatniej sesji'}
        </p>
        <p className="text-muted-foreground">
          Pozycje kupione w dniu sesji liczone są od ceny zakupu. Sprzedane tego dnia nie wchodzą do
          wyniku{view.fxNote ? `; liczba jest ${view.fxNote}` : ''}.
        </p>
        {view.coverageNote && (
          <p className="text-muted-foreground">
            Bez danych o zmianie dziennej ({view.coverageNote.replace('bez danych: ', '')}):{' '}
            {view.missingTickers.join(', ')}
            {view.missingTickers.length > 0 ? '.' : ''} Ich ruch nie jest w tej liczbie.
          </p>
        )}
        {quotes && (
          <p className="text-muted-foreground text-[10px] pt-1 border-t border-border">
            {quoteFreshnessText(quotes, new Date())}
          </p>
        )}
      </div>
    </InfoPopover>
  );
}

/**
 * Rozbicie zysku od początku. Trzyma „Wpłaty” zawsze pod ręką — w samym pasku
 * widać je tylko na bardzo szerokim ekranie.
 */
function ReturnTooltipBody({
  currentValue,
  invested,
  totalReturn,
  totalReturnPct,
}: {
  currentValue: string;
  invested: string;
  totalReturn: string;
  totalReturnPct: string;
}) {
  return (
    <div className="text-xs space-y-1.5">
      <p className="font-semibold">Zysk od początku = wartość portfela − wpłaty netto</p>
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">Wartość portfela</dt>
        <dd className="text-right">{currentValue}</dd>
        <dt className="text-muted-foreground">Wpłaty netto</dt>
        <dd className="text-right">{invested}</dd>
        <dt className="text-muted-foreground">Zysk</dt>
        <dd className="text-right font-semibold">
          {totalReturn} ({totalReturnPct})
        </dd>
      </dl>
      <p className="text-muted-foreground text-[10px] pt-1 border-t border-border">
        Wpłaty netto to wpłaty pomniejszone o wypłaty. Procent liczony względem wpłat netto.
      </p>
    </div>
  );
}

function LeverageTooltipBody({ leverage }: { leverage: LeverageInfo }) {
  return (
    <div className="text-xs space-y-2">
      <p className="font-semibold">
        Dźwignia {formatNumber(leverage.ratio, 2)}× — pozycje brutto / kapitał własny
      </p>
      <ul className="space-y-0.5 text-muted-foreground">
        <li>• Pozycje brutto (long + |short|): {formatPLN(leverage.grossExposurePln)}</li>
        {leverage.shortExposurePln > 0 && (
          <li className="pl-2">w tym krótkie: {formatPLN(leverage.shortExposurePln)}</li>
        )}
        <li>• Kapitał własny (pozycje netto + gotówka): {formatPLN(leverage.equityPln)}</li>
        {leverage.marginDebtPln > 0 && (
          <li>• Kredyt margin (ujemna gotówka): {formatPLN(leverage.marginDebtPln)}</li>
        )}
      </ul>
      <p className="text-muted-foreground text-[10px] pt-1 border-t border-border">
        Wskaźnik liczony z historii transakcji. Nie uwzględnia wymogów depozytowych brokera (buying
        power / odległość od margin call).
      </p>
    </div>
  );
}

function FxImpactTooltipBody({ fxImpact }: { fxImpact: FxImpact }) {
  const positive = fxImpact.fxImpactPct >= 0;
  const absPctPortfolio = Math.abs(fxImpact.fxImpactPct);
  const absPln = Math.abs(fxImpact.fxImpactPln);

  const interpretation = positive
    ? `Od czasu wpłat i wymian walut PLN osłabł w stosunku do walut obcych w portfelu. Gdybyś dziś sprzedał cały portfel i przewalutował na PLN, dostałbyś ~${formatPLN(absPln)} więcej (+${absPctPortfolio.toFixed(2)}% wartości portfela) niż przy średnich kursach zakupu.`
    : `Od czasu wpłat i wymian walut PLN wzmocnił się w stosunku do walut obcych w portfelu. Gdybyś dziś sprzedał cały portfel i przewalutował na PLN, dostałbyś ~${formatPLN(absPln)} mniej (−${absPctPortfolio.toFixed(2)}% wartości portfela) niż przy średnich kursach zakupu.`;

  return (
    <div className="text-xs space-y-2">
      <p className="font-semibold">
        Wpływ walut na portfel: {formatPercent(fxImpact.fxImpactPct)} (
        {formatPLN(fxImpact.fxImpactPln)})
      </p>
      <p>{interpretation}</p>

      <div className="pt-1 border-t border-border">
        <p className="font-medium mb-1">Kontekst:</p>
        <ul className="space-y-0.5 text-muted-foreground">
          <li>• Wartość portfela: {formatPLN(fxImpact.totalPortfolioValuePln)}</li>
          <li>
            • Część zagraniczna: {formatPLN(fxImpact.foreignExposurePln)} (
            {fxImpact.foreignExposurePctOfPortfolio.toFixed(1)}% portfela)
          </li>
          <li>
            • Zmiana kursów ważona: {formatPercent(fxImpact.fxImpactPctOfForeign)} (impact na część
            walutową)
          </li>
          {Math.abs(fxImpact.fxRealizedPln) >= 0.01 && (
            <li>
              • Zrealizowany wynik walutowy:{' '}
              <span className={plColor(fxImpact.fxRealizedPln)}>
                {formatPLN(fxImpact.fxRealizedPln)}
              </span>{' '}
              (z wymian, wypłat i sprzedaży — poza główną metryką)
            </li>
          )}
        </ul>
      </div>

      <div className="pt-1 border-t border-border">
        <p className="font-medium mb-1">Per waluta:</p>
        <ul className="space-y-1.5">
          {fxImpact.breakdown.map((e) => (
            <li key={e.currency} className="text-muted-foreground">
              {/* Treść podpowiedzi ma odwrócone kolory (bg-foreground text-background) —
                  wyróżnienie w środku to text-background; text-foreground znika w tle. */}
              <div className="font-medium text-background">
                {e.currency}:{' '}
                {e.avgPlnPerCurrency !== null
                  ? `${formatPercent(e.impactPct)} kursu (${formatPLN(e.impactPln)})`
                  : 'wpływ kursu nieznany'}
              </div>
              <div className="text-[10px] pl-2">
                • Ekspozycja: {e.exposureNative.toFixed(2)} {e.currency} ({formatPLN(e.exposurePln)}
                , {e.exposurePctOfPortfolio.toFixed(1)}% portfela)
              </div>
              {e.avgPlnPerCurrency !== null ? (
                <div className="text-[10px] pl-2">
                  • Średni kurs nabycia (bieżące saldo): {e.avgPlnPerCurrency.toFixed(3)} → dziś:{' '}
                  {e.todayPlnPerCurrency.toFixed(3)}
                </div>
              ) : (
                <div className="text-[10px] pl-2 italic text-muted-foreground/70">
                  • Brak danych o kursie wejścia (broker rozliczał wewnętrznie)
                </div>
              )}
              {Math.abs(e.realizedPln) >= 0.01 && (
                <div className="text-[10px] pl-2">
                  • Zrealizowane:{' '}
                  <span className={plColor(e.realizedPln)}>{formatPLN(e.realizedPln)}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <p className="text-muted-foreground text-[10px] pt-1 border-t border-border">
        Średni kurs liczony księgą walutową (średnia krocząca) z pełnej historii przepływów:
        wymiany, wpłaty/wypłaty, dywidendy i transakcje przewalutowane przez brokera. Rozchody
        zdejmują saldo po bieżącej średniej — waluta wymieniona z powrotem nie zniekształca kursu
        obecnych zasobów, a jej wynik trafia do pozycji „zrealizowane". Metryka nie uwzględnia
        zwrotu z rynku.
      </p>
    </div>
  );
}
