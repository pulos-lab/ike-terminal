import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { suggestDraft } from '@/lib/generic-profile-builder';
import { SideMapping } from '../SideMapping';

/**
 * Formularz kupna/sprzedaży: wartości kolumny z pliku przypisywane kliknięciem
 * (zgłoszenie: plik funduszu z „dopłata roczna" zamiast K/S).
 */

const HEADERS = ['Data zlecenia', 'Nazwa produktu', 'Typ transakcji', 'Liczba JU', 'Cena JU'];
const SAMPLE = [
  ['2025-03-27', 'PPK', 'dopłata roczna', '1.14728', '209.19'],
  ['2025-03-12', 'PPK', 'wpłata pracownika', '0.95125', '208.41'],
];

describe('SideMapping', () => {
  const draft = suggestDraft(HEADERS, SAMPLE, { delimiter: ';', headerRowIndex: 0 });

  it('pokazuje wartości kolumny z pliku, domyślnie jako „Pomiń"', () => {
    render(<SideMapping draft={draft} sampleRows={SAMPLE} setTrade={vi.fn()} />);

    for (const value of ['dopłata roczna', 'wpłata pracownika']) {
      const group = screen.getByRole('group', { name: `Znaczenie wartości „${value}”` });
      expect(within(group).getByRole('button', { name: 'Pomiń' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    // Pola tekstowe nie udają dopasowania domyślnymi „K, BUY, Kupno".
    expect(screen.queryByDisplayValue('K, BUY, Kupno')).not.toBeInTheDocument();
  });

  it('kliknięcie „Kupno" dopisuje wartość do listy kupna', () => {
    const setTrade = vi.fn();
    render(<SideMapping draft={draft} sampleRows={SAMPLE} setTrade={setTrade} />);

    const group = screen.getByRole('group', { name: 'Znaczenie wartości „dopłata roczna”' });
    fireEvent.click(within(group).getByRole('button', { name: 'Kupno' }));

    expect(setTrade).toHaveBeenCalledWith({ buyValues: 'dopłata roczna', sellValues: '' });
  });

  it('strategia „znak ilości" nie pokazuje listy wartości ani pól tekstowych', () => {
    const signed = { ...draft, trade: { ...draft.trade, sideStrategy: 'signedQuantity' as const } };
    render(<SideMapping draft={signed} sampleRows={SAMPLE} setTrade={vi.fn()} />);

    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.queryByText('Wartości oznaczające kupno')).not.toBeInTheDocument();
  });
});
