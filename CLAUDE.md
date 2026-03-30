# Portfolio Manager — IKE Terminal

## Opis projektu
Aplikacja webowa do zarządzania portfelem inwestycyjnym. Monorepo TypeScript (client + server + shared).
W przyszłości ma umożliwić łatwe stworzenie pełnej aplikacji webowej.
Kod ma wykorzystywać najnowsze wzorce projektowe, być odpowiednio opisany i stosować najlepsze praktyki architektoniczne.

## Architektura
- **Client**: React 19 + Vite + Tailwind CSS + shadcn/ui + Zustand + TanStack Query + Recharts/Lightweight Charts
- **Server**: Express + better-sqlite3 + PapaParse + yahoo-finance2
- **Shared**: Typy TypeScript współdzielone między client/server
- **Baza**: SQLite (osobna DB per portfel) + price_history.db (cache cen)
- **Porty**: Backend :3001, Frontend :5173

## Struktura katalogów
- `client/src/components/` — strony i komponenty React
- `server/src/routes/` — endpointy API (portfolios, portfolio, prices, import)
- `server/src/parsers/` — parsery CSV brokerów (bossa, mbank, degiro)
- `server/src/services/` — logika biznesowa (portfolio-engine, price-cache, isin-resolver)
- `shared/src/` — typy, stałe, seed ticker map
- `data/` — bazy SQLite
- `Import/` — pliki CSV użytkownika (IKE/, IKZE/, Degiro/)

## 6 paneli aplikacji
1. **Dashboard** — wykres MWR portfela vs benchmark (S&P 500), statystyki
2. **Portfel** — otwarte pozycje z bieżącymi cenami
3. **Transakcje** — pełna historia transakcji K/S z edycją ręczną
4. **Dywidendy** — historia dywidend z edycją ręczną
5. **Waluty** — kursy walut + historia operacji FX
6. **Wpłaty** — historia wpłat z wyceną portfela

## Import danych — obsługiwane domy maklerskie
1. **Bossa** — transakcje + operacje (średnik, Windows-1250, CSV)
2. **mBank eMakler** — transakcje GPW + zagraniczne (średnik, Windows-1250, CSV)
3. **DEGIRO** — transakcje multi-currency (przecinek, UTF-8, CSV)
4. **XTB** — transakcje stock/ETF + zamknięte pozycje CFD (XLSX, ExcelJS)
   - Arkusz "CASH OPERATION HISTORY": stock purchase/sale, commission, Sec Fee, deposit, withdrawal, dividend, WHT, swap, rollover
   - Arkusz "Closed Positions" (opcjonalny): zamknięte CFD → para transakcji K+S, kategorie instrumentów (stock/etf/cfd)
   - Symbole XTB: suffix krajowy (CDR.PL, AAPL.US, SAP.DE) → waluta z suffixu
   - Obsługa fractional shares (np. 0.3069 @ 494.15)
- Auto-detekcja formatu po nagłówkach CSV/XLSX — użytkownik nie musi wskazywać brokera

## Źródła cen — priorytety

### Ceny bieżące (live)
- **GPW (akcje .WA)**: Yahoo Finance
- **NewConnect (NC)**: Stooq (jedyne źródło — Yahoo nie listuje NC)
- **Zagraniczne (NYSE, NASDAQ, XETRA, TSX)**: Yahoo Finance
- **CFD (surowce, indeksy, forex, krypto)**: Yahoo Finance (statyczna mapa instrument → ticker w `shared/src/cfd-ticker-map.ts`, np. GOLD → GC=F)
- **FX (kursy walut)**: Yahoo Finance (USDPLN=X, EURPLN=X, CADPLN=X)

### Ceny historyczne (dashboard/benchmark)
- **GPW (.WA)**: Yahoo Finance (priorytet) → Stooq (fallback gdy Yahoo < 10 punktów)
- **NewConnect (NC)**: Stooq
- **Zagraniczne**: Yahoo Finance
- **Benchmarki polskie (WIG, WIG20, mWIG40, sWIG80)**: SQLite cache (seed z CSV w `benchmark/`) + Stooq auto-update co 6h (`benchmark-updater.ts`)
- **Benchmarki zagraniczne (S&P 500, NASDAQ)**: Yahoo Finance

### Cache (3 warstwy)
1. **In-memory** (NodeCache) — live: 1-4h TTL, historia: 12h TTL
2. **SQLite persistent** (`data/price_history.db`) — historia cenowa, przeżywa restart serwera
3. **Fetch sieciowy** — Yahoo/Stooq API, tylko gdy cache miss

### Resolwowanie tickerów (ISIN resolver)
- **Polskie pseudo-ISINy** (mBank/XTB): Stooq → Yahoo (z preferencją .WA)
- **Prawdziwe polskie ISINy** (Bossa/DEGIRO): Yahoo by ISIN → Stooq validate → Stooq name search → NC offline map → Yahoo by name
- **NewConnect**: statyczna mapa offline (`shared/src/nc-ticker-map.ts`, 374 spółki) jako fallback gdy Stooq rate-limited
- **CFD**: statyczna mapa (`shared/src/cfd-ticker-map.ts`) → Yahoo ticker (np. GOLD → GC=F)
- **Zagraniczne ISINy**: Yahoo by ISIN → Yahoo by name

## Konwencje
- TypeScript strict mode
- Encoding: UTF-8 (nowe pliki), Windows-1250 (parsery Bossa/mBank)
- Transakcje: side 'K' (kupno) / 'S' (sprzedaż)
- Waluty: uppercase ISO 4217 (PLN, USD, EUR, GBX, HKD, NOK)

## Zasady testowania
- Przed wprowadzeniem nowej funkcjonalności — przetestuj na obecnych danych lub stwórz przykładowe dane jeżeli nie da się przetestować na obecnych
- Po testach przywróć portfel do stanu pierwotnego (usunięcie nadmiarowych i niepotrzebnych danych)
- Upewniej się za każdym razem, że logika importu działa tak samo w przypadku wszystkich parserów
- W razie wątpliwości — zadawaj pytania i weryfikuj

## Uruchomienie
- `npm run dev` — start client + server (concurrently)
- `npm run build` — build all workspaces
- `npm run seed -w server` — seed bazy danych
- `start.command` — alternatywny skrypt startowy (kill portów + start + open browser)
