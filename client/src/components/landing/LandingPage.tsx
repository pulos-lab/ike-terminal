import { useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Upload,
  Zap,
  Coins,
  Globe,
  Shield,
  ArrowRight,
  Play,
  MousePointerClick,
} from 'lucide-react';
import { Logo } from '@/components/ui/Logo';

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
      'Automatyczny import z Bossa, mBank, DEGIRO, XTB i Interactive Brokers. Inny broker? Uniwersalny import CSV/XLSX z pomocą AI.',
  },
  {
    icon: Zap,
    title: 'Ceny na żywo',
    description:
      'Bieżące wyceny z GPW, NewConnect, Catalyst, NYSE, NASDAQ i XETRA. Cache i fallbacki — zawsze aktualne dane.',
  },
  {
    icon: Coins,
    title: 'Dywidendy i gotówka',
    description:
      'Automatyczne wykrywanie dywidend, podatek u źródła, historia wpłat z limitem IKE/IKZE.',
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
    description: 'Dedykowane konta emerytalne z ustawieniami prowizji i limitów wpłat rocznych.',
  },
];

const BROKERS = [
  { name: 'Bossa', color: '#dc2626' },
  { name: 'mBank', color: '#2563eb' },
  { name: 'DEGIRO', color: '#0891b2' },
  { name: 'XTB', color: '#16a34a' },
  { name: 'IBKR', color: '#b91c1c' },
];

export function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#0b0a09] text-foreground">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="border-b border-stone-800/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Logo size="md" />
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/login')}
              className="text-sm text-stone-400 hover:text-foreground transition-colors"
            >
              Zaloguj się
            </button>
            <button
              onClick={() => navigate('/login?register=1')}
              className="text-sm bg-amber-500 hover:bg-amber-600 text-stone-950 font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              Rozpocznij
            </button>
          </div>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        {/* Amber glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-amber-500/8 rounded-full blur-[120px] pointer-events-none" />

        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-16 sm:pt-24 pb-12 text-center relative">
          <div className="inline-block bg-amber-500/10 text-amber-400 text-xs font-medium px-3 py-1 rounded-full mb-6">
            Darmowe dla inwestorów indywidualnych
          </div>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold leading-tight mb-4 max-w-3xl mx-auto tracking-tight">
            Twój portfel inwestycyjny
            <br />
            <span className="text-amber-500">w jednym miejscu</span>
          </h1>
          <p className="text-base sm:text-lg text-stone-400 max-w-xl mx-auto mb-8">
            Importuj transakcje z wielu brokerów, śledź wyniki na żywo i analizuj zwroty vs
            benchmarki — wszystko w jednym narzędziu.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={() => navigate('/demo')}
              className="w-full sm:w-auto bg-amber-500 hover:bg-amber-600 text-stone-950 font-semibold px-6 py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <Play className="w-4 h-4" />
              Wypróbuj demo bez konta
            </button>
            <button
              onClick={() => navigate('/login?register=1')}
              className="w-full sm:w-auto border border-stone-700 hover:border-stone-500 text-stone-300 px-6 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              Załóż darmowe konto
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      {/* ── Live demo teaser ──────────────────────────────────────────── */}
      <section id="demo" className="max-w-6xl mx-auto px-4 sm:px-6 pb-20">
        <div className="text-center mb-8">
          <h2 className="text-xl sm:text-2xl font-bold mb-2 tracking-tight">
            Zobacz jak to działa — naprawdę
          </h2>
          <p className="text-stone-500 text-sm max-w-xl mx-auto">
            To nie makieta. Jedno kliknięcie otwiera prawdziwą aplikację na przykładowym portfelu
            IKE — z wykresem vs WIG, pozycjami wycenianymi na żywo, dywidendami i historią wpłat.
          </p>
        </div>

        {/* Ramka "przeglądarki" z realnym zrzutem dashboardu demo */}
        <button
          onClick={() => navigate('/demo')}
          aria-label="Otwórz demo aplikacji"
          className="group block w-full text-left rounded-xl border border-stone-800 hover:border-amber-500/50 bg-[#141210] overflow-hidden shadow-2xl shadow-black/40 transition-colors"
        >
          <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-stone-800 bg-[#0d0c0a]">
            <span className="w-2.5 h-2.5 rounded-full bg-stone-700" />
            <span className="w-2.5 h-2.5 rounded-full bg-stone-700" />
            <span className="w-2.5 h-2.5 rounded-full bg-stone-700" />
            <span className="ml-3 text-[11px] text-stone-600 truncate">
              tixterminal.app/app — Portfel demo
            </span>
          </div>
          <div className="relative">
            <img
              src="/demo-dashboard.png"
              alt="Dashboard TIX Terminal na przykładowym portfelu demo"
              loading="lazy"
              className="w-full h-auto block"
            />
            {/* Overlay CTA na hover/focus */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
              <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2 bg-amber-500 text-stone-950 font-semibold px-5 py-2.5 rounded-lg text-sm">
                <MousePointerClick className="w-4 h-4" />
                Kliknij i przeglądaj demo
              </span>
            </div>
          </div>
        </button>

        <p className="text-center text-stone-600 text-xs mt-4">
          Tryb demo jest tylko do odczytu — własne dane dodasz po założeniu darmowego konta.
        </p>
      </section>

      {/* ── Features ──────────────────────────────────────────────────── */}
      <section className="border-t border-stone-800/60 bg-[#0d0c0a]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
          <div className="text-center mb-12">
            <h2 className="text-xl sm:text-2xl font-bold mb-2 tracking-tight">Funkcjonalności</h2>
            <p className="text-stone-500 text-sm">
              Wszystko czego potrzebujesz do zarządzania portfelem
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.title}
                  className="bg-[#141210] border border-stone-800 rounded-xl p-5 hover:border-stone-700 transition-colors"
                >
                  <div className="w-10 h-10 bg-amber-500/10 rounded-lg flex items-center justify-center mb-3">
                    <Icon className="w-5 h-5 text-amber-500" />
                  </div>
                  <h3 className="font-semibold mb-1.5 tracking-tight">{f.title}</h3>
                  <p className="text-sm text-stone-400 leading-relaxed">{f.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Brokers ───────────────────────────────────────────────────── */}
      <section className="border-t border-stone-800/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 text-center">
          <h2 className="text-lg sm:text-xl font-bold mb-2 tracking-tight">Obsługiwani brokerzy</h2>
          <p className="text-stone-500 text-sm mb-8">
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
                <span className="text-stone-300 font-medium">{b.name}</span>
              </div>
            ))}
          </div>
          <p className="text-stone-600 text-xs mt-6">
            …i inni — uniwersalny import CSV/XLSX dopasuje się do formatu Twojego brokera.
          </p>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────────── */}
      <section className="border-t border-stone-800/60 bg-[#0d0c0a]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20 text-center">
          <h2 className="text-xl sm:text-2xl font-bold mb-3 tracking-tight">
            Zacznij śledzić swój portfel
          </h2>
          <p className="text-stone-400 text-sm mb-6 max-w-md mx-auto">
            Załóż darmowe konto, zaimportuj transakcje i analizuj swoje inwestycje.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={() => navigate('/login?register=1')}
              className="bg-amber-500 hover:bg-amber-600 text-stone-950 font-semibold px-8 py-3 rounded-lg transition-colors inline-flex items-center gap-2"
            >
              Utwórz konto
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => navigate('/demo')}
              className="text-stone-400 hover:text-foreground text-sm font-medium transition-colors inline-flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5" />
              albo najpierw zobacz demo
            </button>
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="border-t border-stone-800/60 py-6">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between text-xs text-stone-600">
          <span>&copy; {new Date().getFullYear()} TIX Terminal</span>
          <span>Portfel inwestycyjny dla polskich inwestorów</span>
        </div>
      </footer>
    </div>
  );
}
