import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MetricsBar } from '../MetricsBar';
import { HeroKPI } from '../HeroKPI';

/**
 * Pasek i hero pokazują wynik OD POCZĄTKU, a kafle pod wykresem — dla wybranego
 * okresu. Bez etykiety okresu dwie różne liczby o tej samej nazwie wyglądały na
 * sprzeczność; test pilnuje, że dopisek nie zniknie przy przebudowie paska.
 */
const metrics = {
  currentValue: 69026.56,
  totalInvested: 42372.4,
  totalReturn: 26654.16,
  totalReturnPct: 62.9,
  xirr: 18.89,
  baseCurrency: 'PLN',
  fxImpact: null,
  leverage: null,
};

vi.mock('@/lib/use-metrics-query', () => ({
  useMetricsQuery: () => ({ data: metrics }),
}));
vi.mock('@/lib/use-positions-query', () => ({
  usePositionsQuery: () => ({ data: undefined }),
}));

describe('etykiety okresu przy metrykach', () => {
  it('pasek opisuje Zysk jako „od początku”, a XIRR jako roczny', () => {
    render(
      <MemoryRouter initialEntries={['/app/portfolio']}>
        <MetricsBar />
      </MemoryRouter>,
    );
    expect(screen.getByText('Zysk · od początku')).toBeTruthy();
    expect(screen.getByText('XIRR · rocznie')).toBeTruthy();
  });

  it('hero nie nazywa zysku od początku wynikiem „dziś”', () => {
    render(<HeroKPI />);
    expect(screen.queryByText(/dziś/i)).toBeNull();
    expect(screen.getByText('Wartość portfela')).toBeTruthy();
    expect(screen.getByText('od początku')).toBeTruthy();
  });
});
