import { describe, it, expect } from 'vitest';
import { parseBiznesradarPrice } from '../biznesradar.js';

describe('parseBiznesradarPrice', () => {
  it('parsuje kurs NC (grosze) z q_ch_act', () => {
    const html = '<span class="q_ch_act">0.565</span><span class="q_ch_pkt cplus">+0.060</span>';
    expect(parseBiznesradarPrice(html)).toBe(0.565);
  });

  it('parsuje kurs pełnozłotowy z częścią setną', () => {
    expect(parseBiznesradarPrice('<span class="q_ch_act">56.40</span>')).toBe(56.4);
  });

  it('bierze PIERWSZE wystąpienie (nagłówek), ignoruje kolejne w tabeli', () => {
    const html =
      '<span class="q_ch_act">0.565</span> ... <span class="q_ch_act">99.99</span>';
    expect(parseBiznesradarPrice(html)).toBe(0.565);
  });

  it('radzi sobie ze spacją jako separatorem tysięcy', () => {
    expect(parseBiznesradarPrice('<span class="q_ch_act">1 234.50</span>')).toBe(1234.5);
  });

  it('toleruje dodatkowe atrybuty i whitespace w tagu', () => {
    expect(parseBiznesradarPrice('<span class="q_ch_act" data-x="1">  12.3</span>')).toBe(12.3);
  });

  it('zwraca null gdy brak elementu kursu (np. 404 / inna strona)', () => {
    expect(parseBiznesradarPrice('<html><body>Nie znaleziono</body></html>')).toBeNull();
  });

  it('zwraca null dla zera/ujemnych (brak notowania)', () => {
    expect(parseBiznesradarPrice('<span class="q_ch_act">0</span>')).toBeNull();
  });
});
