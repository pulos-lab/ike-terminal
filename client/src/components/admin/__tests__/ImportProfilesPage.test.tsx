import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportProfilesPage } from '../ImportProfilesPage';
import { api } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  api: {
    adminListImportProfiles: vi.fn(),
    adminGetImportProfile: vi.fn(),
    adminUpdateImportProfile: vi.fn(),
    adminApproveImportProfile: vi.fn(),
    adminRejectImportProfile: vi.fn(),
  },
}));

const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const HEADERS = [
  'Action',
  'Time',
  'ISIN',
  'Ticker',
  'Name',
  'No. of shares',
  'Price / share',
  'Currency',
  'Total',
];
const SAMPLE = [
  [
    'Market buy',
    '2023-12-18',
    'US17275R1023',
    'CSCO',
    'Cisco',
    '0.3069000000',
    '49.96',
    'USD',
    '15.33',
  ],
  ['Dividend (Dividend)', '2023-12-27', 'US56035L1044', 'MAIN', 'Main', '0.5', '', 'USD', '0.23'],
  ['Card debit', '2023-12-30', '', '', '', '', '', '', '12.00'],
];

const PROFILE_JSON = {
  specVersion: 1,
  brokerLabel: 'Trading 212',
  file: { delimiter: ',', headerRow: { strategy: 'first' } },
  classify: [
    {
      id: 'buy',
      when: [{ col: { name: 'Action' }, op: 'equals', values: ['Market buy'] }],
      emit: 'trade',
    },
    {
      id: 'div',
      when: [{ col: { name: 'Action' }, op: 'startsWith', values: ['Dividend'] }],
      emit: 'dividend',
    },
  ],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
    paperName: { kind: 'column', col: { name: 'Name' } },
    quantity: { kind: 'column', col: { name: 'No. of shares' } },
    price: { kind: 'column', col: { name: 'Price / share' } },
    currency: { kind: 'column', col: { name: 'Currency' } },
    side: {
      strategy: 'column',
      col: { name: 'Action' },
      buyValues: ['Market buy'],
      sellValues: ['Market sell'],
    },
  },
  dividend: {
    date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Total' } },
    currency: { kind: 'const', value: 'USD' },
  },
};

const SUMMARY = {
  id: 'p1',
  fingerprint: 'abcdef1234567890',
  version: 5,
  status: 'pending',
  specVersion: 1,
  brokerLabel: 'Trading 212',
  headerNames: HEADERS,
  delimiter: ',',
  generatedBy: 'llm',
  createdByUserId: null,
  createdAt: '2026-01-01 10:00:00',
  usageCount: 0,
  llmModel: 'mistral',
  llmConfidence: 0.9,
  reviewedByUserId: null,
  reviewedAt: null,
  reviewNote: null,
  batchCount: 0,
  needsReimportCount: 0,
};

const DETAIL = {
  profile: { ...SUMMARY, profile: PROFILE_JSON, sampleRows: SAMPLE },
  dryRun: {
    ok: true,
    transactions: { total: 1, sample: [], skipped: [] },
    operations: { total: 1, sample: [], skipped: [] },
    rowTraces: [
      { row: 1, matchedRuleId: 'buy', emitted: 'trade', target: 'transaction' },
      { row: 2, matchedRuleId: 'div', emitted: 'dividend', target: 'operation' },
      { row: 3, matchedRuleId: null, emitted: 'skip', skipReason: 'unknown_operation_type' },
    ],
    lints: [],
  },
  diff: null,
  audit: [],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ImportProfilesPage />
    </QueryClientProvider>,
  );
}

describe('ImportProfilesPage — review', () => {
  beforeEach(() => {
    Object.values(mockedApi).forEach((fn) => fn.mockReset());
    mockedApi.adminListImportProfiles.mockResolvedValue({ profiles: [SUMMARY] });
    mockedApi.adminGetImportProfile.mockResolvedValue(DETAIL);
    mockedApi.adminUpdateImportProfile.mockResolvedValue({
      profile: { ...SUMMARY, id: 'p2', version: 6 },
    });
  });

  it('review pokazuje rozbicie, tabelę mapowań i grupy skipów', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Przejrzyj'));

    expect(await screen.findByText('Rozpoznane typy wierszy')).toBeInTheDocument();
    expect(screen.getByText('Mapowanie: Transakcja (K/S)')).toBeInTheDocument();
    expect(screen.getByText('Pominięte wiersze — jak je obsłużyć')).toBeInTheDocument();
    // Sekcja akcji dla nierozpoznanych wierszy (z propozycją reguły).
    expect(screen.getByText(/Nierozpoznane wartości/)).toBeInTheDocument();
    expect(screen.getByText('Dodaj regułę')).toBeInTheDocument();
    // Próbka jako tabela + przycisk kopiowania surowego CSV.
    expect(screen.getByText('Kopiuj surowy CSV')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'No. of shares' })).toBeInTheDocument();
  });

  it('„Dodaj regułę" woła adminUpdateImportProfile z dołożoną regułą classify', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Przejrzyj'));

    fireEvent.click(await screen.findByText('Dodaj regułę'));

    await waitFor(() => expect(mockedApi.adminUpdateImportProfile).toHaveBeenCalled());
    const [id, sent] = mockedApi.adminUpdateImportProfile.mock.calls[0];
    expect(id).toBe('p1');
    expect(sent.classify).toHaveLength(PROFILE_JSON.classify.length + 1);
    const added = sent.classify[sent.classify.length - 1];
    expect(added.emit).toBe('trade'); // pierwsza klasa z mapowaniem w pickerze
    expect(added.when[0].values).toContain('Card debit');

    // Fix 2: dialog NIE zamyka się — pokazuje komunikat i przełącza na nową wersję.
    expect(await screen.findByText(/Zapisano jako nową wersję v6/)).toBeInTheDocument();
    await waitFor(() => expect(mockedApi.adminGetImportProfile).toHaveBeenCalledWith('p2'));
  });

  it('edytor wizualny dla profilu z indeksami; „Zapisz korektę" buduje profil i woła API', async () => {
    // Reverse-map obsługuje profile z NUMERYCZNYMI indeksami kolumn (jak z kreatora).
    const simpleProfile = {
      specVersion: 1,
      brokerLabel: 'Simple',
      file: { delimiter: ',', headerRow: { strategy: 'first' } },
      classify: [{ id: 'all', when: [{ col: 0, op: 'notEmpty' }], emit: 'trade' }],
      defaultClass: 'skip',
      trade: {
        date: { source: { kind: 'column', col: 1 }, formats: ['YYYY-MM-DD'] },
        paperName: { kind: 'column', col: 4 },
        isin: { kind: 'column', col: 2 },
        quantity: { kind: 'column', col: 5 },
        price: { kind: 'column', col: 6 },
        currency: { kind: 'column', col: 7 },
        side: {
          strategy: 'column',
          col: 0,
          buyValues: ['Market buy'],
          sellValues: ['Market sell'],
        },
      },
    };
    mockedApi.adminGetImportProfile.mockResolvedValue({
      ...DETAIL,
      profile: { ...SUMMARY, profile: simpleProfile, sampleRows: SAMPLE },
    });
    renderPage();
    fireEvent.click(await screen.findByText('Przejrzyj'));

    expect(await screen.findByText('Popraw mapowanie')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wizualnie' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Zapisz korektę/ }));
    await waitFor(() => expect(mockedApi.adminUpdateImportProfile).toHaveBeenCalled());
    const [, sent] = mockedApi.adminUpdateImportProfile.mock.calls[0];
    // buildProfileFromDraft zbudował poprawny ImportProfile (round-trip).
    expect((sent as { specVersion?: number }).specVersion).toBe(1);
  });

  it('profil zbyt złożony (regexExtract) → edytor wizualny zablokowany, wymuszony JSON', async () => {
    const complexProfile = {
      ...PROFILE_JSON,
      trade: {
        ...PROFILE_JSON.trade,
        paperName: { kind: 'regexExtract', col: { name: 'Name' }, pattern: '(.+)', group: 1 },
      },
    };
    mockedApi.adminGetImportProfile.mockResolvedValue({
      ...DETAIL,
      profile: { ...SUMMARY, profile: complexProfile, sampleRows: SAMPLE },
    });
    renderPage();
    fireEvent.click(await screen.findByText('Przejrzyj'));

    expect(await screen.findByText(/nie da się edytować wizualnie/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wizualnie' })).toBeDisabled();
  });
});
