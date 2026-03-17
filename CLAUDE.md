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
1. **Bossa** — transakcje + operacje (średnik, Windows-1250)
2. **mBank eMakler** — transakcje GPW + zagraniczne (średnik, Windows-1250)
3. **DEGIRO** — transakcje multi-currency (przecinek, UTF-8)
- Auto-detekcja formatu po nagłówkach CSV — użytkownik nie musi wskazywać brokera

## Źródła cen
- **Stooq** — polskie akcje (.WA), priorytet dla GPW
- **Yahoo Finance** — zagraniczne, FX, benchmark
- Cache: in-memory (NodeCache 12h) → SQLite persistent → fetch sieciowy

## Konwencje
- TypeScript strict mode
- Encoding: UTF-8 (nowe pliki), Windows-1250 (parsery Bossa/mBank)
- Transakcje: side 'K' (kupno) / 'S' (sprzedaż)
- Waluty: uppercase ISO 4217 (PLN, USD, EUR, GBX, HKD, NOK)

## Zasady testowania
- Przed wprowadzeniem nowej funkcjonalności — przetestuj na obecnych danych lub stwórz przykładowe dane jeżeli nie da się przetestować na obecnych
- Po testach przywróć portfel do stanu pierwotnego (usunięcie nadmiarowych i niepotrzebnych danych)
- W razie wątpliwości — zadawaj pytania i weryfikuj

## Uruchomienie
- `npm run dev` — start client + server (concurrently)
- `npm run build` — build all workspaces
- `npm run seed -w server` — seed bazy danych
- `start.command` — alternatywny skrypt startowy (kill portów + start + open browser)
