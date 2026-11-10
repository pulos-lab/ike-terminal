import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { DateFormat } from 'shared';
import {
  DATE_FORMATS,
  dateFormatMatchesSamples,
  valueColumnMatchesSamples,
} from '@/lib/generic-profile-builder';

/**
 * Współdzielone kontrolki mapowania kolumn — używane przez pełny `MappingEditor`
 * (ścieżka ręczna) i `GapFields` (karta „uzupełnij brakujące pola"). Dropdowny
 * kolumn pokazują przykładową wartość z (zredagowanej) próbki, żeby wybór był
 * jednoznaczny bez zaglądania do pliku.
 */

/** Przykładowa wartość kolumny z pierwszego wiersza próbki, który ją ma. */
function exampleFor(sampleRows: string[][], colIndex: number): string {
  for (const row of sampleRows) {
    const v = (row[colIndex] ?? '').trim();
    if (v) return v.length > 24 ? `${v.slice(0, 24)}…` : v;
  }
  return '';
}

/**
 * Siatka pól formularza: jedna kolumna na telefonie, dwie od `sm`. Dwie kolumny na
 * ~330 px dawały komórki po ~150 px — węższe niż sama nazwa kolumny w selekcie.
 */
export const FIELD_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2';

/**
 * Trigger selecta w formularzu mapowania. Bazowy `SelectTrigger` ma `w-fit` +
 * `whitespace-nowrap`, czyli szerokość TREŚCI — przy długiej nazwie kolumny wychodził
 * poza komórkę siatki i nakładał się na sąsiednie pole. Tu trzyma się komórki.
 */
export const SELECT_TRIGGER = 'h-8 w-full min-w-0 text-xs';

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </label>
      {children}
    </div>
  );
}

interface ColumnSelectProps {
  headers: string[];
  sampleRows: string[][];
  value: number;
  onValue: (v: number) => void;
  allowNone?: boolean;
  placeholder?: string;
}

export function ColumnSelect({
  headers,
  sampleRows,
  value,
  onValue,
  allowNone = true,
  placeholder = 'Wybierz kolumnę',
}: ColumnSelectProps) {
  const example = value >= 0 ? exampleFor(sampleRows, value) : '';
  return (
    <Select value={String(value)} onValueChange={(v) => onValue(Number(v))}>
      <SelectTrigger className={SELECT_TRIGGER}>
        {/*
         * Treść wybranej pozycji renderujemy sami (zamiast lustra pozycji listy), żeby
         * mogła się skracać: nazwa kolumny ma pierwszeństwo, przykład ustępuje jej miejsca.
         */}
        <SelectValue placeholder={placeholder}>
          <span className="flex w-full min-w-0 items-baseline gap-2 text-left">
            {value >= 0 ? (
              <>
                <span className="truncate">{headers[value] || `(kolumna ${value + 1})`}</span>
                {example && (
                  <span className="min-w-0 shrink-[100] truncate text-muted-foreground">
                    np. {example}
                  </span>
                )}
              </>
            ) : (
              <span className="truncate text-muted-foreground">
                {allowNone ? '— brak —' : placeholder}
              </span>
            )}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowNone && (
          <SelectItem value="-1">
            <span className="text-muted-foreground">— brak —</span>
          </SelectItem>
        )}
        {headers.map((h, i) => (
          <SelectItem key={i} value={String(i)}>
            <span>{h || `(kolumna ${i + 1})`}</span>
            {exampleFor(sampleRows, i) && (
              <span className="ml-2 text-muted-foreground">np. {exampleFor(sampleRows, i)}</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function DateFormatSelect({
  value,
  onValue,
}: {
  value: DateFormat;
  onValue: (v: DateFormat) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onValue(v as DateFormat)}>
      <SelectTrigger className={SELECT_TRIGGER}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {DATE_FORMATS.map((f) => (
          <SelectItem key={f} value={f}>
            {f}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Walidacja formatu daty NA ŻYWO względem (zredagowanej) próbki — zły wybór
 * jest widoczny od razu, a nie dopiero w podglądzie po rundtripie na serwer.
 * Nic nie pokazuje, gdy nie ma czego ocenić (brak kolumny/pusta próbka).
 */
export function DateFormatHint({
  sampleRows,
  col,
  format,
}: {
  sampleRows: string[][];
  col: number;
  format: DateFormat;
}) {
  const matches = dateFormatMatchesSamples(sampleRows, col, format);
  if (matches === null) return null;
  return matches ? (
    <p className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <CheckCircle2 className="h-3 w-3 text-success" aria-hidden />
      Pasuje do dat w pliku
    </p>
  ) : (
    <p className="inline-flex items-center gap-1 text-[11px] text-warning">
      <AlertTriangle className="h-3 w-3" aria-hidden />
      Daty w pliku nie wyglądają na ten format — sprawdź przykład przy kolumnie
    </p>
  );
}

/**
 * Ostrzeżenie NA ŻYWO, gdy kolumna wskazana jako „Wartość" nie zgadza się na próbce
 * z ilość×cena (typowo: saldo po transakcji). Silnik odrzuca wtedy każdy wiersz, więc
 * lepiej powiedzieć to przy polu niż dopiero w pustym podglądzie.
 */
export function ValueColumnHint({
  sampleRows,
  quantityCol,
  priceCol,
  valueCol,
}: {
  sampleRows: string[][];
  quantityCol: number;
  priceCol: number;
  valueCol: number;
}) {
  if (valueColumnMatchesSamples(sampleRows, quantityCol, priceCol, valueCol) !== false) return null;
  return (
    <p className="inline-flex items-start gap-1 text-[11px] text-warning">
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      Ta kolumna nie zgadza się z ilość×cena — wygląda na saldo, nie wartość transakcji. Ustaw
      „— brak —”, inaczej wiersze zostaną odrzucone.
    </p>
  );
}
