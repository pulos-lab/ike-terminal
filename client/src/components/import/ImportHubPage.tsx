import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { formatTimestampLocal } from '@/lib/formatters';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ImportDialog } from './ImportDialog';
import { OrphanedSellsSection } from './OrphanedSellsSection';
import { ReimportNoticesSection } from './ReimportNoticesSection';
import { QuarantineSection } from './quarantine/QuarantinePage';
import { GenericBatchesSection } from './generic/GenericBatchesSection';

/**
 * Hub importu (/app/import) — jedno miejsce na wszystko wokół importów:
 * wgrywanie (istniejący ImportDialog otwierany przyciskiem — sam przepływ
 * uploadu pozostaje modalny), skrzynka "Do wyjaśnienia" i poprzednie importy
 * uniwersalne (re-importy po korekcie mapowania przez admina).
 */
export function ImportHubPage() {
  const [importOpen, setImportOpen] = useState(false);

  const { data: importStatus } = useQuery({
    queryKey: QUERY_KEYS.importStatus,
    queryFn: api.getImportStatus,
  });
  const lastImport = importStatus?.lastImportDate
    ? formatTimestampLocal(importStatus.lastImportDate)
    : null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Import</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Wgrywaj eksporty brokerów i zarządzaj tym, czego import nie rozpoznał automatycznie.
          </p>
          {lastImport && (
            <p className="text-xs text-muted-foreground mt-1">Ostatni import: {lastImport}</p>
          )}
        </div>
        <Button onClick={() => setImportOpen(true)}>
          <Upload className="h-4 w-4" />
          Wgraj pliki
        </Button>
      </div>

      <Separator />

      {/* Najwyżej, bo wymaga akcji użytkownika, której nic innego nie zastąpi. */}
      <ReimportNoticesSection onUpload={() => setImportOpen(true)} />

      <OrphanedSellsSection />

      <QuarantineSection />

      <GenericBatchesSection />

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
