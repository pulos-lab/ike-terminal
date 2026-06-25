import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { DateFormat } from 'shared';
import { DATE_FORMATS } from '@/lib/generic-profile-builder';

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

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
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
  return (
    <Select value={String(value)} onValueChange={(v) => onValue(Number(v))}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder={placeholder} />
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
      <SelectTrigger className="h-8 text-xs">
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
