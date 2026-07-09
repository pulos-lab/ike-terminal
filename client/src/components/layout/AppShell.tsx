import { useState } from 'react';
import { NavLink, useNavigate, useMatch } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { useSession, signOut } from '@/lib/auth-client';
import {
  LayoutDashboard,
  Briefcase,
  ArrowLeftRight,
  Coins,
  DollarSign,
  Wallet,
  Upload,
  Moon,
  Sun,
  LogOut,
  MoreHorizontal,
  KeyRound,
  Bug,
  ChevronUp,
  PanelLeftClose,
  Landmark,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useLocalStorage } from '@/lib/use-local-storage';
import { formatTimestampLocal } from '@/lib/formatters';
import { useTheme } from '@/lib/use-theme';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MetricsBar } from '@/components/dashboard/MetricsBar';
import { ImportDialog } from '@/components/import/ImportDialog';
import { BugReportDialog } from '@/components/shared/BugReportDialog';
import { ChangePasswordDialog } from '@/components/auth/ChangePasswordDialog';
import { PortfolioSelector } from './PortfolioSelector';
import { BottomTabBar } from './BottomTabBar';
import { Logo } from '@/components/ui/Logo';

const baseNavItems = [
  { to: '/app', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/app/portfolio', label: 'Portfel', icon: Briefcase },
  { to: '/app/trades', label: 'Transakcje', icon: ArrowLeftRight },
  { to: '/app/dividends', label: 'Dywidendy', icon: Coins },
  { to: '/app/currency', label: 'Waluty', icon: DollarSign },
  { to: '/app/cash', label: 'Depozyty', icon: Wallet },
  { to: '/app/corrections-and-costs', label: 'Korekty i koszty', icon: Landmark },
];

function NavItem({
  to,
  label,
  Icon,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const match = useMatch({ path: to, end: to === '/app' });
  const isActive = !!match;
  const classes = cn(
    'relative flex items-center rounded-lg transition-colors',
    collapsed ? 'justify-center w-10 h-10' : 'gap-3 px-3 py-2 text-sm',
    isActive
      ? 'bg-primary/10 text-primary font-medium'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  );

  const link = (
    <NavLink to={to} end={to === '/app'} onClick={onNavigate} className={classes}>
      {isActive && !collapsed && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r-full bg-primary" />
      )}
      <Icon className="h-4 w-4" />
      {!collapsed && label}
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function NavContent({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  // Korekty i koszty ma stały wpis w baseNavItems (panel łączy zdarzenia korporacyjne
  // + dodatkowe koszty; wcześniejsze osobne "Inne koszty" i "Zdarzenia korp." zostały
  // zunifikowane). Link zawsze widoczny — panel pokazuje empty state gdy brak danych.
  const navItems = baseNavItems;

  return (
    <TooltipProvider delayDuration={0}>
      <nav className={cn('flex flex-col gap-1', collapsed ? 'p-2 items-center' : 'p-3')}>
        {!collapsed && (
          <>
            <div className="px-3 py-1 mb-2">
              <p className="text-xs text-muted-foreground">Portfel inwestycyjny</p>
            </div>
            <div className="px-1 mb-2">
              <PortfolioSelector />
            </div>
            <Separator className="mb-2" />
          </>
        )}
        {navItems.map((item) => (
          <NavItem
            key={item.to}
            to={item.to}
            label={item.label}
            Icon={item.icon}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </TooltipProvider>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { isDark: dark, toggleTheme } = useTheme();
  const [importOpen, setImportOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [collapsed, setCollapsed] = useLocalStorage('sidebar-collapsed', false);

  const handleLogout = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  const { data: importStatus } = useQuery({
    queryKey: QUERY_KEYS.importStatus,
    queryFn: api.getImportStatus,
  });

  const lastImport = importStatus?.lastImportDate
    ? formatTimestampLocal(importStatus.lastImportDate)
    : null;

  // Importy uniwersalne czekające na ponowne wgranie po korekcie mapowania przez
  // admina. Wspólny klucz z GenericBatchesSection → jedno zapytanie; kropka
  // aktualizuje się po re-imporcie (invalidateQueries unieważnia ten klucz).
  const { data: genericBatches } = useQuery({
    queryKey: ['generic-batches'],
    queryFn: api.genericBatches,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const reimportCount = genericBatches?.batches.filter((b) => b.needsReimport).length ?? 0;

  return (
    <div className="flex h-screen overflow-hidden">
      <aside
        className={cn(
          'hidden md:flex flex-col border-r bg-card transition-[width] duration-200 ease-in-out',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        <div className="flex items-center justify-between gap-1 p-2 border-b border-border">
          {collapsed ? (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setCollapsed(false)}
                    aria-label="Rozwiń sidebar"
                    className="w-full flex items-center justify-center py-1 rounded-md hover:bg-accent transition-colors cursor-pointer"
                  >
                    <Logo size="md" showWord={false} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  Rozwiń sidebar
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <>
              <Logo size="md" className="ml-2" />
              <button
                onClick={() => setCollapsed(true)}
                title="Zwiń sidebar"
                aria-label="Zwiń sidebar"
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
        <NavContent collapsed={collapsed} />
        {!collapsed && (
          <div className="mt-auto p-3 space-y-2">
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={toggleTheme}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-card border border-border hover:border-border-hover hover:bg-accent text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                {dark ? 'Light' : 'Dark'}
              </button>
              <button
                onClick={() => navigate('/app/import')}
                title={
                  reimportCount > 0
                    ? `${reimportCount} import(y) czeka na ponowne wgranie pliku po korekcie mapowania`
                    : undefined
                }
                className="relative flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-card border border-border hover:border-border-hover hover:bg-accent text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <Upload className="h-3.5 w-3.5" />
                Import
                {reimportCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-[10px] font-semibold text-info-foreground">
                    {reimportCount}
                  </span>
                )}
              </button>
            </div>
            {lastImport && (
              <p className="text-[10px] text-muted-foreground px-1">Ostatni import: {lastImport}</p>
            )}
            {session?.user && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="w-full flex items-center justify-between pt-2 border-t border-border text-xs text-muted-foreground hover:text-foreground transition-colors group">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[9px] font-semibold text-foreground flex-shrink-0">
                        {session.user.email?.[0]?.toUpperCase() ?? '?'}
                      </span>
                      <span className="truncate">{session.user.email}</span>
                    </span>
                    <ChevronUp className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="w-52">
                  <DropdownMenuLabel className="text-xs text-muted-foreground font-normal truncate">
                    {session.user.email}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setChangePasswordOpen(true)}>
                    <KeyRound className="h-4 w-4" />
                    Zmień hasło
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setBugReportOpen(true)}>
                    <Bug className="h-4 w-4" />
                    Zgłoś błąd
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleLogout} variant="destructive">
                    <LogOut className="h-4 w-4" />
                    Wyloguj
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </aside>

      <div className="flex flex-col flex-1 overflow-hidden">
        <header className="flex md:hidden items-center justify-between border-b px-3 py-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Logo size="md" showWord={false} />
            <div className="min-w-0 flex-1">
              <PortfolioSelector />
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Menu">
                <MoreHorizontal className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => navigate('/app/import')}>
                <Upload className="h-4 w-4" />
                Import transakcji
                {reimportCount > 0 && (
                  <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-info px-1.5 text-[10px] font-semibold text-info-foreground">
                    {reimportCount}
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={toggleTheme}>
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {dark ? 'Tryb jasny' : 'Tryb ciemny'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setChangePasswordOpen(true)}>
                <KeyRound className="h-4 w-4" />
                Zmień hasło
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setBugReportOpen(true)}>
                <Bug className="h-4 w-4" />
                Zgłoś błąd
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {session?.user && (
                <DropdownMenuLabel className="text-xs text-muted-foreground font-normal truncate">
                  {session.user.email}
                </DropdownMenuLabel>
              )}
              <DropdownMenuItem onSelect={handleLogout} variant="destructive">
                <LogOut className="h-4 w-4" />
                Wyloguj
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <MetricsBar />

        <main className="flex-1 overflow-auto p-4 md:p-6 pb-20 md:pb-6">{children}</main>
      </div>

      <BottomTabBar />

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <ChangePasswordDialog
        open={changePasswordOpen}
        onOpenChange={setChangePasswordOpen}
        hideTrigger
      />
      <BugReportDialog open={bugReportOpen} onOpenChange={setBugReportOpen} hideTrigger />
    </div>
  );
}
