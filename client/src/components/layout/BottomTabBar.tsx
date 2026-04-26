import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Briefcase,
  ArrowLeftRight,
  Coins,
  DollarSign,
  Wallet,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { to: '/app', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/app/portfolio', label: 'Portfel', icon: Briefcase },
  { to: '/app/trades', label: 'Trades', icon: ArrowLeftRight },
  { to: '/app/dividends', label: 'Dywidendy', icon: Coins },
  { to: '/app/currency', label: 'Waluty', icon: DollarSign },
  { to: '/app/cash', label: 'Depozyty', icon: Wallet },
];

export function BottomTabBar() {
  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 grid grid-cols-6 bg-transparent border-t border-border"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 14px)' }}
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === '/app'}
          className={({ isActive }) =>
            cn(
              'relative flex flex-col items-center gap-1 pt-2.5 pb-2 text-muted-foreground transition-colors',
              isActive && 'text-foreground',
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span className="absolute top-0 left-[42%] right-[42%] h-[2px] rounded-full bg-primary" />
              )}
              <tab.icon className={cn('h-5 w-5', isActive && 'stroke-[2.25]')} aria-hidden />
              <span
                className={cn(
                  'text-[10px] leading-none tracking-tight',
                  isActive && 'text-primary font-semibold',
                )}
              >
                {tab.label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
