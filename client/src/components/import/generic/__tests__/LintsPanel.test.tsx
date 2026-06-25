import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProfileLint } from 'shared';
import { LintsPanel } from '../LintsPanel';

describe('LintsPanel', () => {
  it('nic nie renderuje bez lintów', () => {
    const { container } = render(<LintsPanel lints={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('pokazuje ostrzeżenie i nagłówek „Do sprawdzenia"', () => {
    const lints: ProfileLint[] = [
      {
        code: 'payment-currency-assumed',
        severity: 'warning',
        message: 'Waluta rozliczenia przyjęta z instrumentu.',
      },
    ];
    render(<LintsPanel lints={lints} />);
    expect(screen.getByText(/Do sprawdzenia przed zatwierdzeniem/)).toBeInTheDocument();
    expect(screen.getByText(/Waluta rozliczenia przyjęta/)).toBeInTheDocument();
  });

  it('przy samych info pokazuje „Uwagi do profilu"', () => {
    const lints: ProfileLint[] = [
      { code: 'needs-name-resolution', severity: 'info', message: 'Brak ISIN — rozpoznanie po nazwie.' },
    ];
    render(<LintsPanel lints={lints} />);
    expect(screen.getByText('Uwagi do profilu')).toBeInTheDocument();
  });

  it('dokleja etykietę arkusza', () => {
    const lints: ProfileLint[] = [
      { code: 'ticker-via-regex', severity: 'warning', message: 'Ticker z regexa.', sheet: 'Dywidendy' },
    ];
    render(<LintsPanel lints={lints} />);
    expect(screen.getByText(/\[Dywidendy\]/)).toBeInTheDocument();
  });
});
