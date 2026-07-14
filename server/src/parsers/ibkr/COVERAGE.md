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

| Typ | Kod | Status | Uwagi |
|---|---|---|---|
| Forward Split | FS/FI | ✅ handled | marker splitu |
| Reverse Split | RS | ✅ handled | ratio ułamkowe |
| CUSIP/ISIN Change | IC | ✅ handled | marker zmiany ISIN |
| Merger / przejęcie | TC | ❌ dropped | wymiana akcji/gotówki ginie |
| Spinoff | SO/CO | ❌ dropped | brak nowej pozycji |
| Stock Dividend / bonus | SD | ❌ dropped | zaniżona liczba akcji |
| Rights / Subscription | RI/SR/DI | ❌ dropped | brak praw poboru |
| Tender / wezwanie | TO/TI | ❌ dropped | pozycja wisi jako otwarta |
| Delist / worthless | DW | ❌ dropped | strata nie zaksięgowana |
| Bond / T-Bill Maturity | BM/TM | ❌ dropped | kupon łapany osobno, nominał nie |

`dropped` = warning „nieobsłużone zdarzenie korporacyjne …", wiersz pominięty.

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
