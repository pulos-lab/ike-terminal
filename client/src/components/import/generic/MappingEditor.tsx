import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Trash2, Wand2 } from 'lucide-react';
import {
  ROW_CLASS_LABELS,
  RULE_CLASSES,
  suggestRules,
  type DraftClassifyRule,
  type ProfileDraft,
} from '@/lib/generic-profile-builder';
import {
  ColumnSelect,
  DateFormatHint,
  DateFormatSelect,
  Field,
  FIELD_GRID,
  SELECT_TRIGGER,
  ValueColumnHint,
} from './mapping-fields';
import { SideMapping } from './SideMapping';

/**
 * Edytor mapowania kolumn — ręczna ścieżka kreatora importu uniwersalnego.
 * Dropdowny kolumn pokazują przykładową wartość z (zredagowanej) próbki.
 * Tryby: „same transakcje" (każdy wiersz z datą = transakcja) i „reguły"
 * (klasyfikacja wierszy: kolumna • operator • wartości → typ).
 */

interface Props {
  draft: ProfileDraft;
  sampleRows: string[][];
  onChange: (next: ProfileDraft) => void;
}

const OPERATOR_LABELS: Record<DraftClassifyRule['op'], string> = {
  contains: 'zawiera',
  equals: 'równa się',
  startsWith: 'zaczyna się od',
  notEmpty: 'niepusta',
};

export function MappingEditor({ draft, sampleRows, onChange }: Props) {
  const set = (patch: Partial<ProfileDraft>) => onChange({ ...draft, ...patch });
  const setTrade = (patch: Partial<ProfileDraft['trade']>) =>
    onChange({ ...draft, trade: { ...draft.trade, ...patch } });
  const setCash = (patch: Partial<ProfileDraft['cash']>) =>
    onChange({ ...draft, cash: { ...draft.cash, ...patch } });

  const updateRule = (index: number, patch: Partial<DraftClassifyRule>) =>
    set({ classify: draft.classify.map((r, i) => (i === index ? { ...r, ...patch } : r)) });

  const addRule = () =>
    set({
      classify: [
        ...draft.classify,
        {
          id: `rule-${draft.classify.length + 1}-${draft.classify.length}`,
          colIndex: draft.cash.descriptionCol >= 0 ? draft.cash.descriptionCol : 0,
          op: 'contains',
          values: '',
          emit: 'deposit',
        },
      ],
    });

  /** P4: zasiej reguły z unikalnych wartości kolumny opisu (dla plików operacji). */
  const suggestRulesFromDescription = () => {
    const { descriptionCol, rules } = suggestRules(draft.headers, sampleRows);
    const existing = new Set(draft.classify.map((r) => r.emit));
    const added = rules
      .filter((r) => !existing.has(r.emit))
      .map((r, k) => ({ ...r, id: `rule-seed-${k}-${draft.classify.length}` }));
    if (added.length === 0) return;
    set({
      classify: [...draft.classify, ...added],
      cash: {
        ...draft.cash,
        descriptionCol: draft.cash.descriptionCol >= 0 ? draft.cash.descriptionCol : descriptionCol,
      },
    });
  };

  const colProps = { headers: draft.headers, sampleRows };

  const emitsTrade = draft.mode === 'all-trades' || draft.classify.some((r) => r.emit === 'trade');
  const emitsCash =
    draft.mode === 'rules' &&
    (draft.defaultClass === 'other' ||
      draft.classify.some((r) => r.emit !== 'trade' && r.emit !== 'skip'));

  return (
    <div className="space-y-5">
      <div className={FIELD_GRID}>
        <Field label="Nazwa brokera (etykieta)">
          <Input
            className="h-8 text-xs"
            placeholder="np. Trading 212"
            value={draft.brokerLabel}
            onChange={(e) => set({ brokerLabel: e.target.value })}
          />
        </Field>
        <Field label="Zawartość pliku">
          <Select
            value={draft.mode}
            onValueChange={(v) => set({ mode: v as ProfileDraft['mode'] })}
          >
            <SelectTrigger className={SELECT_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all-trades">Same transakcje kupna/sprzedaży</SelectItem>
              <SelectItem value="rules">Różne typy wierszy (reguły)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      {draft.mode === 'rules' && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">Reguły klasyfikacji wierszy</h4>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={suggestRulesFromDescription}
            >
              <Wand2 className="h-3.5 w-3.5 mr-1.5" />
              Zasugeruj reguły z opisu
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Pierwsza pasująca reguła wygrywa. Wiersze bez dopasowania:</span>
            <Select
              value={draft.defaultClass}
              onValueChange={(v) => set({ defaultClass: v as ProfileDraft['defaultClass'] })}
            >
              <SelectTrigger className="h-6 w-auto text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="skip">pomiń</SelectItem>
                <SelectItem value="other">importuj jako „inna operacja"</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.classify.map((rule, i) => (
            <div
              key={rule.id}
              // Telefon: kolumna w pierwszym wierszu, pod nią operator + wartości i typ + kosz.
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 max-sm:rounded-md max-sm:border max-sm:border-border max-sm:p-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)_auto]"
            >
              <div className="col-span-3 min-w-0 sm:col-span-1">
                <ColumnSelect
                  {...colProps}
                  value={rule.colIndex}
                  onValue={(v) => updateRule(i, { colIndex: v })}
                  allowNone={false}
                  placeholder="Kolumna"
                />
              </div>
              <Select
                value={rule.op}
                onValueChange={(v) => updateRule(i, { op: v as DraftClassifyRule['op'] })}
              >
                <SelectTrigger className={`${SELECT_TRIGGER} sm:w-32`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(OPERATOR_LABELS) as DraftClassifyRule['op'][]).map((op) => (
                    <SelectItem key={op} value={op}>
                      {OPERATOR_LABELS[op]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="col-span-2 h-8 text-xs sm:col-span-1"
                placeholder="wartości, po przecinku"
                disabled={rule.op === 'notEmpty'}
                value={rule.values}
                onChange={(e) => updateRule(i, { values: e.target.value })}
              />
              <Select
                value={rule.emit}
                onValueChange={(v) => updateRule(i, { emit: v as DraftClassifyRule['emit'] })}
              >
                <SelectTrigger className={`${SELECT_TRIGGER} max-sm:col-span-2`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULE_CLASSES.map((cls) => (
                    <SelectItem key={cls} value={cls}>
                      {ROW_CLASS_LABELS[cls]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                aria-label={`Usuń regułę ${i + 1}`}
                onClick={() => set({ classify: draft.classify.filter((_, idx) => idx !== i) })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addRule}>
            + Dodaj regułę
          </Button>
        </section>
      )}

      {emitsTrade && (
        <section className="space-y-3">
          <h4 className="text-sm font-semibold">Transakcje kupna/sprzedaży</h4>
          <div className={FIELD_GRID}>
            <Field label="Data transakcji">
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
                sampleRows={colProps.sampleRows}
                col={draft.trade.dateCol}
                format={draft.trade.dateFormat}
              />
            </Field>
            <Field label="Nazwa papieru / ticker">
              <ColumnSelect
                {...colProps}
                value={draft.trade.paperNameCol}
                onValue={(v) => setTrade({ paperNameCol: v })}
                allowNone={false}
              />
            </Field>
            <Field label="ISIN (opcjonalnie)">
              <ColumnSelect
                {...colProps}
                value={draft.trade.isinCol}
                onValue={(v) => setTrade({ isinCol: v })}
              />
            </Field>
            <Field label="Ilość">
              <ColumnSelect
                {...colProps}
                value={draft.trade.quantityCol}
                onValue={(v) => setTrade({ quantityCol: v })}
                allowNone={false}
              />
            </Field>
            <Field label="Cena">
              <ColumnSelect
                {...colProps}
                value={draft.trade.priceCol}
                onValue={(v) => setTrade({ priceCol: v })}
                allowNone={false}
              />
            </Field>
            <Field label="Wartość (opcjonalnie — inaczej ilość×cena)">
              <ColumnSelect
                {...colProps}
                value={draft.trade.valueCol}
                onValue={(v) => setTrade({ valueCol: v })}
              />
              <ValueColumnHint
                sampleRows={sampleRows}
                quantityCol={draft.trade.quantityCol}
                priceCol={draft.trade.priceCol}
                valueCol={draft.trade.valueCol}
              />
            </Field>
            <Field label="Prowizja (opcjonalnie)">
              <ColumnSelect
                {...colProps}
                value={draft.trade.commissionCol}
                onValue={(v) => setTrade({ commissionCol: v })}
              />
            </Field>
            <Field label="Waluta">
              <ColumnSelect
                {...colProps}
                value={draft.trade.currencyCol}
                onValue={(v) => setTrade({ currencyCol: v })}
              />
            </Field>
            <Field label="Waluta domyślna (gdy komórka pusta)">
              <Input
                className="h-8 text-xs uppercase"
                maxLength={3}
                value={draft.trade.currencyFallback}
                onChange={(e) => setTrade({ currencyFallback: e.target.value })}
              />
            </Field>
          </div>

          <SideMapping draft={draft} sampleRows={sampleRows} setTrade={setTrade} />

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.trade.wholeShares}
              onChange={(e) => setTrade({ wholeShares: e.target.checked })}
            />
            Zaokrąglaj ilość do pełnych sztuk (GPW/NewConnect)
          </label>
        </section>
      )}

      {emitsCash && (
        <section className="space-y-3">
          <h4 className="text-sm font-semibold">Operacje gotówkowe</h4>
          <p className="text-xs text-muted-foreground">
            Wspólne mapowanie dla wszystkich typów operacji z reguł powyżej.
          </p>
          <div className={FIELD_GRID}>
            <Field label="Data operacji">
              <ColumnSelect
                {...colProps}
                value={draft.cash.dateCol}
                onValue={(v) => setCash({ dateCol: v })}
                allowNone={false}
              />
            </Field>
            <Field label="Format daty">
              <DateFormatSelect
                value={draft.cash.dateFormat}
                onValue={(v) => setCash({ dateFormat: v })}
              />
              <DateFormatHint
                sampleRows={colProps.sampleRows}
                col={draft.cash.dateCol}
                format={draft.cash.dateFormat}
              />
            </Field>
            <Field label="Kwota (ze znakiem)">
              <ColumnSelect
                {...colProps}
                value={draft.cash.amountCol}
                onValue={(v) => setCash({ amountCol: v })}
                allowNone={false}
              />
            </Field>
            <Field label="Waluta">
              <ColumnSelect
                {...colProps}
                value={draft.cash.currencyCol}
                onValue={(v) => setCash({ currencyCol: v })}
              />
            </Field>
            <Field label="Opis (opcjonalnie)">
              <ColumnSelect
                {...colProps}
                value={draft.cash.descriptionCol}
                onValue={(v) => setCash({ descriptionCol: v })}
              />
            </Field>
            <Field label="Ticker dla dywidend (opcjonalnie)">
              <ColumnSelect
                {...colProps}
                value={draft.cash.tickerCol}
                onValue={(v) => setCash({ tickerCol: v })}
              />
            </Field>
            <Field label="Waluta domyślna (gdy komórka pusta)">
              <Input
                className="h-8 text-xs uppercase"
                maxLength={3}
                value={draft.cash.currencyFallback}
                onChange={(e) => setCash({ currencyFallback: e.target.value })}
              />
            </Field>
          </div>
        </section>
      )}
    </div>
  );
}
