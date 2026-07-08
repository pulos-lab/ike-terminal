import { describe, it, expect } from 'vitest';
import {
  extractSectionTables,
  cellsToRecord,
  parseIbkrNumber,
  parseIbkrDate,
} from '../ibkr/html-tables.js';

/**
 * Fixtures odwzorowują strukturę realnych wyciągów IBKR (2021-2025):
 * - Trades: wiersze danych z klasą `row-summary`, subtotale/totale do pominięcia,
 *   nagłówki grupujące asset-class i waluty jako jednokomórkowe wiersze colspan;
 * - Transfers/ContractInfo: wiersze danych BEZ klasy;
 * - ID sekcji z podkreślnikiem (tblTransactions_U6474045Body) i bez (tblContractInfoU6474045Body).
 */

const TRADES_HTML = `
<html><body>
<div id="secTransactions_U6474045Heading" class="sectionHeadingClosed">Trades</div>
<div id="tblTransactions_U6474045Body" class="sectionContent">
<table>
<thead><tr>
  <th align="left">Symbol</th><th>Date/Time</th><th>Quantity</th><th>T. Price</th>
  <th>C. Price</th><th>Proceeds</th><th>Comm/Fee</th><th>Basis</th>
  <th>Realized P/L</th><th>MTM P/L</th><th>Code</th>
</tr></thead>
<tbody>
<tr><td class="header-asset" colspan="11">Stocks</td></tr>
<tr><td class="header-currency" colspan="11">USD</td></tr>
<tr class="row-summary no-details">
  <td>ABNB</td><td>2021-12-09, 14:12:23</td><td align="right">6</td>
  <td align="right">179.4200</td><td align="right">171.0400</td><td align="right">-1,076.52</td>
  <td align="right">-0.35</td><td align="right">1,076.87</td><td align="right">0.00</td>
  <td align="right">-50.28</td><td align="right">O</td>
</tr>
<tr class="subtotal"><td class="indent" colspan="2">Total&nbsp;ABNB</td><td align="right">6</td>
  <td>&nbsp;</td><td>&nbsp;</td><td align="right">-1,076.52</td><td align="right">-0.35</td>
  <td align="right">1,076.87</td><td align="right">0.00</td><td align="right">-50.28</td><td>&nbsp;</td></tr>
<tr><td class="header-asset" colspan="11">Equity and Index Options</td></tr>
<tr><td class="header-currency" colspan="11">USD</td></tr>
<tr class="row-summary no-details">
  <td>DKNG 20MAY22 60.0 P</td><td>2021-11-04, 10:05:18</td><td align="right">-1</td>
  <td align="right">16.3200</td><td align="right">17.9483</td><td align="right">1,632.00</td>
  <td align="right">-0.68</td><td align="right">-1,631.32</td><td align="right">0.00</td>
  <td align="right">-162.83</td><td align="right">O</td>
</tr>
<tr class="total"><td colspan="2">Total in&nbsp;PLN</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
  <td align="right">555.48</td><td align="right">-2.72</td><td>&nbsp;</td><td>&nbsp;</td>
  <td align="right">-163.11</td><td>&nbsp;</td></tr>
</tbody>
</table>
</div>
</body></html>`;

const CONTRACT_INFO_HTML = `
<html><body>
<div id="tblContractInfoU6474045Body" class="sectionContent">
<table>
<thead><tr><th>Symbol</th><th>Description</th><th>Conid</th><th>Security ID</th><th>Listing Exch</th><th>Multiplier</th><th>Type</th><th>Code</th></tr></thead>
<tbody>
<tr><td class="header-asset" colspan="8">Stocks</td></tr>
<tr><td>ABNB</td><td>AIRBNB INC-CLASS A</td><td>459530964</td><td>US0090661010</td><td>NASDAQ</td><td>1</td><td>COMMON</td><td>&nbsp;</td></tr>
</tbody>
</table>
<table>
<thead><tr><th>Symbol</th><th>Description</th><th>Conid</th><th>Listing Exch</th><th>Multiplier</th><th>Expiry</th><th>Delivery Month</th><th>Type</th><th>Strike</th><th>Code</th></tr></thead>
<tbody>
<tr><td class="header-asset" colspan="10">Equity and Index Options</td></tr>
<tr><td>INTC  240906P00018000</td><td>INTC 06SEP24 18 P</td><td>720101307</td><td>CBOE</td><td>100</td><td>2024-09-06</td><td>2024-09</td><td>P</td><td>18</td><td>&nbsp;</td></tr>
</tbody>
</table>
</div>
</body></html>`;

describe('extractSectionTables', () => {
  it('wyciąga wiersze danych z kontekstem asset-class i waluty, pomijając subtotale/totale', () => {
    const [table] = extractSectionTables(TRADES_HTML, 'Transactions');
    expect(table.headers).toEqual([
      'Symbol',
      'Date/Time',
      'Quantity',
      'T. Price',
      'C. Price',
      'Proceeds',
      'Comm/Fee',
      'Basis',
      'Realized P/L',
      'MTM P/L',
      'Code',
    ]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toMatchObject({
      assetClass: 'Stocks',
      currency: 'USD',
    });
    expect(table.rows[0].cells[0]).toBe('ABNB');
    expect(table.rows[1]).toMatchObject({
      assetClass: 'Equity and Index Options',
      currency: 'USD',
    });
    expect(table.rows[1].cells[0]).toBe('DKNG 20MAY22 60.0 P');
    expect(table.rows[1].cells[2]).toBe('-1');
  });

  it('matchuje ID sekcji bez podkreślnika (wariant ContractInfo) i wiersze bez klasy', () => {
    const tables = extractSectionTables(CONTRACT_INFO_HTML, 'ContractInfo');
    expect(tables).toHaveLength(2);
    // Tabela akcji i tabela opcji mają RÓŻNE nagłówki — mapowanie musi iść po nazwach
    expect(tables[0].headers).toContain('Security ID');
    expect(tables[1].headers).toContain('Strike');
    const stockRec = cellsToRecord(tables[0].headers, tables[0].rows[0].cells);
    expect(stockRec['Security ID']).toBe('US0090661010');
    const optRec = cellsToRecord(tables[1].headers, tables[1].rows[0].cells);
    expect(optRec['Symbol']).toBe('INTC 240906P00018000');
    expect(optRec['Description']).toBe('INTC 06SEP24 18 P');
    expect(optRec['Multiplier']).toBe('100');
    expect(optRec['Expiry']).toBe('2024-09-06');
  });

  it('zwraca [] dla sekcji nieobecnej w pliku', () => {
    expect(extractSectionTables(TRADES_HTML, 'CorporateActions')).toEqual([]);
  });
});

describe('parseIbkrNumber', () => {
  it('parsuje liczby z separatorem tysięcy i ujemne', () => {
    expect(parseIbkrNumber('1,076.52')).toBe(1076.52);
    expect(parseIbkrNumber('-1,631.32')).toBe(-1631.32);
    expect(parseIbkrNumber('0.491246')).toBe(0.491246);
    expect(parseIbkrNumber('2,000')).toBe(2000);
  });

  it('puste komórki i "--" → null', () => {
    expect(parseIbkrNumber('')).toBeNull();
    expect(parseIbkrNumber('--')).toBeNull();
    expect(parseIbkrNumber(' ')).toBeNull();
  });
});

describe('parseIbkrDate', () => {
  it('data z czasem → ISO z T (czas wchodzi do klucza dedup)', () => {
    expect(parseIbkrDate('2024-01-15, 10:30:05')).toBe('2024-01-15T10:30:05');
  });

  it('sama data (sekcje cash) → bez zmian', () => {
    expect(parseIbkrDate('2021-10-14')).toBe('2021-10-14');
  });

  it('śmieci → null', () => {
    expect(parseIbkrDate('Total')).toBeNull();
  });
});
