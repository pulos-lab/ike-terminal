/**
 * Katalog wartości kolumny `Action` w eksporcie Trading 212.
 *
 * KLUCZOWA ZASADA: klasyfikujemy po PEŁNEJ liście dozwolonych wartości, nigdy
 * po prefiksie. W próbkach Sidekicka istnieje wiersz `Market look`, który
 * wygląda identycznie jak `Market buy` (ten sam NVDA, ta sama ilość i cena) —
 * i jest tam trzymany w katalogu `Invalid/` właśnie jako przypadek do
 * odrzucenia. Dopasowanie „zaczyna się od Market" zaimportowałoby go jako
 * zakup. Nierozpoznany typ idzie do kwarantanny, gdzie użytkownik może go
 * sklasyfikować — nigdy nie zgadujemy.
 *
 * Wyjątek od reguły pełnego dopasowania: `Dividend (…)`, bo T212 wpisuje
 * podtyp dywidendy w nawiasie ("Dividend (Dividend)", "Dividend (Dividends
 * paid by us corporations)") i lista wariantów jest otwarta. Dlatego rodzina
 * dywidend jest rozpoznawana po członie przed nawiasem, ale `Dividend
 * adjustment` sprawdzamy WCZEŚNIEJ, żeby nie wpadło w tę gałąź.
 */

export type T212Action =
  | { kind: 'trade'; side: 'K' | 'S' }
  /** Przydział akcji bez zapłaty (cena 0) — dywidenda w akcjach, dystrybucja. */
  | { kind: 'share_grant' }
  | { kind: 'dividend' }
  | { kind: 'dividend_adjustment' }
  | { kind: 'cash'; direction: 'in' | 'out' }
  | { kind: 'interest' }
  | { kind: 'fx' }
  | { kind: 'split'; leg: 'open' | 'close' }
  | { kind: 'transfer_out' };

const TRADES: Record<string, 'K' | 'S'> = {
  'market buy': 'K',
  'limit buy': 'K',
  'stop buy': 'K',
  'equity rights': 'K',
  'market sell': 'S',
  'limit sell': 'S',
  'stop sell': 'S',
};

const SHARE_GRANTS = new Set(['scrip stock dividends', 'stock distribution']);

/** Karta płatnicza T212 — patrz komentarz przy `cash` niżej. */
const CASH_IN = new Set(['deposit', 'card credit', 'spending cashback']);
const CASH_OUT = new Set(['withdrawal', 'card debit']);

const INTEREST = new Set(['interest on cash', 'lending interest']);

/**
 * Karta płatnicza księgowana jest jako wpłata/wypłata, a nie jako koszt.
 *
 * Wydatek kartą to pieniądz opuszczający rachunek na konsumpcję — nie jest
 * kosztem inwestycyjnym. Jako przepływ zewnętrzny jest neutralizowany w TWR
 * i MWR, więc NIE zaburza stopy zwrotu, a saldo gotówki zostaje prawidłowe.
 * Pominięcie tych wierszy zawyżałoby saldo o sumę wydatków.
 */
export function classifyT212Action(raw: string | undefined): T212Action | null {
  if (!raw) return null;
  const a = raw.trim().toLowerCase();

  // PRZED rodziną "dividend …" — inaczej korekta wpadłaby w dywidendy.
  if (a === 'dividend adjustment') return { kind: 'dividend_adjustment' };

  const side = TRADES[a];
  if (side) return { kind: 'trade', side };

  if (SHARE_GRANTS.has(a)) return { kind: 'share_grant' };
  if (CASH_IN.has(a)) return { kind: 'cash', direction: 'in' };
  if (CASH_OUT.has(a)) return { kind: 'cash', direction: 'out' };
  if (INTEREST.has(a)) return { kind: 'interest' };
  if (a === 'currency conversion') return { kind: 'fx' };
  if (a === 'stock split open') return { kind: 'split', leg: 'open' };
  if (a === 'stock split close') return { kind: 'split', leg: 'close' };
  if (a === 'transfer out') return { kind: 'transfer_out' };

  // "Dividend" / "Dividend (cokolwiek)" — podtyp w nawiasie jest otwartą listą.
  if (a === 'dividend' || a.startsWith('dividend (')) return { kind: 'dividend' };

  return null;
}
