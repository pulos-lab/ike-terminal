/**
 * Tłumaczenie taksonomii Yahoo (GICS-like) → stockwatch.pl (PL).
 *
 * Yahoo quoteSummary → assetProfile zwraca angielskie kategorie:
 *   sector:  Financial Services | Technology | Healthcare | ...
 *   industry: Banks—Regional | Software—Application | Biotechnology | ...
 *
 * Docelowo chcemy by sektor zagranicznej spółki lądował w tej samej nomenklaturze
 * co GPW (stockwatch.pl/gpw/sektory): 8 nadsektorów × 40 podsektorów.
 *
 * Funkcja czysta (no I/O), deterministyczna — łatwo testowalna.
 */

export interface StockwatchSector {
  supersector: string;
  subsector: string;
}

/**
 * Nadsektor stockwatch dla danego GICS sector.
 * Yahoo normalizuje większość akcji do 11 GICS sectors.
 */
const SECTOR_MAP: Record<string, string> = {
  // Financials (incl. REITs) → Finanse (stockwatch trzyma nieruchomości w Finansach)
  'Financial Services': 'Finanse',
  Financial: 'Finanse',
  'Real Estate': 'Finanse',

  // Tech / Comm → Technologie (media i gry: Handel i usługi jako default, ale industry overridze)
  Technology: 'Technologie',
  'Information Technology': 'Technologie',
  'Communication Services': 'Handel i usługi',

  // Healthcare
  Healthcare: 'Ochrona zdrowia',
  'Health Care': 'Ochrona zdrowia',

  // Energy & Utilities → Paliwa i Energia
  Energy: 'Paliwa i Energia',
  Utilities: 'Paliwa i Energia',

  // Materials → Chemia i surowce
  'Basic Materials': 'Chemia i surowce',
  Materials: 'Chemia i surowce',

  // Industrials → Produkcja przemysłowa
  Industrials: 'Produkcja przemysłowa',
  Industrial: 'Produkcja przemysłowa',

  // Consumer (discretionary + staples) → Dobra konsumpcyjne
  'Consumer Cyclical': 'Dobra konsumpcyjne',
  'Consumer Discretionary': 'Dobra konsumpcyjne',
  'Consumer Defensive': 'Dobra konsumpcyjne',
  'Consumer Staples': 'Dobra konsumpcyjne',
};

/**
 * Yahoo industry → stockwatch subsector (wraz z nadsektorem).
 * Dopasowanie na podstawie kanonicznych nazw Yahoo. Porównanie case-insensitive
 * i tolerujące '-' vs '—'.
 */
const INDUSTRY_MAP: Record<string, StockwatchSector> = {
  // ===== Finanse =====
  'banks—regional': { supersector: 'Finanse', subsector: 'Banki' },
  'banks—diversified': { supersector: 'Finanse', subsector: 'Banki' },
  banks: { supersector: 'Finanse', subsector: 'Banki' },
  'asset management': { supersector: 'Finanse', subsector: 'Działalność inwestycyjna' },
  'capital markets': { supersector: 'Finanse', subsector: 'Rynek kapitałowy' },
  'financial data & stock exchanges': { supersector: 'Finanse', subsector: 'Rynek kapitałowy' },
  'credit services': { supersector: 'Finanse', subsector: 'Pośrednictwo finansowe' },
  'mortgage finance': { supersector: 'Finanse', subsector: 'Pośrednictwo finansowe' },
  'insurance—life': { supersector: 'Finanse', subsector: 'Ubezpieczenia' },
  'insurance—property & casualty': { supersector: 'Finanse', subsector: 'Ubezpieczenia' },
  'insurance—diversified': { supersector: 'Finanse', subsector: 'Ubezpieczenia' },
  'insurance—reinsurance': { supersector: 'Finanse', subsector: 'Ubezpieczenia' },
  'insurance—specialty': { supersector: 'Finanse', subsector: 'Ubezpieczenia' },
  'insurance brokers': { supersector: 'Finanse', subsector: 'Ubezpieczenia' },
  'reit—residential': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'reit—retail': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'reit—office': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'reit—industrial': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'reit—diversified': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'reit—healthcare facilities': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'reit—hotel & motel': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'reit—mortgage': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'reit—specialty': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'real estate services': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'real estate—development': { supersector: 'Finanse', subsector: 'Nieruchomości' },
  'real estate—diversified': { supersector: 'Finanse', subsector: 'Nieruchomości' },

  // ===== Technologie =====
  'software—application': { supersector: 'Technologie', subsector: 'Informatyka' },
  'software—infrastructure': { supersector: 'Technologie', subsector: 'Informatyka' },
  'information technology services': { supersector: 'Technologie', subsector: 'Informatyka' },
  semiconductors: { supersector: 'Technologie', subsector: 'Informatyka' },
  'semiconductor equipment & materials': { supersector: 'Technologie', subsector: 'Informatyka' },
  'computer hardware': { supersector: 'Technologie', subsector: 'Informatyka' },
  'consumer electronics': { supersector: 'Technologie', subsector: 'Informatyka' },
  'electronic components': { supersector: 'Technologie', subsector: 'Informatyka' },
  'electronics & computer distribution': { supersector: 'Technologie', subsector: 'Informatyka' },
  'scientific & technical instruments': { supersector: 'Technologie', subsector: 'Informatyka' },
  solar: { supersector: 'Paliwa i Energia', subsector: 'Energia' },
  'telecom services': { supersector: 'Technologie', subsector: 'Telekomunikacja' },

  // ===== Handel i usługi (część Communication Services oraz Consumer Cyclical) =====
  'electronic gaming & multimedia': { supersector: 'Handel i usługi', subsector: 'Gry' },
  entertainment: { supersector: 'Handel i usługi', subsector: 'Media' },
  broadcasting: { supersector: 'Handel i usługi', subsector: 'Media' },
  publishing: { supersector: 'Handel i usługi', subsector: 'Media' },
  'advertising agencies': { supersector: 'Handel i usługi', subsector: 'Media' },
  'internet content & information': { supersector: 'Handel i usługi', subsector: 'Media' },
  'internet retail': { supersector: 'Handel i usługi', subsector: 'Handel internetowy' },
  'specialty retail': { supersector: 'Handel i usługi', subsector: 'Sieci handlowe' },
  'apparel retail': { supersector: 'Handel i usługi', subsector: 'Sieci handlowe' },
  'department stores': { supersector: 'Handel i usługi', subsector: 'Sieci handlowe' },
  'discount stores': { supersector: 'Handel i usługi', subsector: 'Sieci handlowe' },
  'luxury goods': { supersector: 'Handel i usługi', subsector: 'Sieci handlowe' },
  'home improvement retail': { supersector: 'Handel i usługi', subsector: 'Sieci handlowe' },
  'food distribution': { supersector: 'Handel i usługi', subsector: 'Handel hurtowy' },
  'grocery stores': { supersector: 'Handel i usługi', subsector: 'Sieci handlowe' },
  leisure: { supersector: 'Handel i usługi', subsector: 'Rekreacja i wypoczynek' },
  'resorts & casinos': { supersector: 'Handel i usługi', subsector: 'Rekreacja i wypoczynek' },
  gambling: { supersector: 'Handel i usługi', subsector: 'Rekreacja i wypoczynek' },
  lodging: { supersector: 'Handel i usługi', subsector: 'Rekreacja i wypoczynek' },
  restaurants: { supersector: 'Handel i usługi', subsector: 'Rekreacja i wypoczynek' },
  'travel services': { supersector: 'Handel i usługi', subsector: 'Rekreacja i wypoczynek' },

  // ===== Ochrona zdrowia =====
  biotechnology: { supersector: 'Ochrona zdrowia', subsector: 'Biotechnologia' },
  'drug manufacturers—general': { supersector: 'Ochrona zdrowia', subsector: 'Produkcja leków' },
  'drug manufacturers—specialty & generic': {
    supersector: 'Ochrona zdrowia',
    subsector: 'Produkcja leków',
  },
  'pharmaceutical retailers': { supersector: 'Ochrona zdrowia', subsector: 'Dystrybucja leków' },
  'medical distribution': { supersector: 'Ochrona zdrowia', subsector: 'Dystrybucja leków' },
  'medical devices': { supersector: 'Ochrona zdrowia', subsector: 'Sprzęt i materiały medyczne' },
  'medical instruments & supplies': {
    supersector: 'Ochrona zdrowia',
    subsector: 'Sprzęt i materiały medyczne',
  },
  'diagnostics & research': {
    supersector: 'Ochrona zdrowia',
    subsector: 'Sprzęt i materiały medyczne',
  },
  'medical care facilities': {
    supersector: 'Ochrona zdrowia',
    subsector: 'Szpitale i przychodnie',
  },
  'health information services': { supersector: 'Ochrona zdrowia', subsector: 'Pozostałe' },
  'healthcare plans': { supersector: 'Ochrona zdrowia', subsector: 'Pozostałe' },

  // ===== Paliwa i Energia =====
  'oil & gas integrated': { supersector: 'Paliwa i Energia', subsector: 'Paliwa i gaz' },
  'oil & gas e&p': { supersector: 'Paliwa i Energia', subsector: 'Paliwa i gaz' },
  'oil & gas midstream': { supersector: 'Paliwa i Energia', subsector: 'Paliwa i gaz' },
  'oil & gas refining & marketing': { supersector: 'Paliwa i Energia', subsector: 'Paliwa i gaz' },
  'oil & gas equipment & services': { supersector: 'Paliwa i Energia', subsector: 'Paliwa i gaz' },
  'oil & gas drilling': { supersector: 'Paliwa i Energia', subsector: 'Paliwa i gaz' },
  'thermal coal': { supersector: 'Paliwa i Energia', subsector: 'Paliwa i gaz' },
  uranium: { supersector: 'Paliwa i Energia', subsector: 'Energia' },
  'utilities—regulated electric': { supersector: 'Paliwa i Energia', subsector: 'Energia' },
  'utilities—regulated gas': { supersector: 'Paliwa i Energia', subsector: 'Paliwa i gaz' },
  'utilities—regulated water': { supersector: 'Paliwa i Energia', subsector: 'Energia' },
  'utilities—independent power producers': {
    supersector: 'Paliwa i Energia',
    subsector: 'Energia',
  },
  'utilities—renewable': { supersector: 'Paliwa i Energia', subsector: 'Energia' },
  'utilities—diversified': { supersector: 'Paliwa i Energia', subsector: 'Energia' },

  // ===== Chemia i surowce =====
  chemicals: { supersector: 'Chemia i surowce', subsector: 'Chemia' },
  'specialty chemicals': { supersector: 'Chemia i surowce', subsector: 'Chemia' },
  'agricultural inputs': { supersector: 'Chemia i surowce', subsector: 'Chemia' },
  steel: { supersector: 'Chemia i surowce', subsector: 'Hutnictwo' },
  aluminum: { supersector: 'Chemia i surowce', subsector: 'Hutnictwo' },
  copper: { supersector: 'Chemia i surowce', subsector: 'Hutnictwo' },
  gold: { supersector: 'Chemia i surowce', subsector: 'Górnictwo' },
  silver: { supersector: 'Chemia i surowce', subsector: 'Górnictwo' },
  'other precious metals & mining': { supersector: 'Chemia i surowce', subsector: 'Górnictwo' },
  'other industrial metals & mining': { supersector: 'Chemia i surowce', subsector: 'Górnictwo' },
  'coking coal': { supersector: 'Chemia i surowce', subsector: 'Górnictwo' },
  'paper & paper products': { supersector: 'Chemia i surowce', subsector: 'Drewno i papier' },
  'lumber & wood production': { supersector: 'Chemia i surowce', subsector: 'Drewno i papier' },
  'building materials': { supersector: 'Produkcja przemysłowa', subsector: 'Budownictwo' },
  'waste management': { supersector: 'Chemia i surowce', subsector: 'Recykling' },
  'pollution & treatment controls': { supersector: 'Chemia i surowce', subsector: 'Recykling' },

  // ===== Produkcja przemysłowa =====
  'aerospace & defense': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Przemysł elektromaszynowy',
  },
  'industrial machinery': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Przemysł elektromaszynowy',
  },
  'specialty industrial machinery': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Przemysł elektromaszynowy',
  },
  'farm & heavy construction machinery': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Przemysł elektromaszynowy',
  },
  'electrical equipment & parts': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Przemysł elektromaszynowy',
  },
  'engineering & construction': { supersector: 'Produkcja przemysłowa', subsector: 'Budownictwo' },
  'infrastructure operations': { supersector: 'Produkcja przemysłowa', subsector: 'Budownictwo' },
  airlines: { supersector: 'Produkcja przemysłowa', subsector: 'Transport i logistyka' },
  'airports & air services': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Transport i logistyka',
  },
  'marine shipping': { supersector: 'Produkcja przemysłowa', subsector: 'Transport i logistyka' },
  railroads: { supersector: 'Produkcja przemysłowa', subsector: 'Transport i logistyka' },
  trucking: { supersector: 'Produkcja przemysłowa', subsector: 'Transport i logistyka' },
  'integrated freight & logistics': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Transport i logistyka',
  },
  'business equipment & supplies': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Zaopatrzenie przedsiębiorstw',
  },
  'specialty business services': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Usługi dla przedsiębiorstw',
  },
  'staffing & employment services': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Usługi dla przedsiębiorstw',
  },
  'consulting services': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Usługi dla przedsiębiorstw',
  },
  'security & protection services': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Usługi dla przedsiębiorstw',
  },
  'rental & leasing services': { supersector: 'Finanse', subsector: 'Leasing i faktoring' },
  conglomerates: { supersector: 'Produkcja przemysłowa', subsector: 'Usługi dla przedsiębiorstw' },
  'tools & accessories': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Zaopatrzenie przedsiębiorstw',
  },
  'metal fabrication': {
    supersector: 'Produkcja przemysłowa',
    subsector: 'Zaopatrzenie przedsiębiorstw',
  },

  // ===== Dobra konsumpcyjne =====
  'auto manufacturers': { supersector: 'Dobra konsumpcyjne', subsector: 'Motoryzacja' },
  'auto parts': { supersector: 'Dobra konsumpcyjne', subsector: 'Motoryzacja' },
  'auto & truck dealerships': { supersector: 'Dobra konsumpcyjne', subsector: 'Motoryzacja' },
  'recreational vehicles': { supersector: 'Dobra konsumpcyjne', subsector: 'Motoryzacja' },
  'apparel manufacturing': { supersector: 'Dobra konsumpcyjne', subsector: 'Odzież i kosmetyki' },
  'footwear & accessories': { supersector: 'Dobra konsumpcyjne', subsector: 'Odzież i kosmetyki' },
  'textile manufacturing': { supersector: 'Dobra konsumpcyjne', subsector: 'Odzież i kosmetyki' },
  'personal services': { supersector: 'Dobra konsumpcyjne', subsector: 'Odzież i kosmetyki' },
  'household & personal products': {
    supersector: 'Dobra konsumpcyjne',
    subsector: 'Odzież i kosmetyki',
  },
  'packaged foods': { supersector: 'Dobra konsumpcyjne', subsector: 'Artykuły spożywcze' },
  confectioners: { supersector: 'Dobra konsumpcyjne', subsector: 'Artykuły spożywcze' },
  'beverages—non-alcoholic': { supersector: 'Dobra konsumpcyjne', subsector: 'Artykuły spożywcze' },
  'beverages—wineries & distilleries': {
    supersector: 'Dobra konsumpcyjne',
    subsector: 'Artykuły spożywcze',
  },
  'beverages—brewers': { supersector: 'Dobra konsumpcyjne', subsector: 'Artykuły spożywcze' },
  tobacco: { supersector: 'Dobra konsumpcyjne', subsector: 'Artykuły spożywcze' },
  'farm products': { supersector: 'Dobra konsumpcyjne', subsector: 'Artykuły spożywcze' },
  'furnishings, fixtures & appliances': {
    supersector: 'Dobra konsumpcyjne',
    subsector: 'Wyposażenie domu',
  },
  'residential construction': { supersector: 'Produkcja przemysłowa', subsector: 'Budownictwo' },
  'packaging & containers': {
    supersector: 'Chemia i surowce',
    subsector: 'Guma i tworzywa sztuczne',
  },
  'rubber & plastics': { supersector: 'Chemia i surowce', subsector: 'Guma i tworzywa sztuczne' },
  'education & training services': { supersector: 'Dobra konsumpcyjne', subsector: 'Pozostałe' },
  'leisure products': { supersector: 'Dobra konsumpcyjne', subsector: 'Pozostałe' },
};

/**
 * Normalizacja klucza: lowercase + zamiana '—' (em-dash, używany przez Yahoo)
 * oraz '–' (en-dash) na zwykłe '-', żeby lookup był stabilny.
 */
function normalizeIndustryKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[–—]/g, '-') // en-dash / em-dash → plain '-'
    .replace(/\s+/g, ' ')
    .trim();
}

// Wygenerowany na fly lookup z kluczami znormalizowanymi, żeby dopasowywać oba warianty myślnika.
const INDUSTRY_MAP_NORMALIZED: Record<string, StockwatchSector> = (() => {
  const out: Record<string, StockwatchSector> = {};
  for (const [k, v] of Object.entries(INDUSTRY_MAP)) {
    out[normalizeIndustryKey(k.replace(/—/g, '-'))] = v;
  }
  return out;
})();

/**
 * Główna funkcja tłumacząca. Zwraca `null` gdy nawet sektor jest nieznany
 * (caller ustawi "Inne"). Gdy sektor jest znany a industry nie — zwraca
 * { supersector, subsector: 'Pozostałe' }.
 */
export function mapGicsToStockwatch(
  sector: string | null | undefined,
  industry: string | null | undefined,
): StockwatchSector | null {
  // 1) Industry → pełne trafienie (supersector + subsector)
  if (industry) {
    const key = normalizeIndustryKey(industry);
    const hit = INDUSTRY_MAP_NORMALIZED[key];
    if (hit) return hit;
  }

  // 2) Sam sector → odgadujemy nadsektor, subsector = "Pozostałe"
  if (sector) {
    const superS = SECTOR_MAP[sector.trim()];
    if (superS) {
      return { supersector: superS, subsector: 'Pozostałe' };
    }
  }

  // 3) Nic nie rozpoznane
  return null;
}

/**
 * Self-test (nie jest prawdziwym frameworkiem testowym; sprawdzany w dev
 * przez prostą import-side effect assert w scripts/test-gics-to-stockwatch.ts
 * jeśli będzie potrzebny). Tutaj eksponujemy referencyjne przypadki jako
 * konstantę by łatwiej było weryfikować w REPL.
 */
export const GICS_REFERENCE_CASES: Array<{
  sector: string | null;
  industry: string | null;
  expected: StockwatchSector | null;
}> = [
  {
    sector: 'Financial Services',
    industry: 'Banks—Regional',
    expected: { supersector: 'Finanse', subsector: 'Banki' },
  },
  {
    sector: 'Technology',
    industry: 'Software—Application',
    expected: { supersector: 'Technologie', subsector: 'Informatyka' },
  },
  {
    sector: 'Communication Services',
    industry: 'Electronic Gaming & Multimedia',
    expected: { supersector: 'Handel i usługi', subsector: 'Gry' },
  },
  {
    sector: 'Healthcare',
    industry: 'Biotechnology',
    expected: { supersector: 'Ochrona zdrowia', subsector: 'Biotechnologia' },
  },
  {
    sector: 'Energy',
    industry: 'Oil & Gas Integrated',
    expected: { supersector: 'Paliwa i Energia', subsector: 'Paliwa i gaz' },
  },
  {
    sector: 'Utilities',
    industry: 'Utilities—Regulated Electric',
    expected: { supersector: 'Paliwa i Energia', subsector: 'Energia' },
  },
  {
    sector: 'Basic Materials',
    industry: 'Gold',
    expected: { supersector: 'Chemia i surowce', subsector: 'Górnictwo' },
  },
  {
    sector: 'Industrials',
    industry: 'Aerospace & Defense',
    expected: { supersector: 'Produkcja przemysłowa', subsector: 'Przemysł elektromaszynowy' },
  },
  {
    sector: 'Consumer Cyclical',
    industry: 'Auto Manufacturers',
    expected: { supersector: 'Dobra konsumpcyjne', subsector: 'Motoryzacja' },
  },
  {
    sector: 'Real Estate',
    industry: 'REIT—Residential',
    expected: { supersector: 'Finanse', subsector: 'Nieruchomości' },
  },
  // fallback: znany sector, nieznany industry
  {
    sector: 'Technology',
    industry: 'Definitely Not A Real Industry',
    expected: { supersector: 'Technologie', subsector: 'Pozostałe' },
  },
  // fallback: oba nieznane
  { sector: null, industry: null, expected: null },
];
