# Portfolio Manager — IKE Terminal

## Opis projektu
Aplikacja webowa do zarządzania portfelem inwestycyjnym. Monorepo TypeScript (client + server + shared).
W przyszłości ma umożliwić łatwe stworzenie pełnej aplikacji mobilnej.
Kod ma wykorzystywać najnowsze wzorce projektowe, być odpowiednio opisany i stosować najlepsze praktyki architektoniczne.

## Architektura
- **Client**: React 19 + Vite + Tailwind CSS + shadcn/ui + TanStack Query + Recharts/Lightweight Charts + @tanstack/react-virtual (wirtualizacja list)
- **Server**: Express + better-sqlite3 + PapaParse + ExcelJS (Yahoo Finance przez bezpośrednie API HTTP)
- **Auth**: better-auth (email + OTP) — strony Landing/Login/VerifyOTP/ForgotPassword, ochrona ścieżek `/app/*`
- **Shared**: Typy TypeScript współdzielone między client/server
- **Baza**: SQLite (osobna DB per portfel) + price_history.db (cache cen) + auth.db
- **Porty**: Backend :3001, Frontend :5173
- **Theming**: tryb dark + light ("Warm Parchment")

## Struktura katalogów
- `client/src/components/` — strony i komponenty React (`dashboard`, `portfolio`, `transactions`, `dividends`, `currency`, `cash`, `corrections-and-costs`, `admin`, `auth`, `landing`, `layout`, `shared`, `ui`)
- `server/src/routes/` — endpointy API: `portfolios`, `portfolio`, `prices`, `import`, `bug-reports`, `share` (CRUD publicznego linku), `public-share` (widok publiczny bez auth)
- `server/src/parsers/` — parsery brokerów: `bossa-transactions`, `bossa-operations`, `mbank-transactions`, `degiro-transactions`, `degiro-operations`, `xtb-transactions` (XLSX) + `registry`, `encoding`, `utils`, `__tests__/`
- `server/src/services/` — logika biznesowa: `portfolio-engine`, `history-memo` (cache computePortfolioHistory, wersjonowanie w `db/data-version`), `price-cache`, `history-cache`, `isin-resolver`, `sector-resolver`, `ticker-search`, `dividend-scanner`, `dividend-estimate`, `gpw-dividend-calendar` (kalendarz dywidend GPW/NC ze stockwatch+biznesradar, lazy refresh 24h), `split-detector`, `payment-currency-reconciler`, `benchmark-updater`, `import-service`, `yahoo-finance`, `yahoo-auth`, `stooq` + `__tests__/`
- `shared/src/` — typy, stałe, mapy: `ticker-map`, `nc-ticker-map`, `cfd-ticker-map`, `bond-map` (+ `bond-map-data` generowany scraperem z obligacje.pl: ~930 obligacji Catalyst z ISIN/nominałem/zapadalnością), `gpw-sector-map`, `gics-to-stockwatch`, `isin-aliases-map`, `ipo-subscriptions-map`, `tender-offers-map`, `ike-ikze-limits`
- `data/` — bazy SQLite (per portfel + `price_history.db` + `auth.db`)
- `Import/` — pliki CSV/XLSX użytkownika (IKE/, IKZE/, Degiro/)

## Panele aplikacji (po zalogowaniu, prefix `/app`)
1. **Dashboard** (`/`) — wykres MWR portfela vs benchmark (S&P 500), statystyki
2. **Portfel** (`/portfolio`) — otwarte pozycje z bieżącymi cenami
3. **Transakcje** (`/trades`) — pełna historia transakcji K/S z edycją ręczną (wirtualizacja listy)
4. **Dywidendy** (`/dividends`) — historia dywidend z edycją ręczną
5. **Waluty** (`/currency`) — kursy walut + historia operacji FX
6. **Cash flow** (`/cash`) — historia wpłat/wypłat + wykres na Lightweight Charts
7. **Korekty i koszty** (`/corrections-and-costs`) — corporate actions, korekty, koszty (zastąpiło dawne Corporate Actions)
8. **Bug reports** (`/admin/bugs`) — panel admina dla zgłoszeń (kategorie: import, wykres, portfel, transakcje, dywidendy, waluty, inne)
9. **Profile importu** (`/admin/import-profiles`) — kuracja profili importu uniwersalnego (kolejka pending → review ze zredagowaną próbką, dry-runem i diffem → korekta jako nowa wersja → approve/reject; approve nowej wersji flaguje wcześniejsze importy formatu do re-importu). Admin = pierwszy zarejestrowany użytkownik (`middleware/require-admin.ts`)

Strony publiczne (bez logowania): Landing (`/`), Login, VerifyOTP, ForgotPassword, Udostępniony portfel (`/share/:token`).

## Udostępnianie portfela (publiczny link)
- Ikona Share2 na dashboardzie → `ShareDialog`: zakres (wykres / wykres+pozycje), widoczność kwot (tylko % / pełne kwoty), ważność (bezterminowo/7/30/90 dni), benchmark (zablokowany w widoku publicznym)
- Jeden aktywny link per portfel (UNIQUE w `portfolio_shares` w auth.db); token 192-bit base64url; unieważnienie = hard delete, natychmiastowe
- API: `/api/share` (CRUD właściciela, authed) + `/api/public/share/:token/{meta,history,positions}` (3 GET-y bez auth, jednolite 404, rate limit 120/15min, X-Robots-Tag noindex)
- Redakcja kwot po stronie serwera (`share-redaction.ts`): historia normalizowana wspólną stałą k (ostatnia wartość = 1000) — statystyki klienta są scale-invariant; pozycje przez whitelist mapper
- Reużycie logiki: `portfolio-views.ts` (`buildHistoryView`/`buildPositionsView`) — wspólne dla `/api/portfolio` i `/api/public`; świeżość danych z memo per dzień kalendarzowy (bez crona)

## Import danych — obsługiwane domy maklerskie
1. **Bossa** — transakcje + operacje (średnik, Windows-1250, CSV); obsługa obligacji Catalyst: kategoria `bond` (detekcja: bond-map / regex serii skarbowych / ISIN PL0000\*), kupony → `dividend`+`subkind='coupon'`, wykup → RedemptionMarker `kind='bond'` (syntetyczna S, qty = kwota/nominał, wspiera częściowy wykup). UWAGA: kursy obligacji w % nominału — `Transaction.price` ZOSTAJE w %, przeliczenie ×nominal/100 wyłącznie w silniku (`bondPriceMultiplier`)
2. **mBank eMakler** — transakcje GPW + zagraniczne (średnik, Windows-1250, CSV)
3. **DEGIRO** — transakcje multi-currency (przecinek, UTF-8, CSV)
4. **XTB** — transakcje stock/ETF + zamknięte pozycje CFD (XLSX, ExcelJS)
   - Arkusz "CASH OPERATION HISTORY": stock purchase/sale, commission, Sec Fee, deposit, withdrawal, dividend, WHT, swap, rollover
   - Arkusz "Closed Positions" (opcjonalny): zamknięte CFD → para transakcji K+S, kategorie instrumentów (stock/etf/cfd)
   - Symbole XTB: suffix krajowy (CDR.PL, AAPL.US, SAP.DE) → waluta z suffixu
   - Obsługa fractional shares (np. 0.3069 @ 494.15)
- Auto-detekcja formatu po nagłówkach CSV/XLSX — użytkownik nie musi wskazywać brokera

### Import uniwersalny (inni brokerzy, CSV)
- Silnik profili: `server/src/parsers/generic/` (deklaratywny `ImportProfile` w `shared/src/import-profile.ts`, zod) + biblioteka profili w globalnej bazie `data/import_profiles.db` keyed by fingerprint nagłówków; API `/api/import/generic/{analyze,generate-profile,preview,commit,batches,reimport}`; kreator UI w `client/src/components/import/generic/`
- Harness parytetu na realnych plikach: `IMPORT_DIR=<dir> npm run compare:generic -w server` (flagi: `--resolver-live`, `--llm`)
- **Generator mapowań przez LLM** (`profile-generator.ts` + `llm-client.ts`): do API AI trafiają WYŁĄCZNIE zredagowane fragmenty pliku (`sample-redactor.ts`): nagłówki, próbka wierszy, listy unikalnych wartości/wzorców kolumn z całego pliku oraz — w retry — pojedyncze zredagowane wiersze niedopasowane do reguł, za jawną zgodą użytkownika w kreatorze; profil waliduje zod + deterministyczny self-check na realnym pliku (próg pewności 0.8, max 2 retry); wynik zapisywany jako `pending` (generatedBy='llm' + model + confidence). Env:
  - `LLM_API_KEY` — wymagany (brak = AI wyłączone, ścieżka ręczna działa); `GENERIC_IMPORT_LLM=off` — twardy wyłącznik
  - `LLM_BASE_URL` — endpoint OpenAI-compatible, domyślnie `https://api.mistral.ai/v1` (Mistral: EU); DeepSeek tylko przez hosta EU (Scaleway/OVH) — **bezpośrednie `api.deepseek.com` jest zablokowane w kodzie** (dane poza EU)
  - `IMPORT_RAW_RETENTION_DAYS` (domyślnie 90) — retencja surowych plików batchy (leniwy sweep przy starcie; batch bez raw traci możliwość re-importu)
  - `LLM_MODEL` (domyślnie `mistral-medium-latest` — wynik dry-runu na realnych plikach; `mistral-small` zawodzi na DEGIRO i plikach operacji), `LLM_MODEL_FALLBACK` (opcjonalny mocniejszy model na drugą rundę po odmowie, np. `mistral-large-latest`), `LLM_TIMEOUT_MS` (domyślnie 120000)

## Źródła cen — priorytety

### Ceny bieżące (live)
- **GPW (akcje .WA)**: Yahoo Finance
- **NewConnect (NC)**: Stooq (jedyne źródło — Yahoo nie listuje NC)
- **Obligacje Catalyst (exchange `CATALYST`)**: Stooq (jedyne źródło; kurs w % nominału — silnik mnoży przez nominał z `bond-map`)
- **Zagraniczne (NYSE, NASDAQ, XETRA, TSX)**: Yahoo Finance
- **CFD (surowce, indeksy, forex, krypto)**: Yahoo Finance (statyczna mapa instrument → ticker w `shared/src/cfd-ticker-map.ts`, np. GOLD → GC=F)
- **FX (kursy walut)**: Yahoo Finance (USDPLN=X, EURPLN=X, CADPLN=X, GBPPLN=X)

### Nadchodzące dywidendy
- **GPW / NewConnect**: kalendarz z polskich źródeł (stockwatch.pl + biznesradar.pl) — `gpw-dividend-calendar.ts`, persystencja w price_history.db, odświeżanie ≤1×/24h (3 żądania stron/dobę), merge po skrócie spółki; fallback Yahoo dla GPW, NC bez fallbacku
- **Zagraniczne**: Yahoo v10 quoteSummary (calendarEvents) + estymata z ostatniego eventu lub annualRate (roczna dla .WA, /4 dla pozostałych)
- **UWAGA**: nowa zależność runtime serwera MUSI iść do `dependencies` (prod robi `npm ci --omit=dev`); pilnuje tego prod-deps smoke test w deploy.yml

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

### Klasyfikacja sektorowa (stockwatch taxonomy)
Zunifikowana taksonomia: 8 nadsektorów × 40 podsektorów ze stockwatch.pl/gpw/sektory (pola `supersector` + `sector` w `ticker_map`).
- **GPW / NewConnect**: `shared/src/gpw-sector-map.ts` (~740 spółek, generowany scraperem `npm run scrape:gpw-sectors -w server`)
- **Zagraniczne (Yahoo GICS)**: `shared/src/gics-to-stockwatch.ts` — tłumaczy `sector`/`industry` z assetProfile na stockwatch nadsektor/podsektor
- **CFD**: `getCfdSector` → supersektor Surowce/Indeksy/Forex/Krypto (podsektor = null)
- Resolver: `server/src/services/sector-resolver.ts` — jedno źródło prawdy dla lazyBackfillSectors + endpointu refresh-sectors + isin-resolver

## Konwencje
- TypeScript strict mode
- Encoding: UTF-8 (nowe pliki), Windows-1250 (parsery Bossa/mBank)
- Transakcje: side 'K' (kupno) / 'S' (sprzedaż)
- Waluty: uppercase ISO 4217 (PLN, USD, EUR, GBX, HKD, NOK)

## Zasady testowania
- Przed wprowadzeniem nowej funkcjonalności — przetestuj na obecnych danych lub stwórz przykładowe dane jeżeli nie da się przetestować na obecnych
- Po testach przywróć portfel do stanu pierwotnego (usunięcie nadmiarowych i niepotrzebnych danych)
- Upewniej się za każdym razem, że logika importu działa tak samo w przypadku wszystkich parserów
- Testy jednostkowe parserów i serwisów: `server/src/parsers/__tests__/` i `server/src/services/__tests__/`
- W razie wątpliwości — zadawaj pytania i weryfikuj

## Uruchomienie
- `npm run dev` — start client + server (concurrently)
- `npm run build` — build all workspaces
- `npm run seed -w server` — seed bazy danych
- `npm run scrape:gpw-sectors -w server` — regeneracja `gpw-sector-map.ts` ze stockwatch.pl
- `npm run scrape:catalyst-bonds -w server` — regeneracja `bond-map-data.ts` z obligacje.pl (~6 min; gpwcatalyst.pl blokuje boty WAF-em)
- `start.command` — alternatywny skrypt startowy (kill portów + start + open browser)
