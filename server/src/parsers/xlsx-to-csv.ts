import ExcelJS from 'exceljs';
import Papa from 'papaparse';

/**
 * XLSX → CSV-string: cienka warstwa dekodująca dla importu uniwersalnego.
 *
 * Silnik generyczny jest WIERSZOWY (`parseWithProfile(content: string, …)`),
 * więc jedyną różnicą CSV↔XLSX jest dekodowanie. Każdy arkusz serializujemy do
 * CSV (średnik) i podajemy do NIEZMIENIONEGO silnika. Ten sam kod (`cellToString`
 * + `Papa.unparse`) osiągnął pełny parytet na XTB w harnessie parytetu — tu jest
 * podniesiony do wspólnego utila (harness importuje stąd).
 *
 * XLSX serializujemy ZAWSZE średnikiem — profile XLSX mają `file.delimiter = ';'`
 * (wewnętrzny wybór serializacji; fingerprint XLSX i tak używa nazwy arkusza,
 * nie delimitera).
 */

const XLSX_DELIMITER = ';';

/** Serializacja komórki do tekstu (daty: czas LOKALNY, jak parser wbudowany XTB). */
export function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ` +
      `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`
    );
  }
  if (typeof v === 'object') {
    if ('result' in v) return cellToString((v as { result: ExcelJS.CellValue }).result);
    if ('richText' in v) {
      return (v as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('');
    }
    if ('text' in v) return String((v as { text: unknown }).text);
    return '';
  }
  return String(v);
}

/** Arkusz → string CSV (średnik). Zwraca też liczbę niepustych wierszy. */
export function sheetToCsv(ws: ExcelJS.Worksheet): { csv: string; rowCount: number } {
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (c) => {
      cells.push(cellToString(c.value));
    });
    rows.push(cells);
  });
  return { csv: Papa.unparse(rows, { delimiter: XLSX_DELIMITER }), rowCount: rows.length };
}

export interface XlsxSheet {
  name: string;
  csv: string;
  /** Liczba niepustych wierszy (z nagłówkiem) — tani pre-filtr arkuszy-okładek. */
  rowCount: number;
}

/** Wczytaj skoroszyt i zwróć WSZYSTKIE arkusze jako CSV (w kolejności z pliku). */
export async function loadXlsxSheets(buffer: Buffer): Promise<XlsxSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const { csv, rowCount } = sheetToCsv(ws);
    return { name: ws.name, csv, rowCount };
  });
}

/** Czy bufor wygląda na XLSX (sygnatura ZIP „PK\x03\x04"). Tani, bez ładowania. */
export function looksLikeXlsx(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}
