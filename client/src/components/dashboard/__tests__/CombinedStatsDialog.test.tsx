import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PortfolioHistoryPoint } from 'shared';
import { CombinedStatsDialog } from '../CombinedStatsDialog';

/** Historia portfela łączonego — dwa punkty wystarczą, żeby PerformanceStats policzył kafle. */
function history(): PortfolioHistoryPoint[] {
  const base = {
    benchmarkValue: 0,
    benchmarkReturnPct: 0,
    benchmarkTwrPct: 0,
    cumulativeWithdrawalsPln: 0,
  };
  return [
    {
      date: '2025-01-01',
      portfolioValue: 15000,
      returnPct: 0,
      twrPct: 0,
      investedCumulative: 15000,
      cumulativeDepositsPln: 15000,
      ...base,
    },
    {
      date: '2025-01-02',
      portfolioValue: 16500,
      returnPct: 10,
      twrPct: 10,
      investedCumulative: 15000,
      cumulativeDepositsPln: 15000,
      ...base,
    },
  ];
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof CombinedStatsDialog>> = {}) {
  return render(
    <CombinedStatsDialog
      data={history()}
      memberNames={['IKE', 'IKZE']}
      excludedNames={[]}
      rangeLabel="ALL"
      benchmarkLabel="S&P 500"
      showBenchmark
      riskFreeRatePct={5}
      color="#7c50b8"
      mixedCurrency={false}
      {...overrides}
    />,
  );
}

describe('CombinedStatsDialog', () => {
  it('otwiera okno i pokazuje sumy oraz składniki portfela łączonego', async () => {
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /statystyki łączone/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Portfel łączony');
    expect(dialog).toHaveTextContent('IKE');
    expect(dialog).toHaveTextContent('IKZE');
    expect(dialog).toHaveTextContent('Wartość dziś');
    expect(dialog).toHaveTextContent('Wpłaty łącznie');
    // Siatka metryk to reużyty PerformanceStats w trybie jednoportfelowym.
    expect(dialog).toHaveTextContent('Sharpe Ratio');
    expect(dialog).toHaveTextContent('Max Drawdown');
  });

  it('ostrzega o portfelach, które wypadły z sumy', async () => {
    renderDialog({ excludedNames: ['Maklerski'] });

    fireEvent.click(screen.getByRole('button', { name: /statystyki łączone/i }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Maklerski');
  });

  it('sygnalizuje przewalutowanie, gdy składniki mają różne waluty bazowe', async () => {
    renderDialog({ mixedCurrency: true });

    fireEvent.click(screen.getByRole('button', { name: /statystyki łączone/i }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/przeliczono na PLN/i);
  });

  it('pusty zakres nie wybucha — pokazuje komunikat zamiast kafli', async () => {
    renderDialog({ data: [] });

    fireEvent.click(screen.getByRole('button', { name: /statystyki łączone/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Brak danych w wybranym zakresie dat.');
    expect(dialog).not.toHaveTextContent('Sharpe Ratio');
  });
});
