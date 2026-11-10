import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MetricsBar } from '../MetricsBar';

/**
 * Pasek metryk ma być JEDNYM wierszem. Po dołożeniu dziennej zmiany zawijał się
 * do dwóch na typowym laptopie (1440 px), bo komplet metryk potrzebuje ~1400 px,
 * a obok sidebaru zostaje 1200. jsdom nie liczy układu, więc pilnujemy kontraktu
 * klas: brak zawijania, „Wpłaty” warunkowe, a ich liczba zawsze w objaśnieniu Zysku.
 */
const metrics = {
  currentValue: 223156.69,
  totalInvested: 132099,
  totalReturn: 91057.69,
  totalReturnPct: 68.93,
  xirr: 17.33,
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

function renderBar() {
  return render(
    <MemoryRouter initialEntries={['/app/portfolio']}>
      <MetricsBar />
    </MemoryRouter>,
  );
}

describe('pasek metryk w jednym wierszu', () => {
  it('nie zawija się na żadnej szerokości', () => {
    renderBar();
    const bar = screen.getByText('Wartość').parentElement!.parentElement!;
    const classes = bar.className.split(/\s+/);
    expect(classes).toContain('flex-nowrap');
    expect(classes).toContain('overflow-x-auto');
    expect(classes.some((c) => c.endsWith('flex-wrap'))).toBe(false);
  });

  it('„Wpłaty” są w pasku tylko warunkowo (szeroki kontener)', () => {
    renderBar();
    const slot = screen.getByText('Wpłaty').parentElement!;
    const classes = slot.className.split(/\s+/);
    expect(classes).toContain('hidden');
    expect(classes.some((c) => c.startsWith('@min-') && c.endsWith(':flex'))).toBe(true);
  });

  it('kwota wpłat jest zawsze osiągalna z objaśnienia przy Zysku', () => {
    renderBar();
    expect(screen.queryByText('Wpłaty netto')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zysk od początku — z czego wynika' }));
    expect(screen.getByText('Wpłaty netto')).toBeTruthy();
    // Ta sama kwota co w (ukrywanym) slocie paska: raz w pasku, raz w objaśnieniu.
    expect(screen.getAllByText(/132\s?099,00/)).toHaveLength(2);
  });
});
