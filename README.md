# TIX Terminal

Aplikacja do zarządzania portfelem inwestycyjnym IKE/IKZE. Import transakcji z Bossa.pl, mBank, DEGIRO i XTB, automatyczne pobieranie kursów, analiza wyników, porównanie z benchmarkami oraz obsługa splitów akcji, dywidend, CFD i limitów IKE/IKZE.

## Funkcje

### Portfel i analiza
- **Multi-portfel** — wiele portfeli (IKE, IKZE, IKZE-JDG, maklerskie) z osobnymi bazami SQLite
- **Dashboard** — wykres procentowej zmiany portfela vs benchmark, metryki kluczowe, porównanie wyników
- **MWR / TWR** — przełączanie między Money-Weighted Return i Time-Weighted Return
- **Portfel** — otwarte pozycje z bieżącymi kursami, P/L, udziałami + wolna gotówka z podziałem na waluty
- **Transakcje zamknięte** — historia zamkniętych pozycji (FIFO) z P/L w walucie transakcji i PLN
- **Dywidendy** — przegląd otrzymanych dywidend, netting z WHT, tabele podatkowe (reg + IKE/IKZE)
- **Waluty** — historia przewalutowań FX + saldo w każdej walucie
- **Gotówka** — historia wpłat/wypłat z automatycznym egzekwowaniem limitów IKE / IKZE / IKZE-JDG (dane 2012–2026)
- **Inne koszty** — panel opłat/prowizji/odsetek, gdy występują w portfelu
- **Statystyki** — XIRR, CAGR, Sharpe Ratio, Sortino Ratio, Max Drawdown, Volatility

### Import i dane rynkowe
- **Import CSV / XLSX** — auto-detekcja formatu brokera; atomic bulk import wielu plików na raz
- **Brokerzy** — Bossa.pl (CSV), mBank eMakler (CSV), DEGIRO (CSV), XTB (XLSX + stare formaty CSV)
- **Auto-resolve ISIN** — mapowanie ISIN → ticker przez Yahoo Finance, Stooq i statyczne mapy offline (NewConnect, CFD, aliasy)
- **Ostrzeżenia importu** — parser XTB raportuje ciche fallbacki waluty, nieznane instrumenty CFD i brak metadanych konta
- **Orphaned sells** — wykrywanie sprzedaży bez odpowiadającego kupna (spin-offy, wezwania, IPO) + automatyczne sugestie uzupełnienia
- **Instrumenty** — akcje GPW, NewConnect, NYSE, NASDAQ, XETRA, TSX, LSE; ETF; CFD (akcje / surowce / indeksy / forex / krypto)
- **Ceny live i historyczne** — 3-warstwowy cache: in-memory → SQLite → sieć; fallback Yahoo ↔ Stooq
- **Auto-split detection** — wykrywanie splitów (min. 2:1) z automatyczną retro-korektą transakcji i inwalidacją cache

### Benchmarki
- Polskie: **WIG**, **WIG20**, **mWIG40**, **sWIG80** (Stooq + seed z CSV, auto-update co 6h)
- Zagraniczne: **S&P 500**, **NASDAQ** (Yahoo Finance)

### Waluty
PLN, USD, CAD, EUR, GBP, NOK, HKD, JPY, CHF, SEK, DKK, AUD, SGD, CZK, MXN — automatyczne pobieranie kursów FX z Yahoo (`USDPLN=X`, `EURPLN=X` itd.).

### Autentykacja i konta
- **Better Auth** — email + hasło z obowiązkową weryfikacją przez OTP (kod na email, Resend API)
- **Google SSO** — opcjonalny login przez konto Google
- **Zmiana hasła / odzyskiwanie hasła** — flow z OTP
- **Rate limiting** — ochrona przed brute-force na login/OTP
- **Multi-tenant** — automatyczne utworzenie portfela na rejestracji, bazy SQLite izolowane per user

### UI
- **Dark mode** domyślny + jasny motyw
- **Responsywny layout** — sidebar na desktop, bottom tab bar na mobile
- **Landing page** — publiczna strona z interaktywnym demo
- **Bug reporter** — wbudowany dialog zgłaszania błędów + panel administracyjny

## Wymagania

### Node.js 24+

Pobrać i zainstalować z [nodejs.org](https://nodejs.org/) (wersja LTS). npm jest dołączony.

```bash
node --version   # powinno być v24 lub nowsze
npm --version    # powinno być 10 lub nowsze
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

## Konfiguracja (zmienne środowiskowe)

Skopiuj szablon i uzupełnij wartości:

```bash
cp .env.example .env
```

Zmienne w `.env`:

| Zmienna | Opis | Wymagane |
|---|---|---|
| `NODE_ENV` | `development` lub `production` | nie (domyślnie development) |
| `PORT` | Port serwera (default 3001) | nie |
| `DATA_DIR` | Absolutna ścieżka do katalogu baz SQLite | nie (domyślnie `./data`) |
| `CORS_ORIGIN` | URL frontendu (np. `https://tixterminal.app`) | nie (domyślnie `http://localhost:5173`) |
| `AUTH_SECRET` | Sekret Better Auth — `openssl rand -base64 32` | **tak** w produkcji (min 32 znaki) |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | opcjonalne (bez — brak SSO) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret | jeśli używasz Google SSO |
| `RESEND_API_KEY` | Klucz [Resend](https://resend.com) do OTP emaili | **tak** do weryfikacji email |
| `EMAIL_FROM` | Adres nadawcy OTP | nie (domyślny ustawiony) |

W trybie development aplikacja startuje z domyślnymi wartościami — **produkcja wymaga ustawionego `AUTH_SECRET` i `RESEND_API_KEY`**.

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

### Build produkcyjny

```bash
npm run build          # wszystkie workspace (shared → server → client)
npm run seed -w server # (opcjonalnie) inicjalizacja bazy
npm run seed-benchmarks -w server  # seed historycznych benchmarków WIG*
```

## Tech Stack

- **Frontend:** React 19, Vite 7, TailwindCSS 4, shadcn/ui + Radix UI, TanStack Query 5, React Router 7, Zustand 5, lightweight-charts 5, Recharts 3, lucide-react
- **Backend:** Express 4, TypeScript, better-sqlite3 12, Better Auth 1.5, Resend 6 (email), express-rate-limit, Helmet
- **Parsery:** PapaParse (CSV), ExcelJS (XLSX)
- **Dane rynkowe:** yahoo-finance2, Stooq API
- **Monorepo:** npm workspaces (`shared`, `server`, `client`)
- **CI/CD:** GitHub Actions (deploy via SSH + rsync)

## Import danych

1. Wyeksportuj historię transakcji z brokera:
   - **Bossa.pl** — CSV: historia transakcji + operacje gotówkowe (średnik, Windows-1250)
   - **mBank eMakler** — CSV: historia transakcji GPW + zagranicznych (średnik, Windows-1250)
   - **DEGIRO** — CSV: historia transakcji multi-currency (przecinek, UTF-8)
   - **XTB** — XLSX: pełny eksport konta z arkuszami `CASH OPERATION HISTORY` i `Closed Positions` (transakcje, wpłaty, wypłaty, dywidendy, CFD)
2. Kliknij **Import** w aplikacji
3. Wybierz dom maklerski (lub zostaw "Auto-detekcja")
4. Wybierz plik(i) — można dodać wiele plików z różnych brokerów naraz
5. Aplikacja automatycznie rozpozna papiery (ISIN resolver), pobierze kursy i sprawdzi duplikaty
6. Przy niejednoznacznościach (nieznane ISIN-y, sprzedaż bez kupna, nieznane CFD) pokaże ostrzeżenia i umożliwi korektę

## Struktura projektu

```
ike-terminal/
  shared/              # Typy i stałe wspólne dla server/client
    src/
      types.ts                  # Transaction, Position, Portfolio, ImportResult
      constants.ts              # BENCHMARKS, tabele podatkowe
      ike-ikze-limits.ts        # Historia limitów 2012–2026
      ticker-map.ts             # Statyczny seed tickerów
      nc-ticker-map.ts          # NewConnect offline fallback (~800 spółek)
      cfd-ticker-map.ts         # Mapa CFD → Yahoo futures
      isin-aliases-map.ts       # Aliasy ISIN (splity emitenta itp.)
      tender-offers-map.ts      # Wezwania do sprzedaży
      ipo-subscriptions-map.ts  # IPO (Bossa reconciliation)
  server/              # Express API + SQLite + silnik portfela
    src/
      auth.ts                   # Better Auth + Resend config
      config.ts                 # Zmienne środowiskowe
      db/                       # Repozytoria (transactions, operations, splits, ticker_map)
      middleware/               # Auth guard, rate-limit, error handler
      parsers/                  # Bossa, mBank, DEGIRO, XTB + registry auto-detekcji
      routes/                   # portfolio, import, prices, bug-reports
      services/                 # portfolio-engine, isin-resolver, yahoo, stooq, split-detector, import-service
  client/              # React SPA
    src/
      components/
        auth/                   # Login, OTP, forgot password, change password
        dashboard/              # Wykres, metryki, porównanie benchmark
        portfolio/              # Otwarte pozycje + diversification
        transactions/           # Trades feed, closed trades, dividend scanner
        dividends/ cash/ currency/ costs/
        import/                 # ImportDialog z obsługą wielu plików
        landing/                # Publiczna strona + demo
        admin/                  # Panel zgłoszeń błędów
        layout/                 # AppShell, BottomTabBar, PortfolioSelector
        ui/                     # Design system (Button, Card, Logo, itp.)
      lib/                      # API client, local storage, formattery
  data/                # Bazy SQLite per-portfolio + price_history.db + auth.db (gitignored)
  benchmark/           # CSV z historycznymi wartościami WIG*
  start.command start.bat  # Skrypty uruchomieniowe
  .env.example         # Szablon konfiguracji
```

## Skrypty npm

| Skrypt | Opis |
|---|---|
| `npm run dev` | Start serwera + klienta z hot-reload (concurrently) |
| `npm run build` | Build wszystkich workspace'ów |
| `npm run seed -w server` | Seed bazy (początkowy ticker map) |
| `npm run seed-benchmarks -w server` | Seed historycznych benchmarków WIG z CSV |
| `npm test -w server` | Testy jednostkowe (Vitest) |

## Licencja

MIT
