import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error('Wybuchł widżet');
  return <p>treść strony</p>;
}

describe('ErrorBoundary', () => {
  // React loguje złapany błąd na console.error — w teście to oczekiwany szum.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it('inline: błąd strony nie zabiera powłoki', () => {
    render(
      <div>
        <nav>menu</nav>
        <ErrorBoundary variant="inline" resetKey="/app/portfolio">
          <Boom fail />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText('menu')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Nie udało się wyświetlić tej strony')).toBeTruthy();
    expect(screen.getByText('Wybuchł widżet')).toBeTruthy();
  });

  it('zmiana resetKey (inna zakładka) czyści błąd', () => {
    const { rerender } = render(
      <ErrorBoundary variant="inline" resetKey="/app/portfolio">
        <Boom fail />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    rerender(
      <ErrorBoundary variant="inline" resetKey="/app/dividends">
        <Boom fail={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('treść strony')).toBeTruthy();
  });

  it('ten sam resetKey nie resetuje — błąd nie znika sam przy ponownym renderze', () => {
    const { rerender } = render(
      <ErrorBoundary variant="inline" resetKey="/app/portfolio">
        <Boom fail />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary variant="inline" resetKey="/app/portfolio">
        <Boom fail={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('„Spróbuj ponownie” renderuje dzieci jeszcze raz', () => {
    let fail = true;
    function Flaky() {
      return <Boom fail={fail} />;
    }
    render(
      <ErrorBoundary variant="inline">
        <Flaky />
      </ErrorBoundary>,
    );
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    expect(screen.getByText('treść strony')).toBeTruthy();
  });

  it('silent: element pomocniczy znika bez komunikatu', () => {
    const { container } = render(
      <div>
        <ErrorBoundary variant="silent">
          <Boom fail />
        </ErrorBoundary>
        <p>reszta</p>
      </div>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('reszta')).toBeTruthy();
    expect(container.textContent).toBe('reszta');
  });

  it('domyślnie pełnoekranowy komunikat (ostatnia deska aplikacji)', () => {
    render(
      <ErrorBoundary>
        <Boom fail />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Wystąpił nieoczekiwany błąd')).toBeTruthy();
    expect(screen.getByRole('alert').className).toContain('min-h-screen');
  });
});
