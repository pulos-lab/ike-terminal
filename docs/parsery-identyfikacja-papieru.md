# Jak parsery identyfikują papier wartościowy

Porównanie pięciu parserów brokerskich pod kątem jednego pytania: **skąd wiadomo, jaki papier dotyczy transakcji**.

Stan na 2026-07-20. Odniesienia do linii mogą się zdezaktualizować — nazwy funkcji zostają.

---

## Wspólny kontrakt

Wszystkie parsery zbiegają się w jednym punkcie:

```ts
resolveIsin(isin, paperName, currency)   // services/isin-resolver.ts
```

Resolver **nie wie, z którego parsera przyszła transakcja**. Dostaje trzy stringi i musi na ich podstawie ustalić ticker, giełdę i źródło ceny. Cała różnica między parserami polega na tym, **czym te trzy pola są wypełniane** — a bywa to skrajnie różne.

> ⚠️ **Pułapka nazewnicza.** `resolveIsin` istnieje w repo dwa razy i to niepowiązane rzeczy:
> - `services/isin-resolver.ts` — mapuje identyfikator na ticker (ten dokument)
> - `services/import-service.ts` — domyka łańcuch zmian ISIN po akcjach korporacyjnych (`A→B, B→C ⇒ A→C`)

---

## Zestawienie zbiorcze

| | **Bossa** | **DEGIRO** | **IBKR** | **XTB** | **mBank** | **T212** |
|---|---|---|---|---|---|---|
| format | CSV `;` | CSV `,` | HTML | XLSX | CSV `;`/`,` | CSV `,` |
| **ISIN w pliku** | ✅ | ✅ | ✅ (osobna sekcja) | ❌ | ❌ | ✅ |
| ticker w pliku | ✅ | ❌ | ✅ | ✅ lub nazwa | ❌ | ✅ |
| `isin` w bazie | realny ISIN | realny ISIN | realny ISIN | ticker Yahoo | nazwa 1:1 | realny ISIN |
| `paperName` | ticker z sufiksami | nazwa produktu | `Description` | **= `isin`** | **= `isin`** | `Name` |
| pseudo-ISIN | — | — | awaryjnie | **zawsze** | **zawsze** | — |
| `paymentCurrency` | `PLN` → reconcile | `EUR` → reconcile | **= `currency`** | waluta konta | z pliku | `Currency (Total)` |
| `fxRate` | — | ✅ (odwrócony) | — | ✅ | ✅ (wyliczony) | ✅ (odwrócony) |
| ułamkowe akcje | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| kategorie | `bond` | — | `stock`/`etf`/`bond`/`option` | `stock`/`etf`/`cfd` | — | — |
| zmiany ISIN | — | — | ✅ | aliasy tickerów | — | — |

Jednym zdaniem: **Bossa, DEGIRO i Trading 212 mówią wprost czym jest papier, IBKR mówi to w dwóch miejscach i trzeba je skleić, a XTB i mBank w ogóle nie mówią — trzeba wywnioskować.**

---

## Bossa

Jedyny parser z **dwoma niezależnymi identyfikatorami** w jednym wierszu.

```
data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta
25.02.2026;KGHM;PLKGHM000017;K;10;150.50;1505.00;5.00;1510.00;PLN
```

Zapis jest passthrough — żadnego pseudo-ISIN-u:

```ts
paperName: canonicalPaperName,   // 'KGHM', 'SEVENET-NC-FIX'
isin: canonicalIsin,             // 'PLKGHM000017'
```

### Sufiksy Bossy niosą informację

`-NC` / `-NC-FIX` (NewConnect), `-FIX` (cena fixowana), `-C` (certyfikat), `_IPO` (pre-IPO). **Nie są ścinane przy zapisie** — bo detekcja NewConnect w resolverze opiera się właśnie na ich obecności. Ścina je dopiero `normalizeBossaPaperName` w momencie dopasowywania (`services/stooq-utils.ts`).

To czyni Bossę **jedynym parserem, z którego osiągalny jest guard NC offline** (`tryNcOfflineGuard`) — pozostałe nigdy nie mają sufiksu `-NC`.

### Obligacje Catalyst

`isBondInstrument(paperName, isin)` sprawdza kolejno: mapę obligacji → regex serii skarbowych (`DS1030`, `FPC0235`) → indeks ISIN. Trafienie → `category: 'bond'` plus sanity-check `wartość ≈ qty × kurs% × nominał` z progiem 20%.

**`price` zostaje w % nominału** — mnożnik stosuje dopiero silnik.

### Operacje: identyfikator z regexu

`bossa-operations.ts` **nie ma kolumny ISIN**. Ticker wyłuskiwany jest z tytułu operacji:

```ts
/dywidendy(?:\s+(?:netto|brutto))?\s+(\w+)/i   // "Wypłata dywidendy PLAYWAY" → PLAYWAY
```

Podobnie wykup obligacji i kupony. Subskrypcje IPO dociągają realny ISIN ze statycznej mapy `ipo-subscriptions-map`.

---

## DEGIRO

Najprostszy przypadek — czysty passthrough ISIN-u, ale z najciekawszą arytmetyką.

```ts
const isin = row[3]?.trim();
paperName: product!,   // 'ROLLS-ROYCE HOLDINGS PLC'
isin,                  // 'GB00B63H8491'
```

Brak ISIN-u → wiersz odrzucony (`missing_isin`). Zero normalizacji nazw. **Parser nie ustawia `category`** — więc gałęzie `bond`/`cfd` w resolverze są dla DEGIRO martwe.

### Pensy i odwrócony kurs

Dwie rzeczy, które łatwo zepsuć:

```ts
fxRate: fxRateRaw > 0 ? (isGbx ? 100 : 1) / fxRateRaw : undefined,
```

DEGIRO podaje kurs jako **quote-per-payment** (4,3127 PLN za 1 EUR), a kanoniczna konwencja `Transaction.fxRate` to payment-per-quote → **odwrotność**. Dla GBX kolumna jest w pensach za EUR, a cena już przeliczona do funtów → dodatkowy mnożnik ×100.

Cena per-share **zostaje w pełnej precyzji**; zaokrąglana jest dopiero wartość. Przy 1234,5 GBX × 1000 szt. przedwczesne zaokrąglenie kosztuje £5.

### Prowizja zawsze zero

DEGIRO nalicza prowizje osobno w EUR w `Account.csv`, więc księgowanie ich przy transakcji dublowałoby koszt. Stąd `commission = 0` i `total = value`.

---

## IBKR

Jedyny parser, w którym **identyfikator jest rozbity na dwie sekcje pliku**.

| sekcja | co zawiera |
|---|---|
| `Trades` | `Symbol` — ticker (`GLOB`), symbol opcji (`EDU 19NOV21 3.0 C`), obligacja z yieldem (`T 2 7/8 05/15/32 3.92547561%`) |
| `ContractInfo` | `Security ID` — **realny ISIN** (`LU0974299876`), `Description`, `Conid`, `Multiplier`, `Type` |

Łączone są **po symbolu tekstowym**:

```ts
const stockBySymbol = new Map(statement.stockInstruments.map((s) => [s.symbol, s]));
```

> **Ciekawostka:** plik zawiera `Conid` — stabilny numeryczny identyfikator IBKR — ale **parser go nie czyta**. Cała solidność stoi na dopasowaniu tekstowym.

Ratują je dwie normalizacje kluczy:

- **aliasy po przecinku** — ContractInfo podaje `"META, FB"` po zmianie tickera w trakcie roku → rejestrowane jako dwa wiersze z tym samym ISIN-em
- **yield w symbolu obligacji** — `normalizeBondSymbol` ścina trailing `3.92547561%`

### Zachowanie przy braku wpisu w ContractInfo

| kategoria | co się dzieje |
|---|---|
| akcje | pseudo-ISIN `IBKR:{symbol}` + warning, transakcja **wchodzi** |
| obligacje | wiersz **pominięty** → skrzynka „Do wyjaśnienia" |
| opcje | **bez znaczenia** — ISIN liczony z symbolu; traci się tylko mnożnik (fallback 100) |

Świadoma asymetria: dla akcji lepiej mieć pozycję z zastępczym kluczem, dla obligacji lepiej nie zgadywać.

### Opcje: identyfikator deterministyczny

```ts
'DKNG 20MAY22 45.0 P'  →  toOccTicker()  →  'DKNG220520P00045000'
                       →  toOptionPseudoIsin()  →  'OPT:DKNG220520P00045000'
```

Liczony **wyłącznie z symbolu tradowego**, niezależnie od ContractInfo — dzięki czemu import i ręczne dodanie transakcji dają identyczny ISIN. Helpery w `shared/src/option-symbols.ts`, metadane w tabeli `option_contracts`.

**Opcje nigdy nie docierają do resolvera** — import seeduje dla nich `ticker_map` z tickerem OCC *przed* `resolveUnknownIsins`, bo `OPT:…` nie istnieje w Yahoo, ale sam OCC działa w chart API wprost.

### Zmiany ISIN po akcjach korporacyjnych

Jedyny parser z pełną obsługą. Zmiany aplikowane są **do sparsowanych danych przed insertem**, nie tylko UPDATE-em w bazie:

```ts
// Inaczej re-import pliku wstawiłby transakcję ze STARYM ISIN-em obok wiersza
// już przepisanego na nowy (dedup liczy po ISIN-ie).
if (isinTarget.size > 0) for (const tx of allTxData) tx.isin = resolveIsin(tx.isin);
```

Reverse split ze zmianą ISIN (SPCE) emituje **oba** markery: najpierw zmianę, potem split już na nowym ISIN-ie.

### Konto wielowalutowe

```ts
currency: trade.currency,
paymentCurrency: trade.currency,   // konto trzyma salda w USD/EUR/PLN naraz
```

Brak `fxRate` — koszt w złotych liczy silnik po kursach dziennych. To **dokładne przeciwieństwo XTB**, gdzie konto ma jedną walutę i przewalutowanie jest wpisane w każdą zagraniczną transakcję.

`CFD`, `Warrants` i `Futures` mają nagłówki rozpoznawane przez ekstraktor, ale **brak case'u w mapperze** → trafiają do „Do wyjaśnienia".

---

## XTB

Zero ISIN-ów. Pseudo-ISIN to **ticker w formacie Yahoo**, a `isin === paperName` zawsze.

```ts
// stary format: ticker.KRAJ
'PLTR.US' → xtbToYahooTicker() → 'PLTR'      // US → sufiks ścięty
'R22.PL'  →                    → 'R22.WA'
'INPST.NL'→                    → 'INPST.AS'

// nowy format: nazwa spółki → ticker z arkusza „Closed Positions"
'Cyfrowy Polsat' → tickerLookup → 'CPS.WA'

// brak arkusza Closed Positions → placeholder
{ paperName: symbol, isin: symbol, currency: 'PLN', placeholder: true }
```

Tabela `XTB_TO_YAHOO`: `PL→.WA`, `US→(pusty)`, `NL→.AS`, `DE→.DE`, `UK→.L`, `FR→.PA`, `ES→.MC`, `IT→.MI`, `SE→.ST`, `NO→.OL`, `DK→.CO`, `CH→.SW`, `HK→.HK`.

### Waluta wywnioskowana z kwoty

XTB jest jedynym parserem, który **liczy kurs przewalutowania z danych**:

```
Comment: "CLOSE BUY 8 @ 308.35"    ← cena w walucie NOTOWANIA (DKK)
Amount:  1386,27                    ← kwota w walucie KONTA (PLN)

implied = |Amount| / (qty × price) = 0,5620   ← to JEST kurs brokera, ze spreadem
```

Przy `implied ≈ 1` (tolerancja 2%) notowanie jest w walucie konta. Przy wyraźnie różnym — instrument jest obcy, a stosunek trafia do `fxRate`. Sprzedaż bez wiersza „close trade" dziedziczy etykietę z kupna przez `symbolFx`.

> ⚠️ **Sufiks bywa mylący.** `SUFFIX_CURRENCY.UK = 'GBP'` to uproszczenie — Londyn kwotuje w GBP, pensach **i USD** naraz (`EIMI.L`=USD, `IWDA.L`=USD, ale `VUAG.L`=GBP). Etykietę koryguje po imporcie `reconcileQuoteCurrencies` z `ticker_map`.

### CFD omijają identyfikację

Instrument nie przechodzi przez `resolveSymbolIdentifiers` — surowa nazwa idzie wprost do `isin` i `paperName`, waluta = waluta konta. Każdy zamknięty CFD daje **parę** transakcji K+S.

---

## mBank

Najuboższy przypadek. Docblock parsera mówi to wprost:

> mBank does NOT provide ISIN — only instrument name (`Papier`). The ISIN field is set to the ticker name; real ISINs are resolved after import.

```ts
paperName: paperName!,
isin: paperName!,      // 'MICRON TECH', 'ETFSP500', 'BETAETFWIG20TR'
```

Zero transformacji. Cały ciężar rozpoznania przerzucony na resolver — tam działa `splitEtfName`, rozbijający sklejone nazwy ETF-ów: `BETAETFWIG20TR` → `BETA ETF WIG20TR`.

### Waluta z giełdy — i dlaczego to krytyczne

```ts
const currency = priceCurrency || EXCHANGE_CURRENCY[exchange || ''] || 'PLN';
```

`USA-NASDAQ→USD`, `WWA-GPW→PLN`, `GER-XETRA→EUR`, `UK-LSE→GBP`.

Ponieważ `isin = paperName` i nie ma żadnego innego sygnału, **ta jedna inferencja przesądza o całej strategii resolwowania** (patrz niżej).

Fallback jest jednak używany WYŁĄCZNIE gdy w pliku brakuje kolumny „Waluta" — realne eksporty ją mają, a wtedy waluta idzie wprost z pliku. `paymentCurrency` i `fxRate` też pochodzą z pliku (kolumna „Wartość" to kwota rozliczenia w PLN, więc kurs = Wartość / (ilość × Kurs)).

---

## Trading 212

Jedyny broker, który podaje **wszystko naraz**: prawdziwy ISIN, ticker i pełną nazwę w tym samym wierszu. Identyfikacja papieru jest więc trywialna — `isin` to realny ISIN, `paperName` to `Name`, żadnych pseudo-ISIN-ów i żadnej resolucji po nazwie.

Cała trudność tego formatu leży gdzie indziej: **nagłówek nie jest stały**. Na 27 realnych plikach naliczyliśmy 14 wariantów, bo T212 dokłada kolumny zależnie od tego, co się w okresie wydarzyło, i używa DWÓCH różnych porządków kolumn:

```
Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,…,Notes,ID,…
Action,Time,ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,…
```

Dlatego mapowanie idzie **wyłącznie po nazwach** (`t212-columns.ts`), a nie po indeksach. Kolumna `Time` bywa nazwana `Time (UTC)` — alias jest w mapie.

### Waluty: trzy naraz w jednym wierszu

```
Market buy, NVDA, 0.0267 szt, 453.33 USD, Exchange rate 1.10047, Total 11.02 EUR, fee 0.02 EUR
```

- `Currency (Price / share)` = waluta **notowania** → `Transaction.currency`
- `Currency (Total)` = waluta **rozliczenia** → `paymentCurrency`
- `Exchange rate` jest quote-per-payment (jak „Kurs wymiany" DEGIRO) → `fxRate` = jego **odwrotność**
- `Total` to kwota obciążenia konta i **zawiera już opłatę za przewalutowanie** — dlatego `value` liczymy z ilości i ceny, nigdy z `Total`

Opłata potrafi być w **trzeciej** walucie: realny plik ma „Stamp duty reserve tax" w GBP przy notowaniu w GBX i rozliczeniu w EUR. Przeliczanie jej kursem z pliku zaniżyłoby wynik ~17×, więc funt i pens mają własny przelicznik (1 GBP = 100 GBX), a opłata w walucie, której nie da się przeliczyć, jest pomijana z ostrzeżeniem.

### Klasyfikacja tylko po pełnej liście

W próbkach istnieje `Market look` — wiersz wyglądający **identycznie** jak `Market buy` (ten sam papier, ilość, cena), który transakcją nie jest. Dlatego `t212-actions.ts` dopasowuje pełne wartości, nigdy prefiksy; jedyny wyjątek to rodzina `Dividend (…)`, gdzie podtyp w nawiasie jest otwartą listą. Nierozpoznany typ trafia do kwarantanny.

---

## Którą gałęzią idzie resolver

Trzy linie rozstrzygają wszystko:

```ts
const isPseudoIsin   = !isRealIsin(isin);                    // /^[A-Z]{2}[A-Z0-9]{10}$/
const isRealPolishIsin = isin.startsWith('PL') && isRealIsin(isin);
const isPolishTicker = isRealPolishIsin
                    || isin.endsWith('.WA')
                    || (isPseudoIsin && txCurrency === 'PLN');
```

| wejście | `isPseudoIsin` | gałąź | walidacja `pickPlausible` |
|---|---|---|---|
| Bossa `PLKGHM000017` | false | polska (prefiks `PL`) | ❌ |
| Bossa / DEGIRO ISIN zagraniczny | false | zagraniczna | ❌ |
| IBKR `US70450Y1038` | false | zagraniczna | ❌ |
| IBKR `OPT:…` | — | **nie dociera** | — |
| IBKR `IBKR:GLOB` (sierota) | true | zagraniczna | ✅ |
| XTB `JSW.WA` | true | polska (sufiks) | ❌ |
| XTB `PLTR` + USD | true | zagraniczna | ✅ |
| XTB placeholder + `PLN` | true | **polska** ⚠ | ❌ |
| mBank `KGHM` + PLN | true | polska | ❌ |
| mBank `MICRON TECH` + USD | true | zagraniczna | ✅ |

### Co z tego wynika

**Dla mBanku i XTB-placeholdera waluta przesądza o wszystkim.** Instrument zagraniczny z etykietą `PLN` trafia w gałąź polską, gdzie z definicji go nie ma — a katalog GPW/NC podsuwa spółkę o podobnej nazwie. Tak Vertiv (NYSE) stał się MPLVERBUM z NewConnect.

**Walidacja trafień nie chroni ścieżki realnych ISIN-ów.** Bramka to `isPseudoIsin && !isPolishTicker && !cfdKnown`, więc Bossa, DEGIRO i IBKR jej nie dostają. To świadoma decyzja — ta ścieżka nie została zmierzona na produkcji — ale **pozostaje otwartym ryzykiem**: Yahoo potrafi na zapytanie ISIN-em zwrócić kompletnie inną spółkę (`US75960P1049` → Remitly zamiast Reliance Global).

---

## Asymetrie warte zapamiętania

| obserwacja | konsekwencja |
|---|---|
| Guard NC offline wymaga sufiksu `-NC` | osiągalny **wyłącznie z Bossy** |
| Guard delisted kluczowany ISIN-em | działa dla Bossy/DEGIRO/IBKR, nie dla XTB/mBanku |
| `normalizeBossaPaperName` stosowana do **wszystkich** parserów | mimo nazwy — to ona ścina `.WA` z pseudo-ISIN-ów XTB |
| `ISIN_ALIASES_MAP` ma tylko wpisy w formie symboli XTB | wywołanie `applyIsinAlias` z Bossy jest dziś no-opem |
| Opcje IBKR seedowane przed resolverem | `OPT:` nigdy nie trafia do Yahoo |
| DEGIRO nie ustawia `category` | gałęzie `bond`/`cfd` w resolverze są dla niego martwe |

---

## Powiązane

- `services/isin-resolver.ts` — wspólny punkt wejścia, guardy, gałęzie
- `services/ticker-match.ts` — walidacja trafień (`isPlausibleMatch`)
- `shared/src/option-symbols.ts` — OCC i pseudo-ISIN opcji
- `services/payment-currency-reconciler.ts` — korekta `paymentCurrency` po imporcie (Bossa, DEGIRO)
- `scripts/fix-mismatched-tickers.ts`, `scripts/fix-xtb-quote-currency.ts` — backfille naprawcze
