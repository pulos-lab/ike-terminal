import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PortfolioProvider } from '@/lib/portfolio-context';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { LoginPage } from '@/components/auth/LoginPage';
import { VerifyOTPPage } from '@/components/auth/VerifyOTPPage';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPage } from '@/components/dashboard/DashboardPage';
import { PortfolioPage } from '@/components/portfolio/PortfolioPage';
import { TradesPage } from '@/components/transactions/TradesPage';
import { DividendsPage } from '@/components/dividends/DividendsPage';
import { CurrencyExchangePage } from '@/components/currency/CurrencyExchangePage';
import { CashFlowPage } from '@/components/cash/CashFlowPage';
import { BugReportsPage } from '@/components/admin/BugReportsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15 * 60 * 1000,
      refetchInterval: 15 * 60 * 1000,
      retry: 2,
    },
  },
});

function App() {
  return (
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/verify-email" element={<VerifyOTPPage />} />

            {/* Protected routes */}
            <Route path="/*" element={
              <AuthGuard>
                <PortfolioProvider>
                  <AppShell>
                    <Routes>
                      <Route path="/" element={<DashboardPage />} />
                      <Route path="/portfolio" element={<PortfolioPage />} />
                      <Route path="/trades" element={<TradesPage />} />
                      <Route path="/dividends" element={<DividendsPage />} />
                      <Route path="/currency" element={<CurrencyExchangePage />} />
                      <Route path="/cash" element={<CashFlowPage />} />
                      <Route path="/admin/bugs" element={<BugReportsPage />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </AppShell>
                </PortfolioProvider>
              </AuthGuard>
            } />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
