import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InfoPopover } from '../info-popover';

function renderPopover() {
  return render(
    <InfoPopover label="Wpływ walut — szczegóły" trigger={<span>Wpływ walut −0,71%</span>}>
      <p>Średni kurs nabycia</p>
    </InfoPopover>,
  );
}

const trigger = () => screen.getByRole('button', { name: 'Wpływ walut — szczegóły' });

describe('InfoPopover', () => {
  it('treść jest zamknięta, dopóki nikt jej nie otworzy', () => {
    renderPopover();
    expect(screen.queryByText('Średni kurs nabycia')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('otwiera się kliknięciem/tapnięciem — bez hovera (telefon, tablet)', () => {
    renderPopover();
    fireEvent.click(trigger());
    expect(screen.getByText('Średni kurs nabycia')).toBeTruthy();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('drugie tapnięcie zamyka', () => {
    renderPopover();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByText('Średni kurs nabycia')).toBeNull();
  });

  it('mysz: najechanie otwiera, a kliknięcie wtedy przypina zamiast zamykać', () => {
    renderPopover();
    fireEvent.pointerEnter(trigger(), { pointerType: 'mouse' });
    expect(screen.getByText('Średni kurs nabycia')).toBeTruthy();
    fireEvent.click(trigger());
    expect(screen.getByText('Średni kurs nabycia')).toBeTruthy();
  });

  it('dotyk nie uruchamia ścieżki hovera', () => {
    renderPopover();
    fireEvent.pointerEnter(trigger(), { pointerType: 'touch' });
    expect(screen.queryByText('Średni kurs nabycia')).toBeNull();
  });

  it('Escape zamyka', () => {
    renderPopover();
    fireEvent.click(trigger());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByText('Średni kurs nabycia')).toBeNull();
  });
});
