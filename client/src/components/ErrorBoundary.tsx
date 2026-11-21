import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  children: ReactNode;
  /**
   * `page` (domyślnie) — pełnoekranowy komunikat, ostatnia deska dla całej aplikacji.
   * `inline` — komunikat w miejscu treści: nawigacja i nagłówek zostają, więc
   * błąd jednej strony nie odcina użytkownika od reszty aplikacji.
   * `silent` — nic nie renderuje (element pomocniczy powłoki, np. pasek metryk).
   */
  variant?: 'page' | 'inline' | 'silent';
  /**
   * Zmiana wartości czyści stan błędu. Dla granicy wokół treści strony podajemy
   * ścieżkę — przejście na inną zakładkę ma pokazać tę zakładkę, a nie wciąż
   * komunikat o błędzie poprzedniej.
   */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.handleReset();
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const variant = this.props.variant ?? 'page';
      if (variant === 'silent') return null;
      const inline = variant === 'inline';
      return (
        <div
          role="alert"
          className={cn(
            'flex flex-col items-center justify-center gap-4 p-8 text-center',
            inline ? 'min-h-[50vh]' : 'min-h-screen',
          )}
        >
          <AlertTriangle className={cn('text-destructive', inline ? 'h-10 w-10' : 'h-12 w-12')} />
          <h1 className={cn('font-bold', inline ? 'text-lg' : 'text-xl')}>
            {inline ? 'Nie udało się wyświetlić tej strony' : 'Wystąpił nieoczekiwany błąd'}
          </h1>
          <p className="text-muted-foreground max-w-md">
            {this.state.error?.message || 'Coś poszło nie tak.'}
          </p>
          {inline && (
            <p className="text-sm text-muted-foreground max-w-md">
              Pozostałe zakładki działają — możesz przejść dalej z menu.
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={this.handleReset}>Spróbuj ponownie</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Odśwież stronę
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
