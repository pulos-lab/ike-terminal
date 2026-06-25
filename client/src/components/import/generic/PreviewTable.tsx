import { useMemo, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDate, formatQuantity } from '@/lib/formatters';
import type { GenericPreviewResult, SkipReason } from 'shared';
import { SKIP_REASON_LABELS } from '@/lib/import-labels';
import { OperationTypeBadge } from './ClassBadge';
import { LintsPanel } from './LintsPanel';

/**
 * Podgląd wyniku profilu PRZED importem — obowiązkowy krok kreatora.
 * Trzy zakładki: transakcje, operacje gotówkowe (z badge typu), pominięte
 * wiersze z powodem. Duże pliki: pokazujemy pierwsze N wierszy + licznik.
 */

/** Limit renderowanych wierszy — podgląd ma dać pewność mapowania, nie pełny audyt. */
const DISPLAY_LIMIT = 200;

interface Props {
  result: GenericPreviewResult;
}

export function PreviewTable({ result }: Props) {
  const txTotal = result.transactions?.total ?? 0;
  const opsTotal = result.operations?.total ?? 0;
  const skipped = useMemo(
    () => [...(result.transactions?.skipped ?? []), ...(result.operations?.skipped ?? [])],
    [result],
  );
  // Domyślna zakładka: ta, w której coś jest.
  const [tab, setTab] = useState(txTotal > 0 ? 'tx' : opsTotal > 0 ? 'ops' : 'skipped');

  const txRows = (result.transactions?.sample ?? []).slice(0, DISPLAY_LIMIT);
  const opsRows = (result.operations?.sample ?? []).slice(0, DISPLAY_LIMIT);
  const skippedRows = skipped.slice(0, DISPLAY_LIMIT);

  return (
    <div className="space-y-3">
      <LintsPanel lints={result.lints} />
      <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="tx">Transakcje ({txTotal})</TabsTrigger>
        <TabsTrigger value="ops">Operacje ({opsTotal})</TabsTrigger>
        <TabsTrigger value="skipped">Pominięte ({skipped.length})</TabsTrigger>
      </TabsList>

      <TabsContent value="tx">
        {txRows.length === 0 ? (
          <EmptyNote text="Profil nie wyemitował żadnych transakcji." />
        ) : (
          <ScrollBox>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Papier</TableHead>
                  <TableHead>Strona</TableHead>
                  <TableHead className="text-right">Ilość</TableHead>
                  <TableHead className="text-right">Cena</TableHead>
                  <TableHead className="text-right">Wartość</TableHead>
                  <TableHead>Waluta</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txRows.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDate(t.date)}
                    </TableCell>
                    <TableCell className="max-w-44 truncate text-xs" title={t.paperName}>
                      {t.paperName}
                    </TableCell>
                    <TableCell>
                      <Badge variant={t.side === 'K' ? 'success' : 'warning'}>
                        {t.side === 'K' ? 'Kupno' : 'Sprzedaż'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatQuantity(t.quantity)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {t.price.toLocaleString('pl-PL', { maximumFractionDigits: 4 })}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {t.value.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-xs">{t.currency}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <TruncationNote shown={txRows.length} total={txTotal} />
          </ScrollBox>
        )}
      </TabsContent>

      <TabsContent value="ops">
        {opsRows.length === 0 ? (
          <EmptyNote text="Profil nie wyemitował żadnych operacji gotówkowych." />
        ) : (
          <ScrollBox>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Typ</TableHead>
                  <TableHead className="text-right">Kwota</TableHead>
                  <TableHead>Waluta</TableHead>
                  <TableHead>Opis</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {opsRows.map((o, i) => (
                  <TableRow key={i}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDate(o.date)}
                    </TableCell>
                    <TableCell>
                      <OperationTypeBadge type={o.operationType} />
                    </TableCell>
                    <TableCell
                      className={`text-right text-xs tabular-nums ${o.amount < 0 ? 'text-destructive' : ''}`}
                    >
                      {o.amount.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-xs">{o.currency}</TableCell>
                    <TableCell
                      className="max-w-56 truncate text-xs text-muted-foreground"
                      title={o.description}
                    >
                      {o.ticker ? `${o.ticker} · ` : ''}
                      {o.description}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <TruncationNote shown={opsRows.length} total={opsTotal} />
          </ScrollBox>
        )}
      </TabsContent>

      <TabsContent value="skipped">
        {skippedRows.length === 0 ? (
          <EmptyNote text="Żaden wiersz nie został pominięty." />
        ) : (
          <ScrollBox>
            <ul className="space-y-1 text-xs">
              {skippedRows.map((s, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <span className="text-muted-foreground tabular-nums shrink-0">
                    wiersz {s.row}
                  </span>
                  {s.paperName && <span className="truncate max-w-48">{s.paperName}</span>}
                  <span className="text-muted-foreground">
                    — {SKIP_REASON_LABELS[s.reason as SkipReason] ?? s.reason}
                  </span>
                </li>
              ))}
            </ul>
            <TruncationNote shown={skippedRows.length} total={skipped.length} />
          </ScrollBox>
        )}
      </TabsContent>
      </Tabs>
    </div>
  );
}

function ScrollBox({ children }: { children: React.ReactNode }) {
  return <div className="max-h-72 overflow-y-auto rounded-md border">{children}</div>;
}

function EmptyNote({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

function TruncationNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="px-3 py-2 text-xs text-muted-foreground">
      Pokazano pierwsze {shown} z {total} pozycji.
    </p>
  );
}
