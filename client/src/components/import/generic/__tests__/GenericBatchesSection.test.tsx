import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GenericBatchesSection } from '../GenericBatchesSection';
import { api } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  api: {
    genericBatches: vi.fn(),
    genericReimport: vi.fn(),
  },
}));

const mockedApi = api as unknown as {
  genericBatches: ReturnType<typeof vi.fn>;
  genericReimport: ReturnType<typeof vi.fn>;
};

const BATCHES = [
  {
    importBatch: 'b-flagged',
    fileName: 'broker-x.csv',
    profileId: 'p1',
    profileVersion: 1,
    brokerLabel: 'Broker X',
    sheet: null,
    needsReimport: true,
    importedAt: '2026-06-01 10:00:00',
  },
  {
    importBatch: 'b-ok',
    fileName: 'broker-y.csv',
    profileId: 'p2',
    profileVersion: 2,
    brokerLabel: 'Broker Y',
    sheet: null,
    needsReimport: false,
    importedAt: '2026-06-02 10:00:00',
  },
];

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GenericBatchesSection />
    </QueryClientProvider>,
  );
}

describe('GenericBatchesSection', () => {
  beforeEach(() => {
    mockedApi.genericBatches.mockReset();
    mockedApi.genericReimport.mockReset();
  });

  it('zflagowany batch → baner + „Wgraj plik ponownie"; niezflagowany → „aktualny"', async () => {
    mockedApi.genericBatches.mockResolvedValue({ batches: BATCHES });
    renderSection();

    expect(await screen.findByText(/Administrator poprawił mapowanie/i)).toBeInTheDocument();
    expect(screen.getByText('Wgraj plik ponownie')).toBeInTheDocument();
    expect(screen.getByText('aktualny')).toBeInTheDocument();
  });

  it('wgranie ZŁEGO pliku → błąd inline (uploadFile zwraca success:false)', async () => {
    mockedApi.genericBatches.mockResolvedValue({ batches: BATCHES });
    mockedApi.genericReimport.mockResolvedValue({
      success: false,
      error: 'Wgrany plik nie pasuje do tego importu (inny układ kolumn).',
      errors: ['Wgrany plik nie pasuje do tego importu (inny układ kolumn).'],
      importBatch: 'b-flagged',
      transactionsImported: 0,
      operationsImported: 0,
    });
    const { container } = renderSection();

    await screen.findByText('Wgraj plik ponownie');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'wrong.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/nie pasuje do tego importu/i)).toBeInTheDocument();
    expect(mockedApi.genericReimport).toHaveBeenCalledWith('b-flagged', file);
  });
});
