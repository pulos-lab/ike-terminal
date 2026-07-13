# Backlog — IKE Terminal

## 1. System importu danych

### Cel
Uniwersalne narzędzie importu danych z dowolnego systemu/brokera. Rozdzielenie formatu danych wejściowych od wewnętrznej prezentacji zasobów — warstwa normalizacji do modelu aplikacji.

### Stan obecny
- Parsery per broker: Bossa, mBank, DEGIRO, XTB, IBKR
- Import uniwersalny (generic profiles) — deklaratywny `ImportProfile` + generator LLM
- Auto-detekcja formatu po nagłówkach
- Normalizacja nazw brokerowych na poziomie parsera (`normalizeBossaPaperName`)

### Do zrobienia

#### Faza 1: Architektura warstwy normalizacji
- [ ] Zdefiniować **Canonical Asset Model** — wewnętrzny model aktywów niezależny od brokera
- [ ] Ujednolicić typy transakcji giữa brokerami (Bossa `K/S`, XTB `buy/sell`, IBKR `Buy/Sell` → wspólny `BUY`/`SELL`)
- [ ] Normalizacja walut — USD, $, USDL → `USD`; GBX → oddzielna obsługa (pence vs funt)
- [ ] Rozdzielić **asset identity** (ISIN, ticker brokera, symbol giełdowy) od **asset metadata** (nazwa, sektor, klasa aktywu)
- [ ] Walidacja danych wejściowych — odrzucanie wierszy z brakującymi polami zamiast cichego zgadywania

#### Faza 2: Universal Import Engine
- [ ] Reforma `ImportProfile` — zdeklarować format wejściowy (delimiter, encoding, mapowanie kolumn) osobno od logiki biznesowej
- [ ] Pipeline: `Raw Data → Parser → Normalizer → Validator → Canonical Model → Portfolio Engine`
- [ ] Obsługa plików wieloarkuszowych (XLSX) jako standard — nie edge case
- [ ] Dry-run preview z diffem przed commit (już częściowo jest w generic import)
- [ ] Obsługa retroactive imports (daty wsteczne) z automatycznym przeliczeniem historii

#### Faza 3: Ekosystem importu
- [ ] Plugin architecture — nowy broker = nowy parser + profil, bez zmian w silniku
- [ ] Import batch history — śledzenie co, kiedy i z jakiego pliku zostało zaimportowane
- [ ] Re-import z merge (aktualizacja istniejących transakcji zamiast duplikacji)
- [ ] Import automatyka — CRON/API pull z brokerów oferujących API (IBKR Flex, XTB xAPI)
- [ ] Webhook / email trigger — import po otrzymaniu wyciągu PDF/CSV

---

## 2. System modelowania aktywów i wyceny portfela

### Cel
Zamodelowanie danych do stworzenia aplikacji zdolnej do agregowania portfeli z dowolnymi assetami (akcje, obligacje, nieruchomości, metale, opcje, krypto, etc.) z funkcjami wyceny jednostkowej aktywa w czasie.

### Kluczowa formuła
```
V_total(t) = Σ Q_i(t) × P_i(t) × FX_i(t)
```
- `Q_i(t)` — ilość aktywa w czasie t (z historii transakcji)
- `P_i(t)` — cena jednostkowa w walucie bazowej aktywa
- `FX_i(t)` — kurs wymiany waluty aktywa na walutę display portfela

### Do zrobienia

#### Faza 1: Model danych (Schema Design)
- [ ] **Asset (Instrument)** — uniwersalny paszport aktywa:
  - `id`, `asset_class_id`, `symbol`, `name`, `base_currency`
  - Rozdzielenie tożsamości (ISIN, ticker) od metadanych
- [ ] **AssetClass** — słownik klas: `equity`, `bond`, `etf`, `option`, `crypto`, `property`, `metal`, `cash`, `other`
- [ ] **Szczegóły per klasa** (Concrete Table Inheritance):
  - `asset_equity_details` (ISIN, exchange, sector)
  - `asset_option_details` (underlying, strike, expiry, type)
  - `asset_property_details` (address, sqm, type)
  - `asset_physical_details` (weight, purity, storage)
  - `asset_bond_details` (nominal, coupon, maturity)
- [ ] **Transaction** — ujednolicona księga główna:
  - `asset_id`, `type` (BUY/SELL/DIVIDEND/DEPOSIT/WITHDRAWAL/INTEREST/EXPENSE/...), `quantity`, `price_per_unit`, `fee`, `currency`, `timestamp`
- [ ] **Position** — zmaterializowany stan portfela (aktualny lub per dzień)
- [ ] **CurrencyExchangeRate** — tabela kursów walutowych (historia + live)

#### Faza 2: PriceProvider Strategy Pattern
- [ ] Interfejs `PriceProvider` — `getUnitPriceAtTime(assetId, timestamp): number`
- [ ] Implementacje per klasa aktywa:
  - **Equity/ETF/Crypto**: Yahoo Finance / Stooq / CoinGecko (EOD z cache)
  - **Bond**: cena rynkowa z Stooq/Yahoo lub szacunek z krzywej dochodowości
  - **Property**: cena/m² z API nieruchomościowych lub ręczna wycena użytkownika
  - **Metal**: kurs spot (XAU/XAG) × czystość × waga
  - **Cash**: `P(t) = 1.0` (stała)
  - **Option**: model Black-Scholes lub cena rynkowa z giełdy
- [ ] Fallback chain: live API → cache SQLite → szacunek z ostatniej znanej ceny
- [ ] Obsługa delisted instruments — cena ostatniej transakcji lub 0

#### Faza 3: Portfolio Valuation Engine
- [ ] **Fair Value Storage** — trwałe przechowywanie cen jednostkowych w czasie (nie cache — golden source)
  - `asset_price_history` (asset_id, timestamp, price, source)
  - Agregacja EOD → rollup tygodniowy/miesięczny do wykresów
- [ ] **Portfolio Daily Snapshots** — dzienne migawki wartości portfela
  - `portfolio_snapshots` (portfolio_id, date, total_value, cash_balance, assets_value)
  - Generowane: CRON nocny (dla zmian rynkowych) + event-driven (dla transakcji usera)
- [ ] **Backdating** — transakcje wsteczne → invalidacja + przeliczenie snapshotów od daty transakcji
- [ ] **Multi-currency** — przeliczanie w locie po kursie historycznym z dnia wyceny

#### Faza 4: Agregacja i prezentacja
- [ ] Dashboard: wykres wartości portfela vs benchmark (już jest — rozszerzyć o nowe klasy)
- [ ] Allocation view: struktura portfela per klasa aktywa (pie chart, treemap)
- [ ] Performance metrics: MWR, TWR, IRR per asset class
- [ ] Cross-portfolio aggregation — wiele portfeli → jeden widok
- [ ] Export: PDF report, CSV,xlsx z pełną historią

---

## Priorytety (propozycja)

| Priorytet | Temat | Wpływ | Złożoność |
|-----------|-------|-------|-----------|
| P0 | Normalizacja paperName w parserze | 🔥 Bug fix | Niska |
| P0.5 | `status`/`category` w `ticker_map` + scraper GPW delisted | 🔥 Porządek danych | Niska |
| P1 | Canonical Asset Model (schema) | 🔥 Fundament | Średnia |
| P2 | PriceProvider interface + routing | 🔥 Porządek + MVP | Niska |
| P3 | Universal Import Pipeline | ⚡ UX | Średnia |
| P4 | Portfolio Snapshots (incremental) | ⚡ Wydajność | Wysoka |
| P5 | Multi-asset details (property, metal, option) | 📈 Rozwój | Wysoka |
| P6 | Plugin architecture dla nowych brokerów | 📈 Skalowalność | Średnia |
| P7 | Cross-portfolio aggregation | 📈 Rozwój | Średnia |

---

## 3. Instrument Status + Delisted Scraper

### Cel
Eksplicytne oznaczenie statusu instrumentu (active/delisted/suspended) i kategorii (stock/etf/bond/...) w `ticker_map`. Scrapowanie listy wycofanych spółek GPW z oficjalnego archiwum. Ochrona przed niepotrzebnymi API calls dla delisted instruments.

### Stan obecny
- `ticker_map` nie ma pól `status` ani `category`
- Delisted = hardcoded 1 wpis (`PLASTBOX`) w `isin-resolver.ts`
- Price fetching nie sprawdza statusu — każdy ticker przechodzi przez Yahoo/Stooq
- `InstrumentCategory` istnieje tylko na `transactions` (per-transaction, nie per-instrument)

### Do zrobienia

#### Schema + Migration
- [ ] Dodaj `status` (`active` | `delisted` | `suspended`) do `ticker_map`
- [ ] Dodaj `category` (`stock` | `etf` | `bond` | `option` | `cfd`) do `ticker_map`
- [ ] Migration SQL: `ALTER TABLE ticker_map ADD COLUMN status TEXT DEFAULT 'active'`
- [ ] Migration SQL: `ALTER TABLE ticker_map ADD COLUMN category TEXT DEFAULT 'stock'`
- [ ] Update `TickerMapEntry` w `shared/src/types.ts`

#### Scraper
- [ ] `server/scripts/scrape-delisted-gpw.ts` — scrapuje archiwum GPW (`/zawieszenia-i-wykluczenia-archiwum`)
- [ ] Filtruje wiersze z `wycofanie z obrotu` (permanentne delisting)
- [ ] Generuje `shared/src/delisted-gpw-data.ts` (ticker, ISIN, nazwa, data wycofania)
- [ ] `npm run scrape:delisted-gpw -w server`

#### Price Fetching Guards
- [ ] Guard w `computeOpenPositions` — skip Yahoo/Stooq jeśli `status=delisted`
- [ ] Guard w `computePortfolioHistory` — skip history fetch
- [ ] Guard w `/api/prices/live` — skip live fetch
- [ ] Guard w dividend scanner — skip dividend check
- [ ] Fallback: ostatnia znana cena z transakcji (istniejąca logika)

#### Usunięcie hardcoded
- [ ] Usuń `DELISTED_GPW` map z `isin-resolver.ts`
- [ ] Zastąp lookupem z `ticker_map.status`

#### UI
- [ ] Badge "Delisted" / "Suspended" przy pozycji w portfelu
- [ ] Info w tooltip: "Brak cen bieżących — ostatnia znana cena z [data]"

### Powiązania
- Kontynuacja P0 (normalizeBossaPaperName) — scraper korzysta z unormowanych nazw
- Fundament dla P1 (Canonical Asset Model) — `status`/`category` to first step ku pełnemu schematowi
- Oszczędność: eliminacja ~N API calls rocznie dla delisted instruments
