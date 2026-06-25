import type { ProfileLint } from 'shared';

/**
 * Panel lintów podglądu — uwidacznia „ciche" błędy profilu (waluta rozliczenia
 * przyjęta zamiast mapowanej, brak godziny, ticker z regexa, wysoki odsetek
 * pominięć), których nie widać w samych liczbach. Doradczy: NIE blokuje commitu.
 * Wspólny dla kreatora (PreviewTable) i panelu kuracji admina (dry-run).
 */
export function LintsPanel({ lints, className }: { lints?: ProfileLint[]; className?: string }) {
  if (!lints || lints.length === 0) return null;
  const warningCount = lints.filter((l) => l.severity === 'warning').length;
  const hasWarning = warningCount > 0;

  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        hasWarning ? 'border-warning/30 bg-warning/5' : 'border-border bg-muted/30'
      } ${className ?? ''}`}
    >
      <p className={`text-xs font-semibold ${hasWarning ? 'text-warning' : 'text-muted-foreground'}`}>
        {hasWarning ? `Do sprawdzenia przed zatwierdzeniem (${warningCount})` : 'Uwagi do profilu'}
      </p>
      <ul className="mt-1 space-y-1">
        {lints.map((l, i) => (
          <li key={`${l.code}-${l.sheet ?? ''}-${i}`} className="flex gap-2 text-xs">
            <span
              aria-hidden
              className={l.severity === 'warning' ? 'text-warning' : 'text-muted-foreground'}
            >
              {l.severity === 'warning' ? '⚠' : 'ℹ'}
            </span>
            <span className="text-foreground/90">
              {l.sheet && <span className="font-medium">[{l.sheet}] </span>}
              {l.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
