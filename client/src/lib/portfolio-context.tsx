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
  purgeData: (id: string) => Promise<void>;
  updateSettings: (settings: PortfolioSettings) => Promise<void>;
  updateName: (name: string) => Promise<void>;
  refreshPortfolios: () => Promise<Portfolio[]>;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [activeId, setActiveId] = useState(getActivePortfolioId);

  const refreshPortfolios = useCallback(async () => {
    const list = await api.getPortfolios();
    setPortfolios(list);
    // Ghost activeId detection: jesli stan localStorage wskazuje na portfel
    // ktorego juz nie ma w API (bo zostal usuniety — albo on-device-only stale),
    // trzeba awaryjnie przestawic na pierwszy dostepny i zresetowac zapytania.
    // Bez tego kazde DELETE /portfolios/<ghost-id> wraca z 403 i user nie wie
    // dlaczego "Usun portfel" nie reaguje.
    const currentActive = getActivePortfolioId();
    if (list.length > 0 && !list.some(p => p.id === currentActive)) {
      const fallbackId = list[0].id;
      setActivePortfolioId(fallbackId);
      setActiveId(fallbackId);
      queryClient.resetQueries();
    }
    return list;
  }, [queryClient]);

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
    try {
      await api.deletePortfolio(id);
    } catch (err: any) {
      // Backend zwraca 403 (Access denied) gdy portfel nie istnieje w registry
      // (ownership check szuka portfolio i zwraca null -> isPortfolioOwnedBy=false).
      // Dla usera to znaczy "portfel juz usuniety" -> traktujemy jako success,
      // refreshujemy stan. Pozostale bledy propagujemy do UI.
      const msg = String(err?.message || '');
      const alreadyGone = msg.includes('Access denied') || msg.includes('HTTP 403') ||
                          msg.includes('HTTP 404') || msg.includes('not found');
      if (!alreadyGone) throw err;
    }
    const list = await refreshPortfolios();
    if (activeId === id) {
      // Switch na pierwszy dostepny z odswiezonej listy (refreshPortfolios
      // moze juz to zrobil, ale jawny switch jest bezpieczniejszy).
      if (list.length > 0) switchPortfolio(list[0].id);
    }
  }, [activeId, refreshPortfolios, switchPortfolio]);

  const purgeDataFn = useCallback(async (id: string) => {
    try {
      await api.purgePortfolioData(id);
      queryClient.resetQueries();
    } catch (err: any) {
      const msg = String(err?.message || '');
      // 403/404 dla purgeData = portfel nie istnieje; odswiez state i zglos uzytkownikowi.
      if (msg.includes('Access denied') || msg.includes('HTTP 403') || msg.includes('HTTP 404')) {
        await refreshPortfolios();
        throw new Error('Portfel nie istnieje — odswiezono liste');
      }
      throw err;
    }
  }, [queryClient, refreshPortfolios]);

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
      purgeData: purgeDataFn,
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
