import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { QueryErrorState } from '../query-error-state';
import { EmptyState } from '../loading-spinner';

describe('QueryErrorState', () => {
  it('tłumaczy błąd sieci i woła ponowienie', () => {
    const onRetry = vi.fn();
    render(
      <QueryErrorState
        title="Nie udało się wczytać pozycji"
        error={new TypeError('Failed to fetch')}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Nie udało się wczytać pozycji')).toBeTruthy();
    expect(screen.getByText('Brak połączenia z serwerem — sprawdź internet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Spróbuj ponownie/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('blokuje przycisk w trakcie ponownej próby', () => {
    render(<QueryErrorState error={new Error('x')} onRetry={() => {}} retrying />);
    expect(screen.getByRole('button', { name: /Spróbuj ponownie/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  /**
   * Wzorzec stron: błąd bez danych → stan błędu, NIE pusty stan. Regresja,
   * której pilnujemy: nieudane żądanie kończyło się tekstem „Zaimportuj…”.
   */
  it('nieudane zapytanie nie wpada w pusty stan, a ponowienie ładuje dane', async () => {
    const queryFn = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(['PKN']);

    function Page() {
      const { data, isLoading, isError, error, refetch } = useQuery({
        queryKey: ['probe'],
        queryFn,
        retry: false,
      });
      if (isLoading) return <p>ładowanie</p>;
      if (isError && !data) return <QueryErrorState error={error} onRetry={() => refetch()} />;
      return data?.length ? <p>{data.join(',')}</p> : <EmptyState message="Brak pozycji" />;
    }

    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText('Brak pozycji')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Spróbuj ponownie/ }));
    await waitFor(() => expect(screen.getByText('PKN')).toBeTruthy());
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
