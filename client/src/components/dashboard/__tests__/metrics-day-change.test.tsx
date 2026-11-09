import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PortfolioDayChange } from 'shared';
import { MetricsBar } from '../MetricsBar';
import { HeroKPI } from '../HeroKPI';

const metrics = {
  currentValue: 200000,
  totalInvested: 150000,
  totalReturn: 50000,
  totalReturnPct: 33.33,
  xirr: 12,
  baseCurrency: 'PLN',
  fxImpact: null,
  leverage: null,
};

const positionsMock = vi.fn();

vi.mock('@/lib/use-metrics-query', () => ({
  useMetricsQuery: () => ({ data: metrics }),
}));
vi.mock('@/lib/use-positions-query', () => ({
  usePositionsQuery: () => ({ data: positionsMock() }),
}));

const dayChange = (over: Partial<PortfolioDayChange> = {}): PortfolioDayChange => ({
  change: 1234.56,
  changePct: 0.62,
  currency: 'PLN',
  coveredCount: 14,
  totalCount: 14,
  missingTickers: [],
  fxIncluded: false,
  hasForeignPositions: false,
  ...over,
});

function renderBar(path = '/app/portfolio') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MetricsBar />
    </MemoryRouter>,
  );
}

describe('dzienna zmiana w pasku metryk', () => {
  beforeEach(() => positionsMock.mockReset());

  it('pokazuje kwotę ze znakiem i procent', () => {
    positionsMock.mockReturnValue({ dayChange: dayChange() });
    renderBar();
    expect(screen.getByText(/\+1\s?234,56/)).toBeTruthy();
    expect(screen.getByText(/\(\+0[.,]62%\)/)).toBeTruthy();
  });

  it('niepełne pokrycie ma jawny dopisek', () => {
    positionsMock.mockReturnValue({
      dayChange: dayChange({ coveredCount: 12, missingTickers: ['NCX', 'OPT'] }),
    });
    renderBar();
    expect(screen.getByText('· bez danych: 2 z 14')).toBeTruthy();
  });

  it('zerowe pokrycie: „brak danych”, nie zero', () => {
    positionsMock.mockReturnValue({
      dayChange: dayChange({ change: null, changePct: null, coveredCount: 0 }),
    });
    renderBar();
    expect(screen.getByText('brak danych')).toBeTruthy();
    // Zero udające wynik („0,00 zł”) byłoby tu kłamstwem — slot nie ma kwoty wcale.
    expect(screen.queryByText(/^\+?0,00/)).toBeNull();
  });

  it('bez kontraktu (portfel bez pozycji) slot się nie renderuje', () => {
    positionsMock.mockReturnValue({ dayChange: null });
    renderBar();
    expect(screen.queryByText('Dziś')).toBeNull();
    expect(screen.getByText('Wartość')).toBeTruthy();
  });

  it('na telefonie pasek chowa się tylko na dashboardzie (tam jest HeroKPI)', () => {
    positionsMock.mockReturnValue({ dayChange: dayChange() });
    const dash = renderBar('/app');
    expect(dash.container.firstElementChild?.className).toContain('hidden md:flex');
    dash.unmount();
    const other = renderBar('/app/dividends');
    expect(other.container.firstElementChild?.className).not.toContain('hidden');
  });
});

describe('dzienna zmiana w HeroKPI', () => {
  beforeEach(() => positionsMock.mockReset());

  it('pokazuje wynik dnia nad zyskiem od początku', () => {
    positionsMock.mockReturnValue({ dayChange: dayChange({ change: -500, changePct: -0.25 }) });
    render(<HeroKPI />);
    expect(screen.getByText('Dziś')).toBeTruthy();
    expect(screen.getByText(/-500,00/)).toBeTruthy();
    expect(screen.getByText('od początku')).toBeTruthy();
  });
});
