import type { BrokerType } from 'shared';

/**
 * Konfiguracja okna importu per broker — napędza dwuekranowy przepływ
 * (wybór kafelka → instrukcja + pola uploadu). Trzyma się z dala od logiki
 * parsowania: opisuje wyłącznie CO i JAK użytkownik ma wgrać.
 *
 * Nazwy plików (hisPW.csv, Account.csv, account_*.xlsx) są pewne — pochodzą
 * z parserów (server/src/parsers/*). Ścieżki w panelach brokerów to best-effort
 * i mogą wymagać dopracowania.
 */

/** Brokerzy ze znanym schematem importu (osobno od ścieżki „Inny broker"). */
export type KnownBroker = 'bossa' | 'mbank' | 'degiro' | 'xtb';

export type FileRole = 'transactions' | 'operations';

export interface FileSlot {
  role: FileRole;
  /** Etykieta pola (PL). */
  label: string;
  /** Filtr `accept` dla <input type=file>. */
  accept: string;
  /** Czy pole przyjmuje wiele plików (Bossa: eksport per waluta). */
  multiple: boolean;
  /** Czy plik jest wymagany do uruchomienia importu. */
  required: boolean;
  /** Podpowiedź pod polem — jaki dokładnie plik tu wgrać. */
  hint: string;
}

export interface BrokerImportConfig {
  /** Numerowane kroki eksportu z panelu brokera. */
  exportSteps: string[];
  files: FileSlot[];
  /** Krótka nota o formacie (kodowanie/separator) — drobnym drukiem. */
  formatNote?: string;
}

/** Kolejność i podpis kafelków na ekranie wyboru. */
export const BROKER_TILES: Array<{ id: KnownBroker | 'generic'; tagline: string }> = [
  { id: 'bossa', tagline: '2 pliki CSV (transakcje + operacje)' },
  { id: 'degiro', tagline: '2 pliki CSV (Transactions + Account)' },
  { id: 'mbank', tagline: '1 plik CSV (operacje opcjonalnie)' },
  { id: 'xtb', tagline: '1 plik XLSX' },
  { id: 'generic', tagline: 'Inny broker lub własny plik CSV' },
];

export const BROKER_IMPORT_CONFIG: Record<KnownBroker, BrokerImportConfig> = {
  bossa: {
    exportSteps: [
      'Zaloguj się do bossa.pl → zakładka Rachunek / Historia.',
      'Pobierz historię transakcji papierów wartościowych (plik o nazwie zaczynającej się od „hisPW"). Jeśli masz rachunki w kilku walutach, pobierz osobny plik dla każdej waluty.',
      'Pobierz historię finansową (operacje bez transakcji) — plik z „operacje_bez_transakcji" w nazwie.',
      'Wgraj oba poniżej i kliknij Importuj.',
    ],
    files: [
      {
        role: 'transactions',
        label: 'Transakcje (hisPW.csv)',
        accept: '.csv',
        multiple: true,
        required: true,
        hint: 'Bossa eksportuje historię osobno per waluta — wgraj wszystkie pliki naraz (np. hisPW-PLN.csv, hisPW-USD.csv).',
      },
      {
        role: 'operations',
        label: 'Operacje gotówkowe',
        accept: '.csv',
        multiple: false,
        required: true,
        hint: 'Plik historii finansowej: „…historia_finansowa_operacje_bez_transakcji…csv" (dywidendy, wpłaty, wymiany walut).',
      },
    ],
    formatNote: 'Format Bossa: CSV ze średnikami, kodowanie Windows-1250.',
  },

  degiro: {
    exportSteps: [
      'Zaloguj się do DEGIRO → menu Aktywność.',
      'W zakładce Transakcje wyeksportuj historię do CSV (plik „Transactions.csv").',
      'W zakładce Konto wyeksportuj historię konta do CSV (plik „Account.csv") — zawiera dywidendy, wpłaty/wypłaty i wymiany walut.',
      'Wgraj oba pliki poniżej i kliknij Importuj.',
    ],
    files: [
      {
        role: 'transactions',
        label: 'Transakcje (Transactions.csv)',
        accept: '.csv',
        multiple: false,
        required: true,
        hint: 'Eksport z zakładki Transakcje — kolumny Data, Produkt, ISIN, Liczba, Kurs…',
      },
      {
        role: 'operations',
        label: 'Konto (Account.csv)',
        accept: '.csv',
        multiple: false,
        required: true,
        hint: 'Eksport z zakładki Konto — dywidendy, podatki, wpłaty/wypłaty, wymiany FX.',
      },
    ],
    formatNote: 'Format DEGIRO: CSV z przecinkami, kodowanie UTF-8.',
  },

  mbank: {
    exportSteps: [
      'Zaloguj się do serwisu mBank → eMakler → Historia.',
      'Pobierz historię transakcji do pliku CSV.',
      'Opcjonalnie pobierz historię finansową (dywidendy, wpłaty) — bez niej zaimportujemy same transakcje.',
      'Wgraj plik(i) poniżej i kliknij Importuj.',
    ],
    files: [
      {
        role: 'transactions',
        label: 'Transakcje (eMakler)',
        accept: '.csv',
        multiple: false,
        required: true,
        hint: 'Historia transakcji eMakler — kolumny Czas transakcji, Papier, K/S, Liczba, Kurs…',
      },
      {
        role: 'operations',
        label: 'Operacje gotówkowe (opcjonalnie)',
        accept: '.csv',
        multiple: false,
        required: false,
        hint: 'Historia finansowa eMakler (dywidendy, wpłaty). Możesz pominąć — wtedy zaimportujemy same transakcje.',
      },
    ],
    formatNote: 'Format mBank: CSV ze średnikami, kodowanie Windows-1250.',
  },

  xtb: {
    exportSteps: [
      'Zaloguj się do xStation 5 → menu Historia / Raporty.',
      'Wyeksportuj pełny raport rachunku do pliku XLSX (nazwa zaczyna się od „account_…").',
      'Jeden plik zawiera transakcje, dywidendy, wpłaty i zamknięte pozycje CFD — wgraj go poniżej i kliknij Importuj.',
    ],
    files: [
      {
        role: 'transactions',
        label: 'Raport rachunku (account_*.xlsx)',
        accept: '.xlsx',
        multiple: false,
        required: true,
        hint: 'Plik XLSX z arkuszami „Cash Operations" i (opcjonalnie) „Closed Positions". Zawiera wszystko w jednym.',
      },
    ],
    formatNote: 'Format XTB: skoroszyt XLSX (Excel).',
  },
};

/** Etykiety kafelków — używamy BROKER_LABELS dla znanych + własna dla 'generic'. */
export const GENERIC_TILE_LABEL = 'Inny broker';

/** Czy dany id to znany broker z configiem. */
export function isKnownBroker(id: BrokerType | 'generic' | null): id is KnownBroker {
  return id === 'bossa' || id === 'mbank' || id === 'degiro' || id === 'xtb';
}
