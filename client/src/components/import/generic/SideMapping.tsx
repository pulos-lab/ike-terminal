import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  assignSideValue,
  sideAssignmentOf,
  sideColumnValues,
  sideValuesForColumn,
  type ProfileDraft,
  type SideAssignment,
} from '@/lib/generic-profile-builder';
import { ColumnSelect, Field, FIELD_GRID, SELECT_TRIGGER } from './mapping-fields';

/**
 * Mapowanie strony transakcji (kupno/sprzedaż) — wspólne dla pełnego
 * `MappingEditor` i karty luk `GapFields`.
 *
 * Dla strategii „osobna kolumna" pokazuje WARTOŚCI wskazanej kolumny wzięte z
 * pliku i pozwala każdą przypisać kliknięciem. Wcześniej trzeba je było przepisać
 * z pliku do pola tekstowego, a kreator podstawiał „K, BUY, Kupno" także wtedy,
 * gdy w kolumnie były np. „dopłata roczna" / „wpłata pracownika" — podgląd
 * odrzucał wtedy wszystkie wiersze bez wskazówki, co poprawić.
 */

/** Powyżej tylu różnych wartości kolumna raczej nie opisuje strony — nie zalewamy formularza. */
const MAX_LISTED_VALUES = 12;

const ASSIGNMENTS: Array<{ key: SideAssignment; label: string; active: string }> = [
  { key: 'buy', label: 'Kupno', active: 'border-success/40 bg-success/15 text-success' },
  { key: 'sell', label: 'Sprzedaż', active: 'border-loss/40 bg-loss/15 text-loss' },
  { key: 'skip', label: 'Pomiń', active: 'border-border bg-muted text-foreground' },
];

interface Props {
  draft: ProfileDraft;
  sampleRows: string[][];
  setTrade: (patch: Partial<ProfileDraft['trade']>) => void;
}

export function SideMapping({ draft, sampleRows, setTrade }: Props) {
  const t = draft.trade;
  const byColumn = t.sideStrategy === 'column';
  const values = byColumn ? sideColumnValues(sampleRows, t.sideCol) : [];
  const listed = values.slice(0, MAX_LISTED_VALUES);
  const hidden = values.length - listed.length;

  /** Czy bieżące listy kupna/sprzedaży dotyczą wskazanej kolumny (trafiają w jej wartości). */
  const listsFitColumn = (col: number) =>
    sideColumnValues(sampleRows, col).some((v) => sideAssignmentOf(t, v) !== 'skip');

  return (
    <div className={FIELD_GRID}>
      <Field label="Skąd wiadomo, że to kupno czy sprzedaż?">
        <Select
          value={t.sideStrategy}
          onValueChange={(v) => {
            const sideStrategy = v as ProfileDraft['trade']['sideStrategy'];
            // Wejście w tryb kolumny: listy niepasujące do niej (np. domyślne K/S przy
            // kolumnie ilości) zastąp rozpoznanymi w niej wartościami albo pustymi.
            if (sideStrategy === 'column' && !listsFitColumn(t.sideCol)) {
              return setTrade({ sideStrategy, ...sideValuesForColumn(sampleRows, t.sideCol) });
            }
            setTrade({ sideStrategy });
          }}
        >
          <SelectTrigger className={SELECT_TRIGGER}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="column">Osobna kolumna (K/S, BUY/SELL…)</SelectItem>
            <SelectItem value="signedQuantity">Znak ilości (−5 = sprzedaż)</SelectItem>
            <SelectItem value="signedAmount">Znak kwoty (wydatek = kupno)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={byColumn ? 'W której kolumnie jest kupno/sprzedaż?' : 'Kolumna ze znakiem (+/−)'}>
        <ColumnSelect
          headers={draft.headers}
          sampleRows={sampleRows}
          value={t.sideCol}
          onValue={(v) => {
            if (!byColumn) return setTrade({ sideCol: v });
            // Wartości należą do kolumny — po jej zmianie zaczynamy od rozpoznanych w nowej.
            setTrade({ sideCol: v, ...sideValuesForColumn(sampleRows, v) });
          }}
          allowNone={false}
        />
      </Field>

      {byColumn && listed.length > 0 && (
        <div className="space-y-2 sm:col-span-2">
          <p className="text-xs text-muted-foreground">
            Wartości tej kolumny w pliku — zaznacz, co oznacza każda z nich. Wiersze z wartością
            „Pomiń” nie zostaną zaimportowane.
          </p>
          <ul className="space-y-1.5">
            {listed.map((value) => {
              const current = sideAssignmentOf(t, value);
              return (
                <li
                  key={value}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
                >
                  <span className="min-w-0 break-words text-xs font-medium">{value}</span>
                  <div role="group" aria-label={`Znaczenie wartości „${value}”`} className="flex">
                    {ASSIGNMENTS.map(({ key, label, active }) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={current === key}
                        onClick={() => setTrade(assignSideValue(t, value, key))}
                        className={cn(
                          'h-7 border px-2.5 text-xs transition-colors first:rounded-l-md last:rounded-r-md not-first:-ml-px',
                          'focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                          current === key
                            ? cn('z-[1] font-medium', active)
                            : 'border-input text-muted-foreground hover:bg-muted/60',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            {hidden > 0
              ? `…i ${hidden} kolejnych — ta kolumna ma dużo różnych wartości, sprawdź, czy to na pewno kolumna kupna/sprzedaży.`
              : 'Lista pochodzi z początku pliku. Jeśli dalej występują inne wartości, dopisz je poniżej.'}
          </p>
        </div>
      )}

      {byColumn && (
        <>
          <Field label="Wartości oznaczające kupno">
            <Input
              className="h-8 text-xs"
              placeholder="np. Kupno, BUY"
              value={t.buyValues}
              onChange={(e) => setTrade({ buyValues: e.target.value })}
            />
          </Field>
          <Field label="Wartości oznaczające sprzedaż">
            <Input
              className="h-8 text-xs"
              placeholder="puste, jeśli w pliku są same kupna"
              value={t.sellValues}
              onChange={(e) => setTrade({ sellValues: e.target.value })}
            />
          </Field>
        </>
      )}
    </div>
  );
}
