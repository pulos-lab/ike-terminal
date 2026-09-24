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

/** Limity archiwum XLSX PRZED dekompresją. Upload ma limit 5 MB, ale dotyczy
 *  bajtów SKOMPRESOWANYCH — ZIP z milionami zer rozpakowuje się do gigabajtów
 *  w pamięci procesu wspólnego dla wszystkich użytkowników. Realne wyciągi
 *  brokerów (XTB, eksporty XLSX) to pojedyncze MB po rozpakowaniu. */
export const XLSX_MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;
export const XLSX_MAX_ENTRIES = 5000;
const XLSX_MAX_RATIO = 200; // pojedynczy wpis > 10 MB z kompresją >200× = bomba

/** Plik XLSX odrzucony przed dekompresją — komunikat nadaje się dla użytkownika. */
export class XlsxRejectedError extends Error {
  /** Honorowane przez globalny handler błędów → 400 z komunikatem zamiast 500. */
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'XlsxRejectedError';
  }
}

/**
 * Sprawdza centralny katalog ZIP (bez dekompresji): sumę rozmiarów po
 * rozpakowaniu, liczbę wpisów i współczynnik kompresji. ZIP64 odrzucamy —
 * arkusz brokera nigdy nie przekracza 4 GB, a pola 0xFFFFFFFF ukrywają rozmiar.
 */
export function assertSafeXlsxArchive(buffer: Buffer): void {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  const minEocd = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minEocd; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxRejectedError('Plik XLSX jest uszkodzony (brak katalogu ZIP).');
  const entries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) {
    throw new XlsxRejectedError('Plik XLSX w formacie ZIP64 nie jest obsługiwany.');
  }
  if (entries > XLSX_MAX_ENTRIES) {
    throw new XlsxRejectedError(`Plik XLSX ma zbyt wiele elementów (${entries}).`);
  }
  let total = 0;
  let pos = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CEN) {
      throw new XlsxRejectedError('Plik XLSX jest uszkodzony (niespójny katalog ZIP).');
    }
    const compressed = buffer.readUInt32LE(pos + 20);
    const uncompressed = buffer.readUInt32LE(pos + 24);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new XlsxRejectedError('Plik XLSX w formacie ZIP64 nie jest obsługiwany.');
    }
    if (uncompressed > 10 * 1024 * 1024 && uncompressed > compressed * XLSX_MAX_RATIO) {
      throw new XlsxRejectedError('Plik XLSX ma podejrzanie wysoki współczynnik kompresji.');
    }
    total += uncompressed;
    if (total > XLSX_MAX_UNCOMPRESSED_BYTES) {
      throw new XlsxRejectedError('Plik XLSX jest zbyt duży po rozpakowaniu.');
    }
    pos +=
      46 +
      buffer.readUInt16LE(pos + 28) +
      buffer.readUInt16LE(pos + 30) +
      buffer.readUInt16LE(pos + 32);
  }
}

/** Skoroszyty wczytane w ramach tego samego bufora (klasyfikacja → detekcja →
 *  parsowanie jednego requestu podają TEN SAM obiekt Buffer). WeakMap: wpis
 *  znika razem z buforem po zakończeniu requestu. Wcześniej jeden plik XTB był
 *  dekompresowany 3–4 razy. Konsumenci traktują skoroszyt jako tylko-do-odczytu. */
const workbookCache = new WeakMap<Buffer, Promise<ExcelJS.Workbook>>();

/** Jedyny punkt wczytywania XLSX: kontrola archiwum + cache per bufor. */
export function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  let p = workbookCache.get(buffer);
  if (!p) {
    p = (async () => {
      assertSafeXlsxArchive(buffer);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      return wb;
    })();
    // Odrzucony/uszkodzony plik nie zostaje w cache jako trwały błąd.
    p.catch(() => workbookCache.delete(buffer));
    workbookCache.set(buffer, p);
  }
  return p;
}

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
  const wb = await loadWorkbook(buffer);
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
