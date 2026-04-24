import { useState } from 'react';
import {
  LayoutDashboard,
  Briefcase,
  ArrowLeftRight,
  Coins,
  Wallet,
  TrendingUp,
  DollarSign,
  Target,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  DEMO_CHART_DATA,
  DEMO_STATS,
  DEMO_POSITIONS,
  DEMO_CASH,
  DEMO_PORTFOLIO_TOTAL,
  DEMO_CLOSED_TRADES,
  DEMO_DIVIDEND_TOTAL,
  DEMO_DIVIDEND_YEARLY,
  DEMO_DIVIDENDS,
  DEMO_CASHFLOW_CHART,
  DEMO_CASHFLOW_SUMMARY,
  DEMO_CASHFLOW_ENTRIES,
} from './mock-data';

type DemoTab = 'dashboard' | 'portfolio' | 'trades' | 'dividends' | 'cashflow';

const NAV_ITEMS: { id: DemoTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'portfolio', label: 'Portfel', icon: Briefcase },
  { id: 'trades', label: 'Transakcje', icon: ArrowLeftRight },
  { id: 'dividends', label: 'Dywidendy', icon: Coins },
  { id: 'cashflow', label: 'Depozyty', icon: Wallet },
];

function formatPLN(v: number) {
  return v.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' PLN';
}

function formatPct(v: number) {
  const sign = v >= 0 ? '+' : '';
  return sign + v.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
}

// ── Dashboard View ─────────────────────────────────────────────────────────
function DashboardView() {
  const [range, setRange] = useState('1Y');
  const ranges = ['1M', '3M', '6M', 'YTD', '1Y'];

  const filteredData = (() => {
    const now = new Date('2026-04-01');
    let from: Date;
    switch (range) {
      case '1M': from = new Date(now); from.setMonth(from.getMonth() - 1); break;
      case '3M': from = new Date(now); from.setMonth(from.getMonth() - 3); break;
      case '6M': from = new Date(now); from.setMonth(from.getMonth() - 6); break;
      case 'YTD': from = new Date('2026-01-01'); break;
      default: from = new Date('2025-04-01');
    }
    const fromStr = from.toISOString().slice(0, 10);
    return DEMO_CHART_DATA.filter((d) => d.date >= fromStr);
  })();

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                range === r
                  ? 'bg-zinc-700 text-white'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Benchmark:</span>
          <span className="text-xs text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded">S&P 500</span>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-[#0d0d0d] rounded-lg border border-zinc-800/50 p-3">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={filteredData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
            <defs>
              <linearGradient id="gradPortfolio" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.15} />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
            <XAxis
              dataKey="date"
              tick={{ fill: '#52525b', fontSize: 10 }}
              tickFormatter={(v: string) => {
                const d = new Date(v);
                return d.toLocaleDateString('pl-PL', { month: 'short' });
              }}
              interval={Math.max(Math.floor(filteredData.length / 6), 1)}
              axisLine={{ stroke: '#27272a' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: '#52525b', fontSize: 10 }}
              tickFormatter={(v: number) => v + '%'}
              axisLine={{ stroke: '#27272a' }}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1a1a1a',
                border: '1px solid #27272a',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) => new Date(String(v)).toLocaleDateString('pl-PL')}
              formatter={(value, name) => [
                Number(value).toFixed(2) + '%',
                name === 'portfolio' ? 'Portfel' : 'S&P 500',
              ]}
            />
            <Area
              type="monotone"
              dataKey="portfolio"
              stroke="var(--primary)"
              strokeWidth={2}
              fill="url(#gradPortfolio)"
            />
            <Area
              type="monotone"
              dataKey="benchmark"
              stroke="#71717a"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              fill="none"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
        {DEMO_STATS.map((s) => (
          <div key={s.label} className="bg-[#0d0d0d] border border-zinc-800/50 rounded-lg p-2">
            <p className="text-[10px] text-zinc-500 truncate">{s.label}</p>
            <p
              className={`text-sm font-semibold ${
                s.positive === true
                  ? 'text-gain'
                  : s.positive === false
                    ? 'text-loss'
                    : 'text-white'
              }`}
            >
              {s.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Portfolio View ─────────────────────────────────────────────────────────
function PortfolioView() {
  const total = DEMO_PORTFOLIO_TOTAL;

  return (
    <div className="space-y-4">
      <div className="text-sm font-medium text-zinc-300">Otwarte pozycje</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
              <th className="text-left py-2 px-2 font-medium">Ticker</th>
              <th className="text-left py-2 px-2 font-medium hidden sm:table-cell">Nazwa</th>
              <th className="text-right py-2 px-2 font-medium">Ilość</th>
              <th className="text-right py-2 px-2 font-medium">Kurs</th>
              <th className="text-right py-2 px-2 font-medium">Wartość (PLN)</th>
              <th className="text-right py-2 px-2 font-medium hidden md:table-cell">P/L</th>
              <th className="text-right py-2 px-2 font-medium">P/L %</th>
              <th className="text-right py-2 px-2 font-medium hidden lg:table-cell">Udział</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_POSITIONS.map((p) => (
              <tr key={p.ticker} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                <td className="py-2 px-2">
                  <span className="font-mono font-bold text-white">{p.ticker}</span>
                  {p.category === 'ETF' && (
                    <span className="ml-1 text-[10px] border border-zinc-600 text-zinc-400 rounded px-1">
                      ETF
                    </span>
                  )}
                </td>
                <td className="py-2 px-2 text-zinc-500 hidden sm:table-cell">{p.name}</td>
                <td className="py-2 px-2 text-right text-zinc-300">{p.quantity}</td>
                <td className="py-2 px-2 text-right text-zinc-300">
                  {p.currentPrice.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
                  <span className="text-[10px] text-zinc-600 ml-0.5">{p.currency}</span>
                </td>
                <td className="py-2 px-2 text-right font-medium text-white">
                  {formatPLN(p.valuePLN)}
                </td>
                <td className={`py-2 px-2 text-right hidden md:table-cell ${p.pl >= 0 ? 'text-gain' : 'text-loss'}`}>
                  {p.pl >= 0 ? '+' : ''}{formatPLN(p.pl)}
                </td>
                <td className="py-2 px-2 text-right">
                  <span
                    className={`inline-block text-xs px-1.5 py-0.5 rounded ${
                      p.plPct >= 0 ? 'bg-gain/10 text-gain' : 'bg-loss/15 text-loss'
                    }`}
                  >
                    {formatPct(p.plPct)}
                  </span>
                </td>
                <td className="py-2 px-2 text-right text-zinc-500 hidden lg:table-cell">
                  {p.weight.toFixed(1)}%
                </td>
              </tr>
            ))}
            {/* Total row */}
            <tr className="border-t-2 border-zinc-700 font-bold">
              <td className="py-2 px-2 text-white">Razem</td>
              <td className="hidden sm:table-cell" />
              <td />
              <td />
              <td className="py-2 px-2 text-right text-white">{formatPLN(total.valuePLN)}</td>
              <td className={`py-2 px-2 text-right hidden md:table-cell ${total.pl >= 0 ? 'text-gain' : 'text-loss'}`}>
                +{formatPLN(total.pl)}
              </td>
              <td className="py-2 px-2 text-right">
                <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-gain/10 text-gain">
                  {formatPct(total.plPct)}
                </span>
              </td>
              <td className="hidden lg:table-cell" />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Cash */}
      <div className="mt-3">
        <div className="text-sm font-medium text-zinc-300 mb-2">Gotówka</div>
        <div className="grid grid-cols-2 gap-2">
          {DEMO_CASH.map((c) => (
            <div key={c.currency} className="bg-[#0d0d0d] border border-zinc-800/50 rounded-lg p-2.5">
              <p className="text-xs text-zinc-500">{c.currency}</p>
              <p className="text-sm font-semibold text-white">
                {c.balance.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Trades View (closed trades, FIFO grouped) ────────────────────────────
function TradesView() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['CDR|2026-03-10']));
  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-zinc-300">Zamknięte transakcje (FIFO)</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
              <th className="text-left py-2 px-2 font-medium w-6"></th>
              <th className="text-left py-2 px-2 font-medium">Ticker</th>
              <th className="text-right py-2 px-2 font-medium">Ilość</th>
              <th className="text-left py-2 px-2 font-medium hidden sm:table-cell">Kupno</th>
              <th className="text-left py-2 px-2 font-medium hidden sm:table-cell">Sprzedaż</th>
              <th className="text-right py-2 px-2 font-medium hidden md:table-cell">Cena K</th>
              <th className="text-right py-2 px-2 font-medium">Cena S</th>
              <th className="text-right py-2 px-2 font-medium">P/L %</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_CLOSED_TRADES.map((g) => {
              const key = `${g.ticker}|${g.sellDate}`;
              const isExpanded = expanded.has(key);
              const hasLots = g.trades.length > 1;
              return (
                <>
                  <tr
                    key={key}
                    className={`border-b border-zinc-800/50 ${hasLots ? 'cursor-pointer hover:bg-zinc-800/30' : 'hover:bg-zinc-800/20'}`}
                    onClick={() => hasLots && toggle(key)}
                  >
                    <td className="py-2 px-2 text-zinc-500">
                      {hasLots && (isExpanded
                        ? <ChevronDown className="w-3.5 h-3.5" />
                        : <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <span className="font-mono font-bold text-white">{g.ticker}</span>
                      {hasLots && (
                        <span className="ml-1 text-[10px] text-zinc-500">
                          {g.trades.length} loty
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right text-zinc-300">{g.totalQuantity}</td>
                    <td className="py-2 px-2 text-zinc-500 hidden sm:table-cell">
                      {hasLots
                        ? `${fmtDate(g.trades[0].buyDate)} – ${fmtDate(g.trades[g.trades.length - 1].buyDate)}`
                        : fmtDate(g.trades[0].buyDate)
                      }
                    </td>
                    <td className="py-2 px-2 text-zinc-500 hidden sm:table-cell">
                      {fmtDate(g.sellDate)}
                    </td>
                    <td className="py-2 px-2 text-right text-zinc-300 hidden md:table-cell">
                      {hasLots ? '—' : g.trades[0].buyPrice.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
                      {!hasLots && <span className="text-[10px] text-zinc-600 ml-0.5">{g.currency}</span>}
                    </td>
                    <td className="py-2 px-2 text-right text-zinc-300">
                      {g.sellPrice.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
                      <span className="text-[10px] text-zinc-600 ml-0.5">{g.currency}</span>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <span
                        className={`inline-block text-xs px-1.5 py-0.5 rounded ${
                          g.weightedProfitLossPct >= 0 ? 'bg-gain/10 text-gain' : 'bg-loss/15 text-loss'
                        }`}
                      >
                        {formatPct(g.weightedProfitLossPct)}
                      </span>
                    </td>
                  </tr>
                  {hasLots && isExpanded && g.trades.map((t, i) => (
                    <tr key={`${key}-${i}`} className="border-b border-zinc-800/30 bg-zinc-900/40">
                      <td className="py-1.5 px-2"></td>
                      <td className="py-1.5 px-2 text-zinc-500 text-xs pl-5">lot {i + 1}</td>
                      <td className="py-1.5 px-2 text-right text-zinc-400 text-xs">{t.quantity}</td>
                      <td className="py-1.5 px-2 text-zinc-500 text-xs hidden sm:table-cell">
                        {fmtDate(t.buyDate)}
                        <span className="text-zinc-600 ml-1">({t.holdingDays}d)</span>
                      </td>
                      <td className="py-1.5 px-2 text-zinc-500 text-xs hidden sm:table-cell">
                        {fmtDate(t.sellDate)}
                      </td>
                      <td className="py-1.5 px-2 text-right text-zinc-400 text-xs hidden md:table-cell">
                        {t.buyPrice.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
                        <span className="text-[10px] text-zinc-600 ml-0.5">{t.currency}</span>
                      </td>
                      <td className="py-1.5 px-2 text-right text-zinc-400 text-xs">
                        {t.sellPrice.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-1.5 px-2 text-right">
                        <span
                          className={`inline-block text-[11px] px-1 py-0.5 rounded ${
                            t.profitLossPct >= 0 ? 'bg-gain/10 text-gain' : 'bg-loss/15 text-loss'
                          }`}
                        >
                          {formatPct(t.profitLossPct)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ── Dividends View ─────────────────────────────────────────────────────────
function DividendsView() {
  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-[#0d0d0d] border border-zinc-800/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Coins className="w-4 h-4 text-zinc-500" />
            <p className="text-xs text-zinc-500">Suma dywidend</p>
          </div>
          <p className="text-xl font-bold text-gain">{formatPLN(DEMO_DIVIDEND_TOTAL)}</p>
        </div>

        <div className="bg-[#0d0d0d] border border-zinc-800/50 rounded-lg p-3">
          <p className="text-xs text-zinc-500 mb-2">Dywidendy rocznie</p>
          <ResponsiveContainer width="100%" height={80}>
            <BarChart data={DEMO_DIVIDEND_YEARLY} margin={{ top: 0, right: 0, left: -25, bottom: 0 }}>
              <XAxis
                dataKey="year"
                tick={{ fill: '#52525b', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #27272a',
                  borderRadius: 8,
                  fontSize: 11,
                }}
                formatter={(value) => [formatPLN(Number(value)), 'Dywidendy']}
              />
              <Bar dataKey="amount" fill="var(--primary)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Dividend history table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
              <th className="text-left py-2 px-2 font-medium">Data</th>
              <th className="text-left py-2 px-2 font-medium">Ticker</th>
              <th className="text-left py-2 px-2 font-medium hidden sm:table-cell">Opis</th>
              <th className="text-right py-2 px-2 font-medium">Kwota</th>
              <th className="text-right py-2 px-2 font-medium">Waluta</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_DIVIDENDS.map((d, i) => (
              <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                <td className="py-2 px-2 text-zinc-400">
                  {new Date(d.date).toLocaleDateString('pl-PL')}
                </td>
                <td className="py-2 px-2 font-mono font-bold text-white">{d.ticker}</td>
                <td className="py-2 px-2 text-zinc-500 text-xs hidden sm:table-cell">
                  Wypłata dywidendy {d.ticker}
                </td>
                <td className="py-2 px-2 text-right font-semibold text-gain">
                  +{d.amount.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
                </td>
                <td className="py-2 px-2 text-right text-zinc-400">{d.currency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Cash Flow View ─────────────────────────────────────────────────────────
function CashFlowView() {
  const summary = DEMO_CASHFLOW_SUMMARY;

  return (
    <div className="space-y-4">
      {/* Summary header */}
      <div className="flex items-center gap-4 flex-wrap text-xs text-zinc-400">
        <span>
          Wpłaty: <span className="text-gain font-medium">{formatPLN(summary.totalDeposits)}</span>
        </span>
        <span>
          Wypłaty: <span className="text-loss font-medium">{formatPLN(summary.totalWithdrawals)}</span>
        </span>
        <span>
          Netto: <span className="text-white font-medium">{formatPLN(summary.net)}</span>
        </span>
      </div>

      {/* Chart: Net Cash Flow vs Portfolio Value */}
      <div className="bg-[#0d0d0d] rounded-lg border border-zinc-800/50 p-3">
        <div className="flex items-center gap-4 mb-2 text-[10px] text-zinc-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-primary inline-block rounded" /> Wartość portfela
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-zinc-500 inline-block rounded border-dashed" /> Wpłaty netto
          </span>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={DEMO_CASHFLOW_CHART} margin={{ top: 5, right: 5, left: -5, bottom: 0 }}>
            <defs>
              <linearGradient id="gradCashPortfolio" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.12} />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
            <XAxis
              dataKey="date"
              tick={{ fill: '#52525b', fontSize: 10 }}
              tickFormatter={(v: string) => {
                const d = new Date(v);
                return d.toLocaleDateString('pl-PL', { month: 'short', year: '2-digit' });
              }}
              interval={2}
              axisLine={{ stroke: '#27272a' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: '#52525b', fontSize: 10 }}
              tickFormatter={(v: number) => (v / 1000).toFixed(0) + 'k'}
              axisLine={{ stroke: '#27272a' }}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1a1a1a',
                border: '1px solid #27272a',
                borderRadius: 8,
                fontSize: 11,
              }}
              labelFormatter={(v) => new Date(String(v)).toLocaleDateString('pl-PL')}
              formatter={(value, name) => [
                formatPLN(Number(value)),
                name === 'portfolioValue' ? 'Wartość portfela' : 'Wpłaty netto',
              ]}
            />
            <Area
              type="monotone"
              dataKey="portfolioValue"
              stroke="var(--primary)"
              strokeWidth={2}
              fill="url(#gradCashPortfolio)"
            />
            <Area
              type="stepAfter"
              dataKey="netCashFlow"
              stroke="#71717a"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              fill="none"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Cash flow entries table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
              <th className="text-left py-2 px-2 font-medium">Data</th>
              <th className="text-left py-2 px-2 font-medium">Typ</th>
              <th className="text-right py-2 px-2 font-medium">Kwota</th>
              <th className="text-right py-2 px-2 font-medium">Waluta</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_CASHFLOW_ENTRIES.map((entry, i) => {
              const isDeposit = entry.type === 'deposit';
              return (
                <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                  <td className="py-2 px-2 text-zinc-400">
                    {new Date(entry.date).toLocaleDateString('pl-PL')}
                  </td>
                  <td className="py-2 px-2">
                    <span className="flex items-center gap-1.5">
                      {isDeposit ? (
                        <ArrowUp className="w-3 h-3 text-gain" />
                      ) : (
                        <ArrowDown className="w-3 h-3 text-loss" />
                      )}
                      <span className={isDeposit ? 'text-gain' : 'text-loss'}>
                        {isDeposit ? 'Wpłata' : 'Wypłata'}
                      </span>
                    </span>
                  </td>
                  <td className={`py-2 px-2 text-right font-semibold ${isDeposit ? 'text-gain' : 'text-loss'}`}>
                    {isDeposit ? '+' : '-'}{entry.amount.toLocaleString('pl-PL', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="py-2 px-2 text-right text-zinc-400">PLN</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Demo Component ────────────────────────────────────────────────────
export function AppDemo() {
  const [activeTab, setActiveTab] = useState<DemoTab>('dashboard');
  const total = DEMO_PORTFOLIO_TOTAL;

  const views: Record<DemoTab, React.ReactNode> = {
    dashboard: <DashboardView />,
    portfolio: <PortfolioView />,
    trades: <TradesView />,
    dividends: <DividendsView />,
    cashflow: <CashFlowView />,
  };

  return (
    <div className="rounded-xl border border-stone-800 bg-[#141210] overflow-hidden shadow-2xl shadow-amber-900/5">
      {/* Browser chrome */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-[#0a0a0a] border-b border-zinc-800">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-primary/80" />
        </div>
        <div className="flex-1 flex justify-center">
          <div className="bg-zinc-800 rounded-md px-4 py-1 text-xs text-zinc-500 max-w-xs w-full text-center">
            tixterminal.app
          </div>
        </div>
        <div className="w-12" />
      </div>

      {/* App frame */}
      <div className="flex min-h-[480px] max-h-[540px]">
        {/* Sidebar */}
        <div className="w-48 border-r border-zinc-800 bg-[#0d0d0d] flex-shrink-0 hidden md:flex flex-col">
          <div className="px-3 py-3 border-b border-zinc-800">
            <h3 className="text-sm font-bold text-white">TIX Terminal</h3>
            <p className="text-[10px] text-zinc-600">Portfel inwestycyjny</p>
          </div>
          <div className="px-2 py-1.5 border-b border-zinc-800">
            <div className="bg-zinc-800 rounded-md px-2 py-1 text-xs text-zinc-400">
              📁 IKE — Bossa
            </div>
          </div>
          <nav className="px-2 py-2 space-y-0.5 flex-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                    isActive
                      ? 'bg-amber-500 text-stone-950 font-semibold'
                      : 'text-stone-400 hover:bg-stone-800 hover:text-stone-200'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {item.label}
                </button>
              );
            })}
          </nav>
          <div className="px-3 py-2 border-t border-zinc-800">
            <p className="text-[10px] text-zinc-600 truncate">jan.kowalski@email.com</p>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Mobile tabs (shown on small screens) */}
          <div className="flex md:hidden border-b border-zinc-800 bg-[#0d0d0d]">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] transition-colors ${
                    isActive
                      ? 'text-amber-500 border-b-2 border-amber-500'
                      : 'text-stone-500'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>

          {/* Metrics bar */}
          <div className="flex items-center gap-4 px-4 py-2 border-b border-zinc-800 bg-[#0d0d0d] text-xs flex-wrap">
            <span className="flex items-center gap-1 text-zinc-400">
              <DollarSign className="w-3 h-3" />
              Wartość: <span className="text-white font-medium">{formatPLN(total.valuePLN)}</span>
            </span>
            <span className="flex items-center gap-1 text-zinc-400">
              <Target className="w-3 h-3" />
              Wpłaty: <span className="text-white font-medium">{formatPLN(total.invested)}</span>
            </span>
            <span className="flex items-center gap-1 text-zinc-400">
              <TrendingUp className="w-3 h-3 text-gain" />
              Zysk: <span className="text-gain font-medium">+{formatPLN(total.pl)}</span>
            </span>
            <span className="text-zinc-400">
              XIRR: <span className="text-gain font-medium">+28,1%</span>
            </span>
          </div>

          {/* Page content */}
          <div className="flex-1 overflow-auto p-4">
            {views[activeTab]}
          </div>
        </div>
      </div>
    </div>
  );
}
