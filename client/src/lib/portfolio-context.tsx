import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setActivePortfolioId, getActivePortfolioId } from './api-client';
import type { Portfolio, PortfolioSettings } from 'shared';
import { DEFAULT_PORTFOLIO_SETTINGS } from 'shared';

interface PortfolioContextValue {
  portfolios: Portfolio[];
  activeId: string;
  activeName: string;
  activeSettings: PortfolioSettings;
  switchPortfolio: (id: string) => void;
  createPortfolio: (name: string) => Promise<Portfolio>;
  deletePortfolio: (id: string) => Promise<void>;
  updateSettings: (settings: PortfolioSettings) => Promise<void>;
  updateName: (name: string) => Promise<void>;
  refreshPortfolios: () => Promise<void>;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [activeId, setActiveId] = useState(getActivePortfolioId);

  const refreshPortfolios = useCallback(async () => {
    const list = await api.getPortfolios();
    setPortfolios(list);
  }, []);

  useEffect(() => {
    refreshPortfolios();
  }, [refreshPortfolios]);

  const switchPortfolio = useCallback((id: string) => {
    setActivePortfolioId(id);
    setActiveId(id);
    // resetQueries clears old portfolio data AND triggers refetch for all active queries
    queryClient.resetQueries();
  }, [queryClient]);

  const createPortfolioFn = useCallback(async (name: string) => {
    const portfolio = await api.createPortfolio(name);
    await refreshPortfolios();
    switchPortfolio(portfolio.id);
    return portfolio;
  }, [refreshPortfolios, switchPortfolio]);

  const deletePortfolioFn = useCallback(async (id: string) => {
    await api.deletePortfolio(id);
    await refreshPortfolios();
    if (activeId === id) {
      switchPortfolio('default');
    }
  }, [activeId, refreshPortfolios, switchPortfolio]);

  const updateSettingsFn = useCallback(async (settings: PortfolioSettings) => {
    await api.updatePortfolio(activeId, { settings });
    await refreshPortfolios();
  }, [activeId, refreshPortfolios]);

  const updateNameFn = useCallback(async (name: string) => {
    await api.updatePortfolio(activeId, { name });
    await refreshPortfolios();
  }, [activeId, refreshPortfolios]);

  const activePortfolio = portfolios.find(p => p.id === activeId);
  const activeName = activePortfolio?.name || 'Moje IKE';
  const activeSettings = activePortfolio?.settings || DEFAULT_PORTFOLIO_SETTINGS;

  return (
    <PortfolioContext.Provider value={{
      portfolios,
      activeId,
      activeName,
      activeSettings,
      switchPortfolio,
      createPortfolio: createPortfolioFn,
      deletePortfolio: deletePortfolioFn,
      updateSettings: updateSettingsFn,
      updateName: updateNameFn,
      refreshPortfolios,
    }}>
      {children}
    </PortfolioContext.Provider>
  );
}

export function usePortfolio() {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error('usePortfolio must be used within PortfolioProvider');
  return ctx;
}
