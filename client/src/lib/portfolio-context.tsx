import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, setActivePortfolioId, getActivePortfolioId } from './api-client';
import { QUERY_KEYS } from './query-keys';
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

/**
 * Reset wszystkich zapytań scope'owanych do aktywnego portfela.
 * Pomijamy listę portfeli — jest per-user (nie per-portfel), a pełny reset
 * zerowałby ją na moment (data=undefined → flash "Moje IKE" w selektorze).
 */
function resetPortfolioScopedQueries(queryClient: QueryClient) {
  queryClient.resetQueries({
    predicate: (query) => query.queryKey[0] !== QUERY_KEYS.portfolios[0],
  });
}

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState(getActivePortfolioId);

  // Lista portfeli przez useQuery zamiast useState+useEffect — błąd pierwszego
  // fetcha dostaje retry (defaultOptions: retry 2) i jest widoczny w devtools,
  // a cache współdzieli wynik z refreshPortfolios (fetchQuery poniżej).
  const { data: portfoliosData } = useQuery({
    queryKey: QUERY_KEYS.portfolios,
    queryFn: api.getPortfolios,
  });
  const portfolios = useMemo(() => portfoliosData ?? [], [portfoliosData]);

  // Ghost activeId detection: jesli stan localStorage wskazuje na portfel
  // ktorego juz nie ma w API (bo zostal usuniety — albo on-device-only stale),
  // trzeba awaryjnie przestawic na pierwszy dostepny i zresetowac zapytania.
  // Bez tego kazde DELETE /portfolios/<ghost-id> wraca z 403 i user nie wie
  // dlaczego "Usun portfel" nie reaguje.
  useEffect(() => {
    if (!portfoliosData) return;
    const currentActive = getActivePortfolioId();
    if (portfoliosData.length > 0 && !portfoliosData.some((p) => p.id === currentActive)) {
      const fallbackId = portfoliosData[0].id;
      setActivePortfolioId(fallbackId);
      setActiveId(fallbackId);
      resetPortfolioScopedQueries(queryClient);
    }
  }, [portfoliosData, queryClient]);

  const refreshPortfolios = useCallback(async () => {
    // fetchQuery z staleTime: 0 wymusza świeży fetch i aktualizuje cache —
    // ghost detection w efekcie powyżej zareaguje na nowe dane.
    return queryClient.fetchQuery({
      queryKey: QUERY_KEYS.portfolios,
      queryFn: api.getPortfolios,
      staleTime: 0,
    });
  }, [queryClient]);

  const switchPortfolio = useCallback(
    (id: string) => {
      setActivePortfolioId(id);
      setActiveId(id);
      // resetQueries clears old portfolio data AND triggers refetch for all active queries
      resetPortfolioScopedQueries(queryClient);
    },
    [queryClient],
  );

  const createPortfolioFn = useCallback(
    async (name: string) => {
      const portfolio = await api.createPortfolio(name);
      await refreshPortfolios();
      switchPortfolio(portfolio.id);
      return portfolio;
    },
    [refreshPortfolios, switchPortfolio],
  );

  const deletePortfolioFn = useCallback(
    async (id: string) => {
      try {
        await api.deletePortfolio(id);
      } catch (err) {
        // Backend zwraca 403 (Access denied) gdy portfel nie istnieje w registry
        // (ownership check szuka portfolio i zwraca null -> isPortfolioOwnedBy=false).
        // Dla usera to znaczy "portfel juz usuniety" -> traktujemy jako success,
        // refreshujemy stan. Pozostale bledy propagujemy do UI.
        const alreadyGone = err instanceof ApiError && (err.status === 403 || err.status === 404);
        if (!alreadyGone) throw err;
      }
      const list = await refreshPortfolios();
      if (activeId === id) {
        // Switch na pierwszy dostepny z odswiezonej listy (ghost-detection
        // w efekcie moze juz to zrobic, ale jawny switch jest bezpieczniejszy).
        if (list.length > 0) switchPortfolio(list[0].id);
      }
    },
    [activeId, refreshPortfolios, switchPortfolio],
  );

  const purgeDataFn = useCallback(
    async (id: string) => {
      try {
        await api.purgePortfolioData(id);
        resetPortfolioScopedQueries(queryClient);
      } catch (err) {
        // 403/404 dla purgeData = portfel nie istnieje; odswiez state i zglos uzytkownikowi.
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          await refreshPortfolios();
          throw new Error('Portfel nie istnieje — odswiezono liste');
        }
        throw err;
      }
    },
    [queryClient, refreshPortfolios],
  );

  const updateSettingsFn = useCallback(
    async (settings: PortfolioSettings) => {
      await api.updatePortfolio(activeId, { settings });
      await refreshPortfolios();
    },
    [activeId, refreshPortfolios],
  );

  const updateNameFn = useCallback(
    async (name: string) => {
      await api.updatePortfolio(activeId, { name });
      await refreshPortfolios();
    },
    [activeId, refreshPortfolios],
  );

  const value = useMemo<PortfolioContextValue>(() => {
    const activePortfolio = portfolios.find((p) => p.id === activeId);
    return {
      portfolios,
      activeId,
      activeName: activePortfolio?.name || 'Moje IKE',
      activeSettings: activePortfolio?.settings || DEFAULT_PORTFOLIO_SETTINGS,
      switchPortfolio,
      createPortfolio: createPortfolioFn,
      deletePortfolio: deletePortfolioFn,
      purgeData: purgeDataFn,
      updateSettings: updateSettingsFn,
      updateName: updateNameFn,
      refreshPortfolios,
    };
  }, [
    portfolios,
    activeId,
    switchPortfolio,
    createPortfolioFn,
    deletePortfolioFn,
    purgeDataFn,
    updateSettingsFn,
    updateNameFn,
    refreshPortfolios,
  ]);

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolio() {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error('usePortfolio must be used within PortfolioProvider');
  return ctx;
}
