import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseBiznesradarPrice,
  detectBiznesradarBlock,
  fetchBiznesradarPrice,
  getBiznesradarBlockState,
} from '../biznesradar.js';

describe('parseBiznesradarPrice', () => {
  it('parsuje kurs NC (grosze) z q_ch_act', () => {
    const html = '<span class="q_ch_act">0.565</span><span class="q_ch_pkt cplus">+0.060</span>';
    expect(parseBiznesradarPrice(html)).toBe(0.565);
  });

  it('parsuje kurs pełnozłotowy z częścią setną', () => {
    expect(parseBiznesradarPrice('<span class="q_ch_act">56.40</span>')).toBe(56.4);
  });

  it('bierze PIERWSZE wystąpienie (nagłówek), ignoruje kolejne w tabeli', () => {
    const html = '<span class="q_ch_act">0.565</span> ... <span class="q_ch_act">99.99</span>';
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

describe('detectBiznesradarBlock', () => {
  it('status 429/403/503 = blokada', () => {
    expect(detectBiznesradarBlock(429, '')).toBe(true);
    expect(detectBiznesradarBlock(403, '')).toBe(true);
    expect(detectBiznesradarBlock(503, '')).toBe(true);
  });

  it('markery challenge w HTML = blokada', () => {
    expect(detectBiznesradarBlock(200, '<title>Just a moment...</title>')).toBe(true);
    expect(detectBiznesradarBlock(200, 'please solve the CAPTCHA')).toBe(true);
    expect(detectBiznesradarBlock(200, 'Attention Required! Cloudflare')).toBe(true);
    expect(detectBiznesradarBlock(200, 'Zbyt wiele zapytań')).toBe(true);
  });

  it('normalna strona notowań = brak blokady', () => {
    expect(detectBiznesradarBlock(200, '<span class="q_ch_act">0.565</span>')).toBe(false);
  });

  it('404 „nie istnieje" = NIE blokada (nieznany ticker)', () => {
    expect(detectBiznesradarBlock(404, 'Strona nie istnieje')).toBe(false);
  });
});

describe('fetchBiznesradarPrice — bezpiecznik (circuit breaker)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('po 3 blokadach (429) otwiera bezpiecznik i short-circuituje kolejne fetch-e', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    // 3 blokady pod rząd — próg BLOCK_THRESHOLD
    await fetchBiznesradarPrice('BLK1');
    await fetchBiznesradarPrice('BLK2');
    await fetchBiznesradarPrice('BLK3');

    expect(getBiznesradarBlockState().blocked).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 4. wywołanie: bezpiecznik otwarty → zero ruchu sieciowego
    const price = await fetchBiznesradarPrice('BLK4');
    expect(price).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3); // nadal 3 — nie dobijamy odciętego serwisu
  });
});
