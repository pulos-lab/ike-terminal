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
- `server/src/services/` — logika biznesowa: `portfolio-engine`, `history-memo` (cache computePortfolioHistory, wersjonowanie w `db/data-version`), `price-cache`, `history-cache`, `isin-resolver`, `sector-resolver`, `ticker-search`, `dividend-scanner`, `dividend-estimate`, `gpw-dividend-calendar` (kalendarz dywidend GPW/NC ze stockwatch+biznesradar, lazy refresh 24h), `split-detector`, `spin-off-transform` + `spin-offs-applier` + `spinoff-events` + `sec-ratio-resolver` (patrz „Spin-offy" niżej), `payment-currency-reconciler`, `benchmark-updater`, `import-service`, `yahoo-finance`, `yahoo-auth`, `stooq` + `__tests__/`
- `shared/src/` — typy, stałe, mapy: `ticker-map`, `nc-ticker-map`, `cfd-ticker-map`, `bond-map` (+ `bond-map-data` generowany scraperem z obligacje.pl: ~930 obligacji Catalyst z ISIN/nominałem/zapadalnością), `gpw-sector-map`, `gics-to-stockwatch`, `isin-aliases-map`, `ipo-subscriptions-map`, `tender-offers-map`, `spin-offs-map` (znane spin-offy, seed SPGI→MBGL; nadrzędne nad scraperem), `ike-ikze-limits`
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
5. **Interactive Brokers (IBKR)** — roczne Activity Statements w HTML (multi-file: wszystkie roczniki i oba konta naraz; parser `server/src/parsers/ibkr/`)
   - Sekcje HTML (`div id="tbl{Name}_?U{acct}Body"`): Trades, ContractInfo, Dividends+WHT (parowane w operację netto z nettingiem reversali), Combined Interest/Broker Fees (odsetki margin → `fee`, kupony → `dividend`+`coupon`, SYEP → `other`+`interest`), Fees, Deposits, Corporate Actions (splity → `stock_splits` z realną ex-datą; zmiany ISIN → UPDATE transakcji PRZED insertem — idempotentny re-import), Transactions Tax (FTT → prowizja), Cash Report (tylko agregat Sales Tax → `fee`)
   - **Opcje**: kategoria `option`, pseudo-ISIN `OPT:{ticker OCC}` (helpery w `shared/src/option-symbols.ts`), metadane w tabeli `option_contracts`, wycena live przez Yahoo v8 chart po tickerze OCC (Eurex → fallback priceManual); sell-to-open = zwykła S (silnik wspiera otwarte shorty: ujemne shares/wartość); osobna karta „Opcje" w Portfelu (DTE, expiryPassed)
   - Obligacje UST: qty normalizowane do nominał/100 (cena w % → `inferBondNominal`=100); Forex → para nóg `fx_exchange` + prowizja w walucie BAZOWEJ (nagłówek „Comm in PLN" — także dla par EUR.USD!); transfery Inter-Company między kontami POMIJANE (oba konta = jeden portfel, ciągłość kosztu z historii)
   - **Pułapka nagłówków**: kolumny zmieniają się między blokami JEDNEJ tabeli (Forex: „Comm in PLN" vs „Comm/Fee") i między latami (ContractInfo `Underlying` od 2024; Symbol bywa listą aliasów „META, FB") — ekstraktor dzieli tabelę na segmenty per `<th>`, mapowanie zawsze po nazwach
   - Golden test na realnych plikach (skip bez katalogu): `import/ibkr/` — uzgadnia saldo per waluta z Cash Report ±0.25
6. **Trading 212** — JEDEN plik CSV z transakcjami, operacjami gotówkowymi i splitami (parser `server/src/parsers/trading212/`, rejestr `COMBINED_PARSER_REGISTRY`)
   - **Nagłówek nie jest stały**: 14 wariantów na 27 realnych plikach (kolumny podatków/opłat dochodzą zależnie od zdarzeń) + DWA różne porządki kolumn (`Notes,ID` raz po `Name`, raz na końcu) + alias `Time` / `Time (UTC)`. Mapowanie WYŁĄCZNIE po nazwach (`t212-columns.ts`) — indeksy pozycyjne są wykluczone
   - Waluty: `Currency (Price / share)` = notowanie, `Currency (Total)` = rozliczenie, `Exchange rate` = quote-per-payment (jak DEGIRO) → `fxRate` to jego odwrotność. `Total` zawiera już opłatę przewalutowania, więc `value` liczymy z ilości × ceny
   - Opłaty bywają w TRZECIEJ walucie (stamp duty w GBP przy notowaniu GBX) — przelicznik funt/pens, reszta pomijana z ostrzeżeniem
   - Klasyfikacja po PEŁNEJ liście wartości `Action`, nigdy po prefiksie: `Market look` wygląda identycznie jak `Market buy` i transakcją nie jest. Wyjątek: rodzina `Dividend (…)` z otwartą listą podtypów
   - Karta płatnicza (`Card debit`/`Card credit`/`Spending cashback`) → wypłata/wpłata, nie koszt (przepływ zewnętrzny jest neutralny dla TWR/MWR, a saldo gotówki zostaje poprawne). `Currency conversion` → para nóg `fx_exchange` (kwoty z kolumn, fallback z `Notes`). `Stock split open`+`close` → `stock_splits` (ratio z ilorazu nóg). `Transfer out` → syntetyczna S po cenie z pliku + RÓWNOWAŻĄCA wypłata
   - **Wybór ścieżki importu idzie po TREŚCI, nie po rozszerzeniu** — `.csv` dzielą T212 i parsery jednorolowe, więc `classifyFile` najpierw próbuje `detectCombinedBroker`, a przy braku dopasowania spada do ścieżki tekstowej
- Auto-detekcja formatu po nagłówkach CSV/XLSX — użytkownik nie musi wskazywać brokera
- **Jak każdy parser identyfikuje papier** (co trafia do `isin`/`paperName`, pseudo-ISIN-y, waluty, którą gałęzią idzie resolver): `docs/parsery-identyfikacja-papieru.md`

### Import uniwersalny (inni brokerzy, CSV i XLSX)
- Silnik profili: `server/src/parsers/generic/` (deklaratywny `ImportProfile` w `shared/src/import-profile.ts`, zod) + biblioteka profili w globalnej bazie `data/import_profiles.db` keyed by fingerprint nagłówków; API `/api/import/generic/{analyze,generate-profile,preview,commit,batches,reimport}`; kreator UI w `client/src/components/import/generic/` (w tym `GenericBatchesSection` — lista poprzednich importów uniwersalnych z przyciskiem „Wgraj plik ponownie" dla batchy oflagowanych przez admina; plików nie przechowujemy, więc korekta mapowania = ponowne wgranie pliku przez użytkownika, kropka/licznik przy „Import" w `AppShell`)
- **Silnik jest wierszowy, nie bajtowy**: `parseWithProfile(content: string, …)` parsuje CSV PapaParse'em; cała reszta (classify/mapping/pairing/biblioteka/kuracja/LLM/redakcja/podgląd/commit/re-import) jest format-agnostyczna.
- **XLSX = cienka warstwa dekodująca** (`server/src/parsers/xlsx-to-csv.ts`: ExcelJS → każdy arkusz serializowany średnikiem do CSV-stringa). Plik = ZBIÓR TABEL: CSV ma jedną, XLSX ma jedną per arkusz z danymi (okładki/puste/jednokolumnowe pomijane wg heurystyki nagłówka). Każdy arkusz = osobny fingerprint → osobny profil (z zapisanym `file.sheet`) → osobny `import_batch`; wszystkie arkusze scalają się w JEDEN atomowy import (podgląd scalony z wkładem per arkusz). Re-import dopasowuje arkusz po fingerprincie. Generacja AI i mapowanie ręczne działają per arkusz.
- **Fingerprint format-aware** (`fingerprint.ts`): CSV używa delimitera (bajtowo identyczny — biblioteka prod bez migracji, pilnuje test z zahardkodowanym hashem), XLSX używa `xlsx:<znormalizowana nazwa arkusza>`. Obecność `file.sheet` w profilu JEST markerem XLSX (brak dyskryminatora `format`).
- Harness parytetu na realnych plikach: `IMPORT_DIR=<dir> npm run compare:generic -w server` (flagi: `--resolver-live`, `--llm`); XTB XLSX zasilany tym samym `loadXlsxSheets` → bramka parytetu bajtowego
- **Generator mapowań przez LLM** (`profile-generator.ts` + `llm-client.ts`): do API AI trafiają WYŁĄCZNIE zredagowane fragmenty pliku (`sample-redactor.ts`): nagłówki, próbka wierszy, listy unikalnych wartości/wzorców kolumn z całego pliku oraz — w retry — pojedyncze zredagowane wiersze niedopasowane do reguł, za jawną zgodą użytkownika w kreatorze; profil waliduje zod + deterministyczny self-check na realnym pliku (próg pewności 0.8, max 2 retry); wynik zapisywany jako `pending` (generatedBy='llm' + model + confidence). Env:
  - `LLM_API_KEY` — wymagany (brak = AI wyłączone, ścieżka ręczna działa); `GENERIC_IMPORT_LLM=off` — twardy wyłącznik
  - `LLM_BASE_URL` — endpoint OpenAI-compatible, domyślnie `https://api.mistral.ai/v1` (Mistral: EU); DeepSeek tylko przez hosta EU (Scaleway/OVH) — **bezpośrednie `api.deepseek.com` jest zablokowane w kodzie** (dane poza EU)
  - `LLM_MODEL` (domyślnie `mistral-medium-latest` — wynik dry-runu na realnych plikach; `mistral-small` zawodzi na DEGIRO i plikach operacji), `LLM_MODEL_FALLBACK` (opcjonalny mocniejszy model na drugą rundę po odmowie, np. `mistral-large-latest`), `LLM_TIMEOUT_MS` (domyślnie 120000)
  - `GENERIC_IMPORT_LLM_DAILY_LIMIT` (domyślnie 20; ≤0 = bez limitu) — anty-spam: dzienny limit generacji AI per użytkownik (każdy NOWY fingerprint = płatne wywołanie LLM; trafienie w bibliotekę nie liczy się). Liczy PRÓBY (licznik w pamięci) + max z utrwalonych sukcesów w `import_profiles` (przeżywa restart); przekroczenie → 429, UI proponuje mapowanie ręczne. `services/llm-quota.ts`

## Spin-offy (wydzielenia spółek) — automatyczne
- **Zasada**: rodzic w portfelu + nadejście ex-date → aplikacja SAMA tworzy pozycję dziecka i proporcjonalnie obniża koszt rodzica (zero akcji użytkownika, zero zatwierdzeń)
- **Silnik**: `spin-off-transform.ts` — czysta transformacja compute-time (lustro `adjustTransactionsForSplits`, te same 3 choke pointy: positions/closed-trades/history). Syntetyczny zakup dziecka ma `total=0` (cash-neutralny — oba tory cash liczą z `tx.total`); loty rodzica trzymane na ex dostają cenę ×(1-frac), lot częściowo sprzedany przed ex dzielony na części A/B (zero wpływu na historyczne closed trades). NIC nie jest zapisywane do tabeli `transactions`
- **Alokacja kosztu**: `frac = childMkt/(parentMkt+childMkt)` z cen w dniu ex (zgodnie z zasadą proporcjonalną art. 24 ust. 8 PIT), ZAMROŻONA per portfel w tabeli `spin_offs` (`UNIQUE(parent_isin, ex_date)`); ilości silnik liczy na żywo z transakcji. Statusy: `applied` / `skipped_broker` (broker sam zaksięgował dziecko — realne wiersze wygrywają) / `reverted` (tombstone, DELETE w API = dokładne cofnięcie)
- **Źródła zdarzeń**: statyczna `shared/spin-offs-map.ts` (nadrzędna, override przez `costAllocPct`) ∪ tabela `spinoff_events` w price_history.db zasilana scraperem stockanalysis.com (lazy ≤1×/24h; strona NIE podaje ratio) + **ratio z SEC EDGAR** (`sec-ratio-resolver.ts`: full-text search 8-K rodzica/10-12B dziecka, strict-wzorce z kontekstem spółek, konflikt→null; env `SEC_CONTACT` do User-Agent — **musi zawierać prawdziwą domenę, `@localhost` = HTTP 403 z `www.sec.gov/Archives`**, dlatego default też ma domenę i UA bez niej jest odrzucany). Zdarzenie bez ratio NIE aplikuje się (badge „czekam na ratio" przy rodzicu — sygnalizowany 14 dni od ex i tylko dopóki portfel nie zna zdarzenia z innego źródła). Lookupy ratio rotują (najdawniej próbowane pierwsze), z bramkami: 90 dni od ex i 20 prób na zdarzenie
- **Guardy**: wykluczenie fałszywej detekcji splitu na rodzicu (okno ±30 dni od ex), clamp alokacji [0.001,0.9], defer+backoff 1h gdy dziecko bez notowań, idempotencja przez ON CONFLICT DO NOTHING, bump `dataVersion` tylko przy realnej mutacji
- **UI**: badge przy dziecku (skąd akcje, % kosztu) i rodzicu — komunikat jednorazowy, wisi 14 dni od ex-date LUB od zastosowania (`SPIN_OFF_BADGE_WINDOW_DAYS`); miękki warning przy ręcznym dodaniu transakcji na dziecko (`requiresConfirmation` → retry z `confirmSpinOff`)
- **Diagnostyka po deployu**: `npm run check:spinoff-sources -w server` (żywy test discovery+SEC; sandbox dev blokuje sieć — transport weryfikowany właśnie tym skryptem)

## Źródła cen — priorytety

### Ceny bieżące (live)
- **GPW (akcje .WA)**: Yahoo Finance → biznesradar (zapas TYLKO przy chybieniu Yahoo, tylko tickery .WA; previousClose zostaje z Yahoo → przy cenie zapasowej zmiana dzienna = null). Kolejność OBOWIĄZUJE w obu ścieżkach: silnik pozycji i `/api/prices/live`
- **NewConnect (NC)**: biznesradar.pl (główne źródło, `biznesradar.ts`, kurs opóźniony ~15 min, parser `q_ch_act`, `/notowania/<ticker>` z redirectem) → Stooq (zapas). Yahoo nie listuje NC. Powód zmiany: endpoint CSV Stooqa `/q/l/` padł ~03.2026 (zwraca „lokalizacja nie istnieje" globalnie). Kolejność OBOWIĄZUJE w obu ścieżkach: silnik pozycji (`portfolio-engine.ts`) i `/api/prices/live`
- **Obligacje Catalyst (exchange `CATALYST`)**: stockwatch.pl (`stockwatch-bonds.ts` — JEDEN lazy fetch 5 tabel sektorowych `/obligacje/notowania/sektor/…` → mapa ticker→{kurs, kurs odniesienia=previousClose, data transakcji}, TTL 1h, circuit breaker) → Stooq (zapas). Kurs w % nominału — silnik mnoży przez nominał z `bond-map`. biznesradar NIE kwotuje obligacji (404), Yahoo też nie; seria spoza tabel (np. wykupiona) → fallback ostatnia cena tx (`priceManual`). Kolejność OBOWIĄZUJE w obu ścieżkach: silnik pozycji i `/api/prices/live`
- **Zagraniczne (NYSE, NASDAQ, XETRA, TSX)**: Yahoo Finance
- **CFD (surowce, indeksy, forex, krypto)**: Yahoo Finance (statyczna mapa instrument → ticker w `shared/src/cfd-ticker-map.ts`, np. GOLD → GC=F)
- **FX (kursy walut)**: Yahoo Finance (USDPLN=X, EURPLN=X, CADPLN=X, GBPPLN=X)

### Nadchodzące dywidendy
- **GPW / NewConnect**: kalendarz z polskich źródeł (stockwatch.pl + biznesradar.pl) — `gpw-dividend-calendar.ts`, persystencja w price_history.db, odświeżanie ≤1×/24h (3 żądania stron/dobę), merge po skrócie spółki; fallback Yahoo dla GPW, NC bez fallbacku
- **Zagraniczne**: Yahoo v10 quoteSummary (calendarEvents) + estymata z ostatniego eventu lub annualRate (roczna dla .WA, /4 dla pozostałych)
- **UWAGA**: nowa zależność runtime serwera MUSI iść do `dependencies` (prod robi `npm ci --omit=dev`); pilnuje tego prod-deps smoke test w deploy.yml

### Kalendarz publikacji wyników (`services/earnings/`)
Ikona `CalendarClock` z tooltipem przy tickerze w Portfelu, zapalana na 7 dni przed publikacją; na dzień przed (i w dniu) zmienia kolor `text-info` → `text-warning`. Zakres: akcje + opcje (przez spółkę bazową z `optionMeta.underlying`); ETF/obligacje/CFD wykluczone whitelistą. **Pozycje krótkie DOSTAJĄ sygnał** (odwrotnie niż `/dividends/upcoming`, które pomija `shares <= 0`) — wystawiona opcja jest najwrażliwsza na wyniki.
- **GPW + NewConnect**: `bankier.pl/gielda/notowania/akcje/{SLUG}/kalendarium` (`bankier-earnings.ts`), pobierane PER SPÓŁKA — kalendarz zbiorczy pokazuje tylko bieżący tydzień, a strona spółki cały harmonogram roczny. Źródłem prawdy jest obowiązkowy raport bieżący emitenta (§84 rozporządzenia MF), stąd `confidence='confirmed'`. Slug bankiera = klucz `GPW_SECTOR_MAP` / skrót z `NC_TICKER_MAP` — cały indeks mamy offline, zero requestów na mapowanie (`symbol-resolver.ts`, łańcuch 5-stopniowy z persystencją w `earnings_symbol_map`)
- **USA**: `api.nasdaq.com/api/calendar/earnings?date=` (`nasdaq-earnings.ts`), zamiatanie D+0..D+44 raz/dobę + bliskie okno D+0..D+8 co 6 h. Podana pora sesji (`bmo`/`amc`) = `confirmed`, `time-not-supplied` = `tentative`. **SEC EDGAR NIE MA przyszłych dat** — zapowiedź terminu składa przez 8-K ~1–3% emitentów; estymator z rytmu 8-K item 2.02 jest w backlogu (klasa `estimated` już w modelu)
- **XETRA/TSX**: Yahoo `calendarEvents.earnings` (`fetchEarningsCalendar` w `yahoo-finance.ts`), per ticker, cache 24 h; widełki dat → `estimated`
- **Rozpoznanie rynku nie opiera się na samej giełdzie**: resolver ISIN-ów zostawia `exchange='OTHER'` dla papierów, których nie sklasyfikował (świeże debiuty pod pseudo-ISIN-em, np. `AUTO_FIG`), więc przy nierozpoznanej giełdzie schodzimy do `country`/`currency`/sufiksu tickera (`resolveEarningsMarket`). Czysty symbol w USD → US; ticker z sufiksem (`ASML.AS`) → Yahoo; sufiks `.WA`/`.NC` lub kraj Poland → PL
- Interwał odświeżania jest PER ŹRÓDŁO (`REFRESH_INTERVAL_BY_PREFIX`) i musi odpowiadać interwałowi timera w `index.ts`; próg świeżości ma 5-minutową tolerancję, bo `last_success` zapisuje się po zamiataniu i tik dokładnie na progu wypadałby tuż przed nim (odświeżanie dryfowało do dwukrotności interwału)
- Persystencja w `price_history.db` (`earnings_calendar` + `earnings_fetch_state` + `earnings_symbol_map`), guardy `nasdaq`/`bankier` przez `source-guard.ts`. **Ścieżka requestu NIGDY nie czeka na sieć** — `getUpcomingForPositions` jest synchroniczna, odświeżanie chodzi z timerów w `index.ts` (zamiatanie US to ~45 żądań). Podmiana terminarza jest blokowana przy niekompletnym zamiataniu lub wyniku < 50% poprzedniego (ochrona przed cichym wyczyszczeniem po zmianie szablonu HTML)
- `report_date` to data kalendarzowa RYNKU EMITENTA — świadomie bez konwersji stref; skutek `amc` opisany słownie w tooltipie. Pole `upcomingEarnings` jedzie w `/positions`, ale **nie** w widoku publicznym (whitelist `share-redaction.ts` + test-strażnik)

### Ceny historyczne (dashboard/benchmark)
- **GPW (.WA)**: Yahoo Finance (priorytet) → Stooq (fallback gdy Yahoo < 10 punktów)
- **NewConnect (NC)**: biznesradar `/notowania-historyczne/` (główne — `fetchBiznesradarHistory`, tabela `qTableFull` server-side, paginacja przyrostowa, ten sam klucz cache co Stooq) → Stooq/cache zapas. Stooq historyczny padł ~07.2026 (challenge anti-bot), Yahoo nie listuje NC
- **Obligacje Catalyst**: biznesradar `/notowania-historyczne/` (główne; kurs w % nominału — spójne z `bondPriceMultiplier`) → Stooq/cache zapas
- **Zagraniczne**: Yahoo Finance
- **Benchmarki polskie (WIG, WIG20, mWIG40, sWIG80)**: SQLite cache (seed z CSV w `benchmark/`) + auto-update co 6h (`benchmark-updater.ts`: Stooq live padł → **fallback Yahoo `WIG.WA` itd.**, `BENCHMARK_YAHOO_FALLBACK`)
- **Benchmarki zagraniczne (S&P 500, NASDAQ)**: Yahoo Finance

### Cache (3 warstwy)
1. **In-memory** (NodeCache) — live: 1-4h TTL, historia: 12h TTL
2. **SQLite persistent** (`data/price_history.db`) — historia cenowa, przeżywa restart serwera
3. **Fetch sieciowy** — Yahoo/Stooq API, tylko gdy cache miss

### Resolwowanie tickerów (ISIN resolver)
- **Polskie pseudo-ISINy** (mBank/XTB): Stooq → mapa NC offline (dokładne trafienie kodu tickera, bez wymogu sufiksu `-NC`) → Yahoo **wyłącznie** listing `.WA`. Dla polskiego tickera (PLN) nigdy nie akceptujemy zagranicznego papieru o tym samym oznaczeniu (EXC=Exelon, CCC=CCC Intelligent, MNS=Monster) — brak `.WA` → wpis nierozwiązany i ponawiany, gdy Stooq odpowie
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

### Regiony (kraj siedziby)
Pole `country` w `ticker_map` (kanoniczna nazwa EN z Yahoo `assetProfile.country`; GPW/NC/Catalyst → statycznie "Poland", CFD → null). Backfillowane tym samym mechanizmem co sektory (lazy + `refresh-sectors`; opcje `OPT:` pomijane; backfill kraju NIE nadpisuje ręcznie przypisanych sektorów). Wykres „Regiony" w `PortfolioDiversification`: kraj (poprawny dla ADR-ów, np. NVO→Dania) → fallback giełda (`EXCHANGE_REGION_PL`) → „Inne"; tłumaczenia i helper `regionLabel` w `shared/src/country-region-map.ts`. Opcje (category `option`) są celowo wyłączone z wykresów dywersyfikacji (krótkie pozycje mają ujemną wartość).

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
- `npm run check:spinoff-sources -w server` — żywa diagnostyka źródeł spin-offów (stockanalysis + SEC EDGAR; `--all` = ratio dla wszystkich zdarzeń)
- `npm run check:biznesradar -w server` — żywy smoke wszystkich powierzchni biznesradar (live/historia/katalog/dywidendy; `--ticker=XYZ`); guard źródła (`source-guard.ts` + `biznesradar-guard.ts`) wykrywa odcięcie anti-bot i zmianę markupu, maile do admina przy przejściu stanu, stan w polu `sources` w `/api/health`
- `start.command` — alternatywny skrypt startowy (kill portów + start + open browser)
