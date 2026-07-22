import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PortfolioProvider } from '@/lib/portfolio-context';
import { useTheme } from '@/lib/use-theme';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { LoginPage } from '@/components/auth/LoginPage';
import { VerifyOTPPage } from '@/components/auth/VerifyOTPPage';
import { ForgotPasswordPage } from '@/components/auth/ForgotPasswordPage';
import { LandingPage } from '@/components/landing/LandingPage';
import { SharePublicPage } from '@/components/share/SharePublicPage';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPage } from '@/components/dashboard/DashboardPage';
import { PortfolioPage } from '@/components/portfolio/PortfolioPage';
import { InstrumentPage } from '@/components/portfolio/InstrumentPage';
import { TradesPage } from '@/components/transactions/TradesPage';
import { DividendsPage } from '@/components/dividends/DividendsPage';
import { CurrencyExchangePage } from '@/components/currency/CurrencyExchangePage';
import { CashFlowPage } from '@/components/cash/CashFlowPage';
import { CorrectionsAndCostsPage } from '@/components/corrections-and-costs/CorrectionsAndCostsPage';
import { ImportHubPage } from '@/components/import/ImportHubPage';
import { BugReportsPage } from '@/components/admin/BugReportsPage';
import { ImportProfilesPage } from '@/components/admin/ImportProfilesPage';
import { TypeAliasesPage } from '@/components/admin/TypeAliasesPage';

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
  // Toaster podąża za centralnym motywem aplikacji — theme="system" ignorował
  // toggle w AppShell (sonner czyta wtedy tylko prefers-color-scheme).
  const { theme } = useTheme();
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster richColors position="bottom-center" closeButton theme={theme} />
          <BrowserRouter>
            <Routes>
              {/* Public routes */}
              <Route path="/" element={<LandingPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/verify-email" element={<VerifyOTPPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              {/* Publiczny widok udostępnionego portfela — bez AuthGuard */}
              <Route path="/share/:token" element={<SharePublicPage />} />

              {/* Protected routes */}
              <Route
                path="/app/*"
                element={
                  <AuthGuard>
                    <PortfolioProvider>
                      <AppShell>
                        <Routes>
                          <Route path="/" element={<DashboardPage />} />
                          <Route path="/portfolio" element={<PortfolioPage />} />
                          {/* Prototyp: dedykowana strona instrumentu (wariant C) */}
                          <Route path="/instrument/:isin" element={<InstrumentPage />} />
                          <Route path="/trades" element={<TradesPage />} />
                          <Route path="/dividends" element={<DividendsPage />} />
                          <Route path="/currency" element={<CurrencyExchangePage />} />
                          <Route path="/cash" element={<CashFlowPage />} />
                          <Route
                            path="/corrections-and-costs"
                            element={<CorrectionsAndCostsPage />}
                          />
                          {/* Stare ścieżki — redirect do nowego panelu dla backward compat (bookmarks) */}
                          <Route
                            path="/corporate-actions"
                            element={<Navigate to="/app/corrections-and-costs" replace />}
                          />
                          <Route
                            path="/costs"
                            element={<Navigate to="/app/corrections-and-costs" replace />}
                          />
                          <Route path="/import" element={<ImportHubPage />} />
                          {/* Stara ścieżka skrzynki — redirect na hub (bookmarki, stare CTA) */}
                          <Route
                            path="/import/inbox"
                            element={<Navigate to="/app/import" replace />}
                          />
                          <Route path="/admin/bugs" element={<BugReportsPage />} />
                          <Route path="/admin/import-profiles" element={<ImportProfilesPage />} />
                          <Route path="/admin/type-aliases" element={<TypeAliasesPage />} />
                          <Route path="*" element={<Navigate to="/app" replace />} />
                        </Routes>
                      </AppShell>
                    </PortfolioProvider>
                  </AuthGuard>
                }
              />

              {/* Catch-all */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
