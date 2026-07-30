import { describe, it, expect, vi } from 'vitest';
// Nagrana odpowiedź efts.sec.gov na zapytanie o SPGI→MBGL (2026-07). Fixture
// pochodzi z REALNEGO żądania — kształt `_source` jest tu jedynym źródłem prawdy.
import FTS_REAL_RESPONSE from './__fixtures__/edgar-fts-spgi.json' with { type: 'json' };
import {
  parseRatioFromSentence,
  extractRatioFromFiling,
  edgarDocUrlFromHit,
  resolveSpinoffRatioFromSec,
  htmlToText,
} from '../sec-ratio-resolver.js';

const EVENT = {
  parentTicker: 'SPGI',
  parentName: 'S&p Global Inc',
  childTicker: 'MBGL',
  childName: 'Mobility Global Inc',
  exDate: '2026-07-01',
};

// Fragmenty wg języka realnych filingów (8-K rodzica / 10-12B dziecka)
const FILING_8K_1TO1 = `
<html><body><p>On June 5, 2026, the Board of Directors of S&amp;P Global Inc.
(NYSE: SPGI) approved the distribution ratio for the previously announced
separation of its Mobility business. Each holder of SPGI common stock will
receive one share of Mobility Global Inc. common stock for every one share of
SPGI common stock held as of the record date of June 15, 2026.</p></body></html>`;

const FILING_10_12B_1TO4 = `
<html><body><div>DISTRIBUTION RATIO</div>
<p>Holders of Parent common stock will receive one share of Spinco Industries
Inc. common stock for every four shares of ParentCo Group common stock held at
the close of business on the record date. No fractional shares of SPCO will be
issued.</p></body></html>`;

const FILING_NO_RATIO = `
<html><body><p>The company announced its intention to spin off the Mobility
Global Inc. segment into an independent public company during 2026, subject to
customary conditions and final board approval.</p></body></html>`;

const FILING_CONFLICTING = `
<html><body><p>Holders will receive one share of Mobility Global Inc. for every
one share of SPGI held.</p><p>Additionally, under the 2019 plan, participants
received one share of MBGL restricted stock for every two shares of MBGL held.</p></body></html>`;

describe('parseRatioFromSentence', () => {
  it('liczby słowne i cyfrowe, wzorce "for every/each" i "ratio of"', () => {
    expect(parseRatioFromSentence('one share of X for every one share of Y held')).toBe(1);
    expect(parseRatioFromSentence('one share for every four shares')).toBe(0.25);
    expect(parseRatioFromSentence('2 shares of Newco for each share of Parent')).toBe(2);
    expect(parseRatioFromSentence('a distribution ratio of 1:4')).toBe(0.25);
    expect(parseRatioFromSentence('ratio of one-to-one')).toBe(1);
  });

  it('brak wzorca → null', () => {
    expect(parseRatioFromSentence('intends to spin off its mobility unit')).toBeNull();
    expect(parseRatioFromSentence('')).toBeNull();
  });
});

describe('extractRatioFromFiling', () => {
  it('8-K rodzica: 1:1 z kontekstem tickera/nazwy', () => {
    expect(extractRatioFromFiling(FILING_8K_1TO1, EVENT)).toBe(1);
  });

  it('DOSŁOWNE brzmienie komunikatu SPGI→MBGL (real-world): "for every share" bez liczby → 1', () => {
    // Cytat z ogłoszenia S&P Global z 2026-05-21 (IR + 8-K) — mianownik
    // domyślny, bo po "for every" nie ma liczby.
    const verbatim =
      '<p>S&P Global shareholders will receive one share of Mobility Global common stock ' +
      'for every share of S&P Global common stock held at the close of business on the ' +
      'record date of June 15, 2026.</p>';
    expect(extractRatioFromFiling(verbatim, EVENT)).toBe(1);
  });

  it('10-12B dziecka: 1 za 4 (ratio 0.25) — kontekst po tickerze dziecka', () => {
    const event = {
      parentTicker: 'PRNT',
      parentName: 'ParentCo Group',
      childTicker: 'SPCO',
      childName: 'Spinco Industries Inc',
    };
    expect(extractRatioFromFiling(FILING_10_12B_1TO4, event)).toBe(0.25);
  });

  it('filing bez ratio → null (nie zgadujemy)', () => {
    expect(extractRatioFromFiling(FILING_NO_RATIO, EVENT)).toBeNull();
  });

  it('konflikt wartości w dokumencie → null (niejednoznaczne)', () => {
    expect(extractRatioFromFiling(FILING_CONFLICTING, EVENT)).toBeNull();
  });

  it('zdanie z ratio ale BEZ kontekstu spółek nie kwalifikuje', () => {
    const foreign = `<p>Holders of Unrelated Corp will receive one share of
      Other Inc for every five shares held.</p>`;
    expect(extractRatioFromFiling(foreign, EVENT)).toBeNull();
  });
});

describe('htmlToText / edgarDocUrlFromHit', () => {
  it('zdejmuje tagi, style i encje', () => {
    expect(htmlToText('<p>S&amp;P <b>Global</b></p><style>x{}</style>')).toBe('S&P Global');
  });

  it('buduje URL dokumentu z REALNEJ odpowiedzi FTS (accession bez myślników, CIK bez zer)', () => {
    // Regresja: poprzedni fixture był pisany ręcznie i używał pola `cik`, którego
    // EDGAR nie zwraca — kod czytał to samo nieistniejące pole, więc test był
    // zielony, a rezolwer nie pobrał w produkcji ani jednego filingu. Ten fixture
    // to nagrana odpowiedź efts.sec.gov (pole `ciks`, tablica).
    const hit = FTS_REAL_RESPONSE.hits.hits[0];
    expect(hit._source.ciks).toEqual(['0002090312']);
    expect(hit._source).not.toHaveProperty('cik');
    expect(edgarDocUrlFromHit(hit)).toBe(
      'https://www.sec.gov/Archives/edgar/data/2090312/000110465926066592/tm2528763d9_ex99-1.htm',
    );
  });

  it('akceptuje też pojedyncze `cik` (zgodność wstecz, gdyby EDGAR wrócił do l. poj.)', () => {
    expect(
      edgarDocUrlFromHit({
        _id: '0001104659-26-066592:tm2528763d9_ex99-1.htm',
        _source: { cik: '0002090312' },
      }),
    ).toBe(
      'https://www.sec.gov/Archives/edgar/data/2090312/000110465926066592/tm2528763d9_ex99-1.htm',
    );
  });

  it('niepełny hit → null', () => {
    expect(edgarDocUrlFromHit({ _id: 'bez-dwukropka' })).toBeNull();
    expect(edgarDocUrlFromHit({ _id: 'a:b.htm', _source: {} })).toBeNull();
  });
});

describe('secUserAgent (nagłówek wymagany przez SEC)', () => {
  const withContact = async (value: string | undefined) => {
    const prev = process.env.SEC_CONTACT;
    if (value === undefined) delete process.env.SEC_CONTACT;
    else process.env.SEC_CONTACT = value;
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await resolveSpinoffRatioFromSec(EVENT, fetchFn as unknown as typeof fetch);
    if (prev === undefined) delete process.env.SEC_CONTACT;
    else process.env.SEC_CONTACT = prev;
    const init = fetchFn.mock.calls[0][1] as { headers: Record<string, string> };
    return init.headers['User-Agent'];
  };

  it('bez SEC_CONTACT używa kontaktu z prawdziwą domeną (localhost → 403 z sec.gov)', async () => {
    const ua = await withContact(undefined);
    expect(ua).toContain('@');
    expect(ua).not.toMatch(/localhost/i);
  });

  it('SEC_CONTACT z domeną localhost jest odrzucany na rzecz domyślnego', async () => {
    const ua = await withContact('IKE admin@localhost');
    expect(ua).not.toMatch(/localhost/i);
  });

  it('poprawny SEC_CONTACT jest używany bez zmian', async () => {
    expect(await withContact('Jan Kowalski jan@example.com')).toBe('Jan Kowalski jan@example.com');
  });
});

describe('resolveSpinoffRatioFromSec (mock fetch)', () => {
  const FTS_RESPONSE = FTS_REAL_RESPONSE;

  it('FTS → dokument → jednoznaczne ratio + sourceUrl; formularze 8-K i 10-12B w zapytaniu', async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('efts.sec.gov')) {
        return new Response(JSON.stringify(FTS_RESPONSE), { status: 200 });
      }
      return new Response(FILING_8K_1TO1, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await resolveSpinoffRatioFromSec(EVENT, fetchFn);
    expect(result).toEqual({
      ratio: 1,
      sourceUrl:
        'https://www.sec.gov/Archives/edgar/data/2090312/000110465926066592/tm2528763d9_ex99-1.htm',
    });

    const ftsUrl = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // URLSearchParams koduje spacje jako '+' — normalizujemy przed asercjami
    const decoded = decodeURIComponent(ftsUrl).replace(/\+/g, ' ');
    expect(ftsUrl).toContain('efts.sec.gov');
    expect(decoded).toContain('8-K,10-12B');
    expect(decoded).toContain('"distribution ratio"');
    expect(decoded).toContain('Mobility Global Inc');
    // Okno dat wokół ex-date
    expect(ftsUrl).toContain('startdt=2026-04-02');
    expect(ftsUrl).toContain('enddt=2026-07-22');
  }, 15_000);

  it('dokument bez jednoznacznego ratio → null; awaria FTS → null (bez wyjątku)', async () => {
    const noRatioFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('efts.sec.gov')) {
        return new Response(JSON.stringify(FTS_RESPONSE), { status: 200 });
      }
      return new Response(FILING_NO_RATIO, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await resolveSpinoffRatioFromSec(EVENT, noRatioFetch)).toBeNull();

    const failFetch = vi.fn().mockRejectedValue(new Error('blocked')) as unknown as typeof fetch;
    expect(await resolveSpinoffRatioFromSec(EVENT, failFetch)).toBeNull();
  }, 15_000);
});
