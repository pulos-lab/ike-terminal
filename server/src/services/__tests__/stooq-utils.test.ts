import { describe, it, expect } from 'vitest';
import { isStooqBlocked, parseStooqLiveCsv } from '../stooq-utils.js';

/**
 * Detekcja blokady Stooq. Od ~07.2026 Stooq serwuje challenge anti-bot
 * (JS proof-of-work, POST /__verify) — bez jego markerów strona była
 * parsowana jako CSV (0 wierszy) i fetch po cichu wracał do stale cache.
 */

const CHALLENGE_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
  '<noscript>This site requires JavaScript to verify your browser. Please enable JavaScript and reload.</noscript>' +
  '<script>(async()=>{const r=await fetch("/__verify",{method:"POST"});if(r.ok)location.reload()})();</script>' +
  '</body></html>';

describe('isStooqBlocked', () => {
  it('wykrywa stare markery (limit / apikey / kontakt)', () => {
    expect(isStooqBlocked('Przekroczony dzienny limit wywolan')).toBe(true);
    expect(isStooqBlocked('uzyj apikey, kontakt: www@stooq.pl')).toBe(true);
  });

  it('wykrywa challenge proof-of-work (requires JavaScript / __verify)', () => {
    expect(isStooqBlocked(CHALLENGE_HTML)).toBe(true);
    expect(isStooqBlocked('This site requires JavaScript to verify your browser.')).toBe(true);
  });

  it('NIE flaguje poprawnego CSV', () => {
    expect(
      isStooqBlocked('Data,Otwarcie,Najwyzszy,Najnizszy,Zamkniecie\n2026-07-14,10,11,9,10.5'),
    ).toBe(false);
    expect(
      isStooqBlocked('Symbol,Data,Czas,Otwarcie,Zamkniecie\ncdr,2026-07-14,17:00,101,102'),
    ).toBe(false);
  });
});

describe('parseStooqLiveCsv — challenge nie przechodzi jako notowanie', () => {
  it('challenge HTML → null', () => {
    expect(parseStooqLiveCsv(CHALLENGE_HTML)).toBeNull();
  });
});
