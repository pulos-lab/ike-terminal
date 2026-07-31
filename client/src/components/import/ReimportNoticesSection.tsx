import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
import { QUERY_KEYS } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Loader2, Upload } from 'lucide-react';

/**
 * Sekcja „Wgraj wyciąg ponownie" w hubie Importu.
 *
 * Pokazuje się tylko wtedy, gdy poprawka parsera NIE MOŻE naprawić danych
 * wstecznie — czyli gdy wiersze przy imporcie w ogóle nie powstały i nie ma ich
 * z czego odtworzyć. Wszystko, co da się poprawić w bazie, poprawiają skrypty
 * migracyjne i użytkownik nie widzi wtedy nic.
 *
 * Dotychczasowy mechanizm „do re-importu" (kropka przy Imporcie + przycisk
 * w `GenericBatchesSection`) obsługuje wyłącznie import uniwersalny, bo wiąże
 * batch z profilem. Parsery wbudowane nie miały jak o nic poprosić.
 */
export function ReimportNoticesSection({ onUpload }: { onUpload: () => void }) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: QUERY_KEYS.reimportNotices,
    queryFn: api.getReimportNotices,
  });

  const dismiss = useMutation({
    mutationFn: api.dismissReimportNotice,
    onSuccess: () => {
      toast.success('Prośba odłożona');
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.reimportNotices });
    },
    onError: errorToast,
  });

  const notices = data?.notices ?? [];
  if (notices.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <AlertTriangle className="size-5 text-warning" aria-hidden />
        Wgraj wyciąg ponownie
      </h2>

      {notices.map((notice) => (
        <div
          key={notice.id}
          className="rounded-lg border border-warning/40 bg-warning/5 p-4 space-y-2"
        >
          <p className="font-medium">
            {notice.source}: {notice.reason}
          </p>
          {notice.detail && <p className="text-sm text-muted-foreground">{notice.detail}</p>}
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={onUpload}>
              <Upload className="size-4" aria-hidden />
              Wgraj plik ponownie
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => dismiss.mutate(notice.id)}
              disabled={dismiss.isPending}
            >
              {dismiss.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Odłóż
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
