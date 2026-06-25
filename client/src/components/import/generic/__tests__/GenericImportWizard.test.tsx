import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GenericImportWizard } from '../GenericImportWizard';
import { api } from '@/lib/api-client';

/**
 * Test okablowania gałęzi kreatora („prowadź wynikiem"): po analyze heurystyka
 * decyduje, czy pominąć pytania (complete → podgląd), dopytać o luki (near) czy
 * poprowadzić AI (incomplete). API jest zamockowane — sprawdzamy decyzje UI, nie
 * sieć. Logikę `scoreDraft`/`suggestRules` pokrywają testy generic-profile-builder.
 */

vi.mock('@/lib/api-client', () => ({
  api: {
    genericAnalyze: vi.fn(),
    genericPreviewDocuments: vi.fn(),
    genericCommitDocuments: vi.fn(),
    genericGenerateProfile: vi.fn(),
  },
}));

const mockedApi = api as unknown as {
  genericAnalyze: ReturnType<typeof vi.fn>;
  genericPreviewDocuments: ReturnType<typeof vi.fn>;
  genericCommitDocuments: ReturnType<typeof vi.fn>;
  genericGenerateProfile: ReturnType<typeof vi.fn>;
};

/** Wynik analyze dla CSV (pola płaskie) z podanymi nagłówkami i próbką. */
function csvAnalysis(headers: string[], sampleRows: string[][]) {
  return {
    known: false,
    format: 'csv' as const,
    fingerprint: 'fp-test',
    delimiter: ';',
    headerRowIndex: 0,
    headers,
    sampleRows,
    profile: undefined,
    suggestions: undefined,
  };
}

function renderWizard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GenericImportWizard
        files={[new File(['x'], 'broker.csv', { type: 'text/csv' })]}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('GenericImportWizard — gałęzie progresywnego mapowania', () => {
  beforeEach(() => {
    mockedApi.genericAnalyze.mockReset();
    mockedApi.genericPreviewDocuments.mockReset();
    mockedApi.genericCommitDocuments.mockReset();
    mockedApi.genericGenerateProfile.mockReset();
  });

  it('pełne transakcje (complete) → bez pytań prosto do podglądu', async () => {
    mockedApi.genericAnalyze.mockResolvedValue(
      csvAnalysis(
        ['Data', 'Papier', 'ISIN', 'K/S', 'Ilość', 'Cena', 'Waluta'],
        [
          ['2025-03-15', 'CD PROJEKT', 'PLOPTTC00011', 'K', '10', '100,00', 'PLN'],
          ['2025-04-10', 'KGHM', 'PLKGHM000017', 'S', '5', '150,00', 'PLN'],
        ],
      ),
    );
    mockedApi.genericPreviewDocuments.mockResolvedValue({
      ok: true,
      transactions: {
        total: 2,
        sample: [
          {
            date: '2025-03-15',
            paperName: 'CD PROJEKT',
            side: 'K',
            quantity: 10,
            price: 100,
            value: 1000,
            currency: 'PLN',
          },
          {
            date: '2025-04-10',
            paperName: 'KGHM',
            side: 'S',
            quantity: 5,
            price: 150,
            value: 750,
            currency: 'PLN',
          },
        ],
        skipped: [],
      },
      operations: { total: 0, sample: [], skipped: [] },
    });

    renderWizard();

    // Doszliśmy do podglądu (zakładka transakcji) bez żadnej interakcji…
    expect(await screen.findByText(/Transakcje \(2\)/)).toBeInTheDocument();
    expect(mockedApi.genericPreviewDocuments).toHaveBeenCalledTimes(1);
    // …i bez karty „uzupełnij brakujące pola".
    expect(screen.queryByText(/Prawie gotowe/)).not.toBeInTheDocument();
  });

  it('brak kolumny strony (near) → karta luk, AI schowane za linkiem', async () => {
    mockedApi.genericAnalyze.mockResolvedValue(
      csvAnalysis(
        ['Data', 'Papier', 'Ilość', 'Cena', 'Waluta'],
        [
          ['2025-03-15', 'CD PROJEKT', '10', '100,00', 'PLN'],
          ['2025-04-10', 'KGHM', '5', '150,00', 'PLN'],
        ],
      ),
    );

    renderWizard();

    expect(await screen.findByText(/Prawie gotowe/)).toBeInTheDocument();
    // Pyta tylko o stronę K/S; nie wyświetla pełnego formularza AI.
    expect(screen.getByText(/które wiersze to kupno/i)).toBeInTheDocument();
    expect(screen.queryByText('Automatyczne mapowanie (AI)')).not.toBeInTheDocument();
    expect(screen.getByText(/Złożony format\?/)).toBeInTheDocument();
    // Bez auto-rozwiązania nie wołamy podglądu, dopóki user nie kliknie.
    expect(mockedApi.genericPreviewDocuments).not.toHaveBeenCalled();
  });

  it('plik operacji (incomplete) → prowadzi AI, edytor reguł zasiany', async () => {
    mockedApi.genericAnalyze.mockResolvedValue(
      csvAnalysis(
        ['Data', 'Tytuł operacji', 'Kwota', 'Waluta'],
        [
          ['2025-01-10', 'Dywidenda KGHM', '12,50', 'PLN'],
          ['2025-02-01', 'Wpłata środków', '1000,00', 'PLN'],
        ],
      ),
    );

    renderWizard();

    expect(await screen.findByText(/Plik wygląda na operacje/)).toBeInTheDocument();
    // Boks AI prominentny + przełącznik pokazuje zasiane reguły.
    expect(screen.getByText('Automatyczne mapowanie (AI)')).toBeInTheDocument();
    expect(screen.getByText(/Edytuj reguły ręcznie/)).toBeInTheDocument();
  });
});
