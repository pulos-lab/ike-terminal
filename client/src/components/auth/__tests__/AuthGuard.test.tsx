import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthGuard } from '../AuthGuard';

const authGuardLoadingDataTestId = 'client__auth__auth-guard-loading';
const landingPageDataTestId = 'client__auth__landing-page';
const verifyEmailPageDataTestId = 'client__auth__verify-email-page';
const protectedContentDataTestId = 'client__auth__protected-content';

const useSessionMock = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  useSession: () => useSessionMock(),
}));

function VerifyEmailRoute() {
  const { search } = useLocation();
  return <div data-test-id={verifyEmailPageDataTestId} data-search={search} />;
}

function renderWithRouter(initialPath = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<div data-test-id={landingPageDataTestId} />} />
        <Route path="/verify-email" element={<VerifyEmailRoute />} />
        <Route
          path="/protected"
          element={
            <AuthGuard>
              <div data-test-id={protectedContentDataTestId} />
            </AuthGuard>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthGuard', () => {
  beforeEach(() => {
    useSessionMock.mockReset();
  });

  it('renders loading state while session is pending', () => {
    useSessionMock.mockReturnValue({ data: null, isPending: true });

    renderWithRouter();

    expect(screen.getByTestId(authGuardLoadingDataTestId)).toBeInTheDocument();
    expect(screen.queryByTestId(protectedContentDataTestId)).not.toBeInTheDocument();
    expect(screen.queryByTestId(landingPageDataTestId)).not.toBeInTheDocument();
    expect(screen.queryByTestId(verifyEmailPageDataTestId)).not.toBeInTheDocument();
  });

  it('redirects to "/" when there is no session user', () => {
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    renderWithRouter();

    expect(screen.getByTestId(landingPageDataTestId)).toBeInTheDocument();
    expect(screen.queryByTestId(protectedContentDataTestId)).not.toBeInTheDocument();
  });

  it('redirects to "/" when session has no user object', () => {
    useSessionMock.mockReturnValue({ data: {}, isPending: false });

    renderWithRouter();

    expect(screen.getByTestId(landingPageDataTestId)).toBeInTheDocument();
    expect(screen.queryByTestId(protectedContentDataTestId)).not.toBeInTheDocument();
  });

  it('redirects to /verify-email when user email is not verified', () => {
    useSessionMock.mockReturnValue({
      data: {
        user: { email: 'user@example.com', emailVerified: false },
      },
      isPending: false,
    });

    renderWithRouter();

    const verifyPage = screen.getByTestId(verifyEmailPageDataTestId);
    expect(verifyPage).toBeInTheDocument();
    expect(verifyPage).toHaveAttribute('data-search', '?email=user%40example.com');
    expect(screen.queryByTestId(protectedContentDataTestId)).not.toBeInTheDocument();
  });

  it('encodes special characters in email when redirecting', () => {
    useSessionMock.mockReturnValue({
      data: {
        user: { email: 'a+b@example.com', emailVerified: false },
      },
      isPending: false,
    });

    renderWithRouter();

    expect(screen.getByTestId(verifyEmailPageDataTestId)).toHaveAttribute(
      'data-search',
      '?email=a%2Bb%40example.com',
    );
  });

  it('renders children when user is authenticated and verified', () => {
    useSessionMock.mockReturnValue({
      data: {
        user: { email: 'user@example.com', emailVerified: true },
      },
      isPending: false,
    });

    renderWithRouter();

    expect(screen.getByTestId(protectedContentDataTestId)).toBeInTheDocument();
    expect(screen.queryByTestId(authGuardLoadingDataTestId)).not.toBeInTheDocument();
    expect(screen.queryByTestId(landingPageDataTestId)).not.toBeInTheDocument();
    expect(screen.queryByTestId(verifyEmailPageDataTestId)).not.toBeInTheDocument();
  });
});
