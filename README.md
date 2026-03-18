# TIX Terminal

Aplikacja do zarządzania portfelem inwestycyjnym IKE/IKZE. Import transakcji z Bossa.pl, mBank, DEGIRO i XTB, automatyczne pobieranie kursów, analiza wyników i porównanie z benchmarkami.

## Funkcje

- **Multi-portfel** — obsługa wielu portfeli (IKE, IKZE) z osobnymi bazami danych
- **Import CSV/XLSX** — automatyczny import transakcji z Bossa.pl, mBank, DEGIRO i XTB
- **Auto-rozpoznawanie ISIN** — automatyczne mapowanie kodów ISIN na tickery (Yahoo Finance, Stooq)
- **Dashboard** — wykres procentowej zmiany portfela vs benchmark (S&P 500, NASDAQ, WIG20, mWIG40, sWIG80)
- **MWR/TWR** — przełączanie między Money-Weighted Return i Time-Weighted Return
- **Portfel** — otwarte pozycje z bieżącymi kursami, P/L, udziałami + wolna gotówka z podziałem na waluty
- **Transakcje zamknięte** — historia zamkniętych pozycji (FIFO) z P/L
- **Dywidendy** — przegląd otrzymanych dywidend
- **Waluty** — historia przewalutowań
- **Gotówka** — historia wpłat i wypłat z limitem IKE/IKZE
- **Statystyki** — XIRR, CAGR, Sharpe Ratio, Sortino Ratio, Max Drawdown, Volatility
- **Multi-waluta** — PLN, USD, CAD, EUR z automatycznym przeliczaniem kursów FX
- **Dark mode** — ciemny interfejs (domyślny)

## Wymagania

### Node.js 20+

Pobrać i zainstalować z [nodejs.org](https://nodejs.org/) (wersja LTS). npm jest dołączony do instalacji Node.js.

Sprawdzenie wersji:
```bash
node --version   # powinno być v20 lub nowsze
npm --version    # powinno być 9 lub nowsze
```

### Narzędzia kompilacji C++

Wymagane przez pakiet `better-sqlite3` (natywna baza danych SQLite).

**Windows:**
1. Pobrać [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. W instalatorze wybrać workload **"Programowanie klasycznych aplikacji w C++"**
3. Alternatywnie: uruchomić PowerShell jako administrator i wykonać:
   ```powershell
   npm install --global windows-build-tools
   ```

**macOS:**
```bash
xcode-select --install
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install build-essential python3
```

## Instalacja

Pobranie kodu wymaga [Git](https://git-scm.com/). Można też pobrać ZIP z GitHub.

```bash
git clone https://github.com/pulos-lab/ike-terminal.git
cd ike-terminal
npm install
```

## Uruchomienie

### Opcja 1: npm (wszystkie systemy)

```bash
npm run dev
```

Serwer startuje na `http://localhost:3001`, klient na `http://localhost:5173`.

### Opcja 2: Double-click (macOS)

Kliknij dwukrotnie plik `start.command` — uruchomi serwer, klienta i otworzy przeglądarkę.

### Opcja 3: Double-click (Windows)

Kliknij dwukrotnie plik `start.bat` — uruchomi serwer, klienta i otworzy przeglądarkę.

## Tech Stack

- **Frontend:** React 19, Vite, TailwindCSS 4, shadcn/ui, lightweight-charts, React Router 7, TanStack Query
- **Backend:** Express, TypeScript, better-sqlite3
- **Dane rynkowe:** Yahoo Finance API, Stooq API
- **Monorepo:** npm workspaces (`shared`, `server`, `client`)

## Import danych

1. Wyeksportuj historię transakcji z brokera:
   - **Bossa.pl** — CSV: historia transakcji + operacje gotówkowe
   - **mBank** — CSV: historia transakcji
   - **DEGIRO** — CSV: historia transakcji
   - **XTB** — XLSX: eksport konta (transakcje, wpłaty, wypłaty w jednym pliku)
2. Kliknij **Import** w aplikacji
3. Wybierz dom maklerski (lub zostaw "Auto-detekcja")
4. Wybierz plik CSV lub XLSX
5. Aplikacja automatycznie rozpozna papiery i pobierze kursy

## Struktura projektu

```
ike-terminal/
  shared/          # Typy TypeScript, stałe (benchmarki, aliasy)
  server/          # Express API, SQLite, portfolio engine
    src/
      db/          # Repozytoria bazy danych
      routes/      # Endpointy API
      services/    # Logika biznesowa (portfolio-engine, yahoo, stooq)
      parsers/     # Parsery CSV/XLSX (Bossa, mBank, DEGIRO, XTB)
  client/          # React SPA
    src/
      components/  # Komponenty UI (dashboard, portfolio, import...)
      lib/         # API client, formattery, kontekst
  data/            # Bazy danych SQLite (gitignored)
```

## Licencja

MIT
