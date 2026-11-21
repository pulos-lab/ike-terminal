import { CheckCircle2 } from 'lucide-react';
import type { DraftScore, ProfileDraft, ScoredField } from '@/lib/generic-profile-builder';
import { ColumnSelect, DateFormatHint, DateFormatSelect, Field, FIELD_GRID } from './mapping-fields';
import { SideMapping } from './SideMapping';

/**
 * Karta „uzupełnij brakujące pola" (gałąź NEAR kreatora). Pokazuje TYLKO pola,
 * których heurystyka nie zmapowała pewnie (`score.gaps`), oraz zielone potwierdzenie
 * pól rozpoznanych — żeby nie przytłaczać pełnym formularzem. Edytuje ten sam
 * `ProfileDraft` co pełny `MappingEditor`, więc „Pokaż podgląd" działa tak samo.
 */

const FIELD_LABELS: Record<ScoredField, string> = {
  date: 'Data transakcji',
  paperName: 'Nazwa papieru / ticker',
  quantity: 'Ilość',
  price: 'Cena',
  currency: 'Waluta',
  side: 'Kupno czy sprzedaż?',
};

interface Props {
  draft: ProfileDraft;
  sampleRows: string[][];
  score: DraftScore;
  onChange: (next: ProfileDraft) => void;
}

export function GapFields({ draft, sampleRows, score, onChange }: Props) {
  const setTrade = (patch: Partial<ProfileDraft['trade']>) =>
    onChange({ ...draft, trade: { ...draft.trade, ...patch } });
  const colProps = { headers: draft.headers, sampleRows };

  const recognized = (
    ['date', 'paperName', 'quantity', 'price', 'currency', 'side'] as ScoredField[]
  )
    .filter((f) => score.fields[f] === 'ok')
    .map((f) => FIELD_LABELS[f]);

  return (
    <div className="space-y-3">
      {recognized.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {recognized.map((label) => (
            <span key={label} className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              {label}
            </span>
          ))}
        </div>
      )}

      <div className={FIELD_GRID}>
        {score.gaps.map((field) => {
          if (field === 'side')
            return (
              <SideField key="side" draft={draft} sampleRows={sampleRows} setTrade={setTrade} />
            );
          if (field === 'date') {
            return (
              <div key="date" className="contents">
                <Field label={FIELD_LABELS.date}>
                  <ColumnSelect
                    {...colProps}
                    value={draft.trade.dateCol}
                    onValue={(v) => setTrade({ dateCol: v })}
                    allowNone={false}
                  />
                </Field>
                <Field label="Format daty">
                  <DateFormatSelect
                    value={draft.trade.dateFormat}
                    onValue={(v) => setTrade({ dateFormat: v })}
                  />
                  <DateFormatHint
                    sampleRows={sampleRows}
                    col={draft.trade.dateCol}
                    format={draft.trade.dateFormat}
                  />
                </Field>
              </div>
            );
          }
          if (field === 'currency') {
            return (
              <Field key="currency" label={FIELD_LABELS.currency}>
                <ColumnSelect
                  {...colProps}
                  value={draft.trade.currencyCol}
                  onValue={(v) => setTrade({ currencyCol: v })}
                />
              </Field>
            );
          }
          const map: Record<'paperName' | 'quantity' | 'price', keyof ProfileDraft['trade']> = {
            paperName: 'paperNameCol',
            quantity: 'quantityCol',
            price: 'priceCol',
          };
          const key = map[field as 'paperName' | 'quantity' | 'price'];
          return (
            <Field key={field} label={FIELD_LABELS[field]}>
              <ColumnSelect
                {...colProps}
                value={draft.trade[key] as number}
                onValue={(v) => setTrade({ [key]: v })}
                allowNone={false}
              />
            </Field>
          );
        })}
      </div>
    </div>
  );
}

/** Mini-formularz strony K/S w ramce ostrzeżenia — sam formularz dzieli z pełnym edytorem. */
function SideField({
  draft,
  sampleRows,
  setTrade,
}: {
  draft: ProfileDraft;
  sampleRows: string[][];
  setTrade: (patch: Partial<ProfileDraft['trade']>) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-warning/30 bg-warning/5 p-3 sm:col-span-2">
      <p className="text-xs text-muted-foreground">
        Nie rozpoznaliśmy automatycznie, które wiersze to kupno, a które sprzedaż — wskaż to
        poniżej.
      </p>
      <SideMapping draft={draft} sampleRows={sampleRows} setTrade={setTrade} />
    </div>
  );
}
