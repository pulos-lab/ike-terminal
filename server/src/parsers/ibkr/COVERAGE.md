# IBKR — pokrycie typów operacji

Katalog typów, które parser IBKR umie zaksięgować, oraz luk. **Źródłem prawdy jest
behawioralna sonda** [`__tests__/ibkr-coverage.test.ts`](../__tests__/ibkr-coverage.test.ts) —
tabela poniżej to jej czytelne streszczenie. Zmieniasz obsługę? Zaktualizuj test, on
tu pilnuje regresji.

Lista typów pochodzi z enumów IBKR (`ibflex`: `Reorg`, `CashAction`).

## Stan na realnych danych: brak luk

Przepuszczenie 6 realnych wyciągów (2021-2025, 2 konta) przez `parseIbkrFile` daje **ZERO
warningów fallback/dropped** — parser klasyfikuje 100% obecnych typów. Typy, które łatwo
wziąć za luki, są obsłużone przez WŁAŚCIWE sekcje (nie tam, gdzie intuicyjnie):
`Payment in Lieu` → `CombDiv` + `WithholdingTax` (→ `dividend` z WHT), `Commission Adjustment`
→ `CombDepWith` (→ `deposit`), odsetki brokera → `CombInt`. Jedyne realnie nieobsłużone typy
(zdarzenia korporacyjne poza Split/ISIN Change) **w naszych danych nie występują**.

## Dlaczego nie testujemy na publicznych sample'ach IBKR

Oficjalne publiczne wyciągi (`interactivebrokers.*/images/common/Statements/…`) używają
**starego DOM „Classic"** (`<table id="tblTransactions">` w `tblTransactionsDivContainer`),
a nasz parser i detekcja wymagają **nowego „Bootstrap"** (`<div id="tbl…_U<konto>Body">`
+ `table table-bordered`). Stary format nie jest wykrywany ani parsowany — i jest zbyt
ubogi (brak sekcji dywidend / corp actions). Dlatego sonda buduje minimalne fixtury w
nowym formacie, identycznym jak realne wyciągi 2021-2025.

## Zdarzenia korporacyjne (Reorg)

Kolumna „w próbkach" to liczba wystąpień w 37 realnych plikach Flex Query czterech
niezależnych projektów (`import/public-samples/ibkr/`). Flex i HTML niosą **ten sam
tekst opisu**, więc to reprezentatywna miara tego, co realnie dzieje się na rachunkach
IBKR — i jedyna, jaką mamy, bo nasze własne wyciągi zawierają wyłącznie splity i zmiany ISIN.

| Typ | Kod | w próbkach | Status | Uwagi |
|---|---|---|---|---|
| Reverse Split | RS | 16 | ✅ handled | ratio ułamkowe |
| CUSIP/ISIN Change | IC | 12 | ✅ handled | marker zmiany ISIN |
| Forward Split | FS/FI | 5 | ✅ handled | marker splitu |
| **Stock Dividend / bonus** | **HI** | **4** | ✅ handled | syntetyczny zakup po cenie 0 |
| Stock Dividend / bonus | SD | 1 | ✅ handled | ten sam wzorzec co `HI` |
| Delist / worthless | DW | 3 | ✅ handled | syntetyczna sprzedaż po 0 — cała wartość jako strata |
| **Merger / przejęcie** | TC | **23** | ❌ dropped | wymiana akcji/gotówki ginie |
| Tender / wezwanie | TO/TI | 6 | ❌ dropped | pozycja wisi jako otwarta |
| Spinoff | SO/CO | 4 | ❌ dropped | brak nowej pozycji |
| Bond / T-Bill Maturity | BM/TM | 3 | ❌ dropped | kupon łapany osobno, nominał nie |
| Rights / Subscription | RI/SR/DI | 2 | ❌ dropped | brak praw poboru |

`dropped` = warning nazywający KONKRETNY skutek dla portfela („pozycja spółki
przejmowanej zostaje otwarta…"), wiersz pominięty.

**Dwie rzeczy warte zapamiętania z porównania z Flex:**

1. **`HI` nie było w tej tabeli**, a jest częstszym kodem stock dividendu niż udokumentowany
   `SD` (4 vs 1). Kto implementowałby wyłącznie z tej listy, przegapiłby większość przypadków.
2. **Merger jest najczęstszą akcją korporacyjną w realnych danych — częstszą niż wszystkie
   splity razem** (23 vs 21). To nie egzotyka. `TC` ma przy tym co najmniej trzy warianty:
   `MERGED(Liquidation) FOR USD 0.10 PER SHARE`, `CASH and STOCK MERGER (Acquisition) BAM
   9133631 FOR 100000000`, `MERGED(Voluntary Offer Allocation) FOR USD 20.75 PER SHARE` —
   więc jedna reguła nie wystarczy.

**Dlaczego wykup obligacji (BM/TM) świadomie został pominięty:** opis podaje cenę
„PER BOND" (np. `FOR USD 1.03125 PER BOND`), a my trzymamy kurs obligacji w PROCENTACH
nominału. Przeliczenia nie ma jak zweryfikować — nie mamy ani realnego wyciągu HTML
z wykupem, ani takiego przypadku na produkcji. Zgadywanie jednostki przy obligacjach
raz już kosztowało błąd ceny ×10 (review PR #143).

**Uwaga o osobnych silnikach:** `Spinoff` i `Tender` są „dropped" w tym parserze, ale
aplikacja obsługuje je na INNEJ warstwie — compute-time: spin-offy przez `spin-off-transform`
(mapa `spin-offs-map` + SEC ratio), wezwania przez `tender-offers-map`. Dlatego pominięcie
wiersza corp-action tutaj ≠ brak obsługi w aplikacji. Implementacja tych typów w parserze
IBKR wymaga uzgodnienia z tymi silnikami, żeby uniknąć **podwójnego księgowania**.

## Operacje gotówkowe (CashAction) — wszystkie obsłużone

| Typ | Sekcja realna | Status | Uwagi |
|---|---|---|---|
| Deposits & Withdrawals | CombDepWith | ✅ handled | |
| Commission Adjustment | CombDepWith | ✅ handled | → `deposit`/`withdrawal` wg znaku |
| Dividends + Withholding Tax | CombDiv + WithholdingTax | ✅ handled | WHT US 15% |
| **Payment in Lieu of Dividend** | CombDiv + WithholdingTax | ✅ handled | parowane → `dividend` z WHT |
| Bond Coupon / Purchase Accrued Interest | CombInt | ✅ handled | subkind `coupon` |
| Debit/Loan Interest (margin) | CombInt | ✅ handled | subkind `margin_interest` |
| Credit Interest | CombInt | ✅ handled | subkind `interest` |
| WHT od odsetek | WithholdingTax | ✅ handled | → `fee` |
| Borrow Fee | CombInt | ✅ handled | subkind `borrow_fee` |
| SYEP / Managed Securities | CombInt | ✅ handled | subkind `lending_income` |
| Other Fees | CombFees | ✅ handled | |
| _nieznany opis_ | CombInt | 🛟 safety net | generyczne `other`/`fee` + warning „nierozpoznany…" |

`safety net` = mechanizm dla PRZYSZŁYCH nieznanych opisów (na realnych danych nie odpala
się ani razu) — wiersz nie jest gubiony, ląduje w saldzie jako generyczna operacja.

## Jak sondować nowy/cudzy wyciąg

Parser sam raportuje luki — po imporcie przejrzyj `result.warnings` i `result.skipped`
(`reason: 'unknown_type'` trafia do skrzynki „Do wyjaśnienia"). Każdy nieobsłużony typ
się tam ujawni.
