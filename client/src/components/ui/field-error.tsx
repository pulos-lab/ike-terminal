/**
 * Komunikat błędu walidacji pod polem formularza. Renderuje się tylko gdy błąd
 * istnieje (po pierwszej próbie submitu — patrz `useFormValidation`).
 * `role="alert"` ogłasza treść czytnikom ekranu w momencie pojawienia.
 */
export function FieldError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-destructive mt-1">
      {error}
    </p>
  );
}
