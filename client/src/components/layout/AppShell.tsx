import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import {
  LayoutDashboard, Briefcase, ArrowLeftRight, Coins,
  DollarSign, Wallet, Upload, Moon, Sun, Menu,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { MetricsBar } from '@/components/dashboard/MetricsBar';
import { ImportDialog } from '@/components/import/ImportDialog';
import { PortfolioSelector } from './PortfolioSelector';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/portfolio', label: 'Portfel', icon: Briefcase },
  { to: '/trades', label: 'Transakcje', icon: ArrowLeftRight },
  { to: '/dividends', label: 'Dywidendy', icon: Coins },
  { to: '/currency', label: 'Waluty', icon: DollarSign },
  { to: '/cash', label: 'Gotówka', icon: Wallet },
];

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1 p-3">
      <div className="px-3 py-2 mb-2">
        <h2 className="text-lg font-bold tracking-tight">TIX Terminal</h2>
        <p className="text-xs text-muted-foreground">Portfel inwestycyjny</p>
      </div>
      <div className="px-1 mb-2">
        <PortfolioSelector />
      </div>
      <Separator className="mb-2" />
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            }`
          }
        >
          <item.icon className="h-4 w-4" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [importOpen, setImportOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: importStatus } = useQuery({
    queryKey: ['import', 'status'],
    queryFn: api.getImportStatus,
  });

  const lastImport = importStatus?.lastImportDate
    ? new Date(importStatus.lastImportDate + 'Z').toLocaleDateString('pl-PL')
    : null;

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden md:flex w-60 flex-col border-r bg-card">
        <NavContent />
        <div className="mt-auto p-3 space-y-1">
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={toggleTheme}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4 mr-1" />
              Import
            </Button>
          </div>
          {lastImport && (
            <p className="text-[10px] text-muted-foreground px-1">
              Ostatni import: {lastImport}
            </p>
          )}
        </div>
      </aside>

      <div className="flex flex-col flex-1 overflow-hidden">
        <header className="flex md:hidden items-center justify-between border-b px-4 py-2">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-60 p-0">
              <NavContent onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>
          <h1 className="font-bold">TIX Terminal</h1>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={toggleTheme}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <MetricsBar />

        <main className="flex-1 overflow-auto p-4 md:p-6">
          {children}
        </main>
      </div>

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
