import { useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Upload,
  Zap,
  Coins,
  Globe,
  Shield,
  ArrowRight,
} from 'lucide-react';
import { AppDemo } from './AppDemo';

const FEATURES = [
  {
    icon: LayoutDashboard,
    title: 'Dashboard z benchmarkiem',
    description:
      'Porównaj zwrot portfela z indeksami (S&P 500, WIG, NASDAQ). MWR, TWR, Sharpe, Max Drawdown i więcej.',
  },
  {
    icon: Upload,
    title: 'Import z brokerów',
    description:
      'Automatyczny import transakcji z Bossa, mBank, DEGIRO i XTB. Jeden plik CSV/XLSX — wszystko gotowe.',
  },
  {
    icon: Zap,
    title: 'Ceny na żywo',
    description:
      'Bieżące wyceny z GPW, NYSE, NASDAQ, XETRA i NewConnect. Cache i fallbacki — zawsze aktualne dane.',
  },
  {
    icon: Coins,
    title: 'Dywidendy i gotówka',
    description:
      'Śledzenie dywidend z podziałem na waluty. Historia wpłat i wypłat z limitem IKE/IKZE.',
  },
  {
    icon: Globe,
    title: 'Multi-walutowy',
    description:
      'PLN, USD, EUR, GBP, CAD i więcej. Automatyczne przeliczanie kursów walut i historia wymian.',
  },
  {
    icon: Shield,
    title: 'IKE / IKZE ready',
    description:
      'Dedykowane konta emerytalne z ustawieniami prowizji i limitów wpłat rocznych.',
  },
];

const BROKERS = [
  { name: 'Bossa', color: '#dc2626' },
  { name: 'mBank', color: '#2563eb' },
  { name: 'DEGIRO', color: '#0891b2' },
  { name: 'XTB', color: '#16a34a' },
];

export function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="border-b border-zinc-800/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center text-sm font-bold">
              T
            </div>
            <span className="text-lg font-bold">TIX Terminal</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/login')}
              className="text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Zaloguj się
            </button>
            <button
              onClick={() => navigate('/login?register=1')}
              className="text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Rozpocznij
            </button>
          </div>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        {/* Green glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-green-500/5 rounded-full blur-[120px] pointer-events-none" />

        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-16 sm:pt-24 pb-12 text-center relative">
          <div className="inline-block bg-green-500/10 text-green-400 text-xs font-medium px-3 py-1 rounded-full mb-6">
            Darmowe dla inwestorów indywidualnych
          </div>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold leading-tight mb-4 max-w-3xl mx-auto">
            Twój portfel inwestycyjny
            <br />
            <span className="text-green-500">w jednym miejscu</span>
          </h1>
          <p className="text-base sm:text-lg text-zinc-400 max-w-xl mx-auto mb-8">
            Importuj transakcje z wielu brokerów, śledź wyniki na żywo i analizuj
            zwroty vs benchmarki — wszystko w jednym narzędziu.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={() => navigate('/login?register=1')}
              className="w-full sm:w-auto bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              Rozpocznij za darmo
              <ArrowRight className="w-4 h-4" />
            </button>
            <a
              href="#demo"
              className="w-full sm:w-auto border border-zinc-700 hover:border-zinc-500 text-zinc-300 px-6 py-3 rounded-lg font-medium transition-colors text-center"
            >
              Zobacz demo
            </a>
          </div>
        </div>
      </section>

      {/* ── Interactive Demo ──────────────────────────────────────────── */}
      <section id="demo" className="max-w-6xl mx-auto px-4 sm:px-6 pb-20">
        <div className="text-center mb-8">
          <h2 className="text-xl sm:text-2xl font-bold mb-2">Zobacz jak to działa</h2>
          <p className="text-zinc-500 text-sm">
            Kliknij w nawigację, żeby zobaczyć główne widoki aplikacji
          </p>
        </div>
        <AppDemo />
      </section>

      {/* ── Features ──────────────────────────────────────────────────── */}
      <section className="border-t border-zinc-800/50 bg-[#0d0d0d]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
          <div className="text-center mb-12">
            <h2 className="text-xl sm:text-2xl font-bold mb-2">Funkcjonalności</h2>
            <p className="text-zinc-500 text-sm">
              Wszystko czego potrzebujesz do zarządzania portfelem
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.title}
                  className="bg-[#111] border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition-colors"
                >
                  <div className="w-10 h-10 bg-green-500/10 rounded-lg flex items-center justify-center mb-3">
                    <Icon className="w-5 h-5 text-green-500" />
                  </div>
                  <h3 className="font-semibold mb-1.5">{f.title}</h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">{f.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Brokers ───────────────────────────────────────────────────── */}
      <section className="border-t border-zinc-800/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 text-center">
          <h2 className="text-lg sm:text-xl font-bold mb-2">Obsługiwani brokerzy</h2>
          <p className="text-zinc-500 text-sm mb-8">
            Importuj dane jednym klikiem — auto-detekcja formatu
          </p>
          <div className="flex flex-wrap items-center justify-center gap-6 sm:gap-10">
            {BROKERS.map((b) => (
              <div key={b.name} className="flex items-center gap-2">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold text-white"
                  style={{ backgroundColor: b.color }}
                >
                  {b.name[0]}
                </div>
                <span className="text-zinc-300 font-medium">{b.name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────────── */}
      <section className="border-t border-zinc-800/50 bg-[#0d0d0d]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20 text-center">
          <h2 className="text-xl sm:text-2xl font-bold mb-3">
            Zacznij śledzić swój portfel
          </h2>
          <p className="text-zinc-400 text-sm mb-6 max-w-md mx-auto">
            Załóż darmowe konto, zaimportuj transakcje i analizuj swoje inwestycje.
          </p>
          <button
            onClick={() => navigate('/login?register=1')}
            className="bg-green-600 hover:bg-green-700 text-white px-8 py-3 rounded-lg font-medium transition-colors inline-flex items-center gap-2"
          >
            Utwórz konto
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="border-t border-zinc-800/50 py-6">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between text-xs text-zinc-600">
          <span>&copy; {new Date().getFullYear()} TIX Terminal</span>
          <span>Portfel inwestycyjny dla polskich inwestorów</span>
        </div>
      </footer>
    </div>
  );
}
