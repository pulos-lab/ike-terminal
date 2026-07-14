# IBKR — pokrycie typów operacji

Katalog typów, które parser IBKR umie zaksięgować, oraz luk. **Źródłem prawdy jest
behawioralna sonda** [`__tests__/ibkr-coverage.test.ts`](../__tests__/ibkr-coverage.test.ts) —
tabela poniżej to jej czytelne streszczenie. Zmieniasz obsługę? Zaktualizuj test, on
tu pilnuje regresji.

Lista typów pochodzi z enumów IBKR (`ibflex`: `Reorg`, `CashAction`).

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

## Operacje gotówkowe (CashAction → CombInt/CombFees/CombDiv/…)

| Typ | Status | Uwagi |
|---|---|---|
| Deposits & Withdrawals | ✅ handled | |
| Dividends + Withholding Tax | ✅ handled | WHT US 15% |
| Bond Coupon / Purchase Accrued Interest | ✅ handled | subkind `coupon` |
| Debit/Loan Interest (margin) | ✅ handled | subkind `margin_interest` |
| Credit Interest | ✅ handled | subkind `interest` |
| Borrow Fee | ✅ handled | subkind `borrow_fee` |
| SYEP / Managed Securities | ✅ handled | subkind `lending_income` |
| Other Fees | ✅ handled | |
| **Payment In Lieu Of Dividend** | ⚠️ fallback | generyczne `other`, bez subkind |
| **Broker Interest Paid** | ⚠️ fallback | wpada w `fee` bez subkind |
| **Commission Adjustments** | ⚠️ fallback | |
| **Advisor Fees** | ⚠️ fallback | |

`fallback` = importowane jako generyczne `other`/`fee` + warning „nierozpoznany wiersz
odsetek/opłat …" (jest w saldzie, ale bez właściwej kategorii).

## Jak sondować nowy/cudzy wyciąg

Parser sam raportuje luki — po imporcie przejrzyj `result.warnings` i `result.skipped`
(`reason: 'unknown_type'` trafia do skrzynki „Do wyjaśnienia"). Każdy nieobsłużony typ
się tam ujawni.
