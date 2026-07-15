import { describe, it, expect } from 'vitest';
import { parseBondDetailHtml } from '../bond-detail.js';

// Fragment realnej struktury obligacje.pl/pl/obligacja/BST0728 (potwierdzony na żywym HTML).
const BST0728_HTML = `
<table class="szczegoly">
  <tr><th>Emitent:</th>
    <td><a href="/pl/emitent/best-s-a" class="nazwa-emitenta">Best S.A.</a></td></tr>
  <tr><th>ISIN:</th>
    <td>PLBEST000390</td></tr>
  <tr><th>Seria:</th>
    <td>Z5</td></tr>
  <tr><th>Wartość nominalna:</th>
    <td>100.00 PLN</td></tr>
  <tr><th>Typ oprocentowania:</th>
    <td>zmienne WIBOR 3M +  5%</td></tr>
</table>
<h4>Dzień wykupu</h4>
<div class="txt"><ul><li>2026-04-16</li></ul></div>
`;

describe('parseBondDetailHtml', () => {
  it('buduje kompletny wpis z realistycznego HTML (BST0728)', () => {
    const entry = parseBondDetailHtml(BST0728_HTML, 'bst0728');
    expect(entry).not.toBeNull();
    expect(entry!.isin).toBe('PLBEST000390');
    expect(entry!.ticker).toBe('BST0728'); // uppercased
    expect(entry!.name).toBe('Best S.A.');
    expect(entry!.nominal).toBe(100);
    expect(entry!.currency).toBe('PLN');
    expect(entry!.maturityDate).toBe('2026-04-16');
    expect(entry!.segment).toBe('corporate');
    expect(entry!.couponType).toBe('floating');
    expect(entry!.series).toBe('Z5');
  });

  it('zwraca null gdy brak ISIN lub nominału (nie-obligacja / pusta strona)', () => {
    expect(parseBondDetailHtml('<html><body>404</body></html>', 'XYZ1234')).toBeNull();
    expect(parseBondDetailHtml('<th>ISIN:</th><td>PL0000ABC</td>', 'XYZ1234')).toBeNull(); // brak nominału
  });

  it('skarbowa: segment treasury z regexu tickera nawet bez nazwy emitenta', () => {
    const html =
      '<th>ISIN:</th><td>PL0000112736</td><th>Wartość nominalna:</th><td>1 000.00 PLN</td>';
    const entry = parseBondDetailHtml(html, 'DS1030');
    expect(entry!.segment).toBe('treasury');
    expect(entry!.nominal).toBe(1000);
  });

  it('data wykupu: fallback z tickera (MMRR) gdy brak sekcji "Dzień wykupu"', () => {
    const html =
      '<th>ISIN:</th><td>PLABC0000001</td><th>Wartość nominalna:</th><td>1000.00 PLN</td>';
    const entry = parseBondDetailHtml(html, 'ABC0728');
    expect(entry!.maturityDate).toBe('2028-07-01');
  });
});
