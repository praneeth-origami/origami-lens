import { Routes, Route, Navigate, useLocation, type Location } from 'react-router-dom';
import { TopNav } from './components/TopNav';
import { ServiceHealthBanner } from './components/ServiceHealthBanner';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { DashboardPage } from './pages/DashboardPage';
import { IssueDetailPage } from './pages/IssueDetailPage';
import { PageScanDetailPage } from './pages/PageScanDetailPage';
import { ComponentDetailPage } from './pages/ComponentDetailPage';
import { ScansListPage } from './pages/ScansListPage';
import { ComponentsListPage } from './pages/ComponentsListPage';
import { RepositoriesListPage } from './pages/RepositoriesListPage';
import { RepositoryDetailPage } from './pages/RepositoryDetailPage';
import { RepositoryIssueDetailPage } from './pages/RepositoryIssueDetailPage';
import { PricingPage } from './pages/PricingPage';
import { BillingSuccessPage } from './pages/BillingSuccessPage';
import { BillingCancelPage } from './pages/BillingCancelPage';
import { BillingSettingsPage } from './pages/BillingSettingsPage';
import { WorkspaceMembersPage } from './pages/WorkspaceMembersPage';
import { AdminPage } from './pages/AdminPage';
import { RequirePlatformAdmin } from './components/RequirePlatformAdmin';
import { InvitationPage } from './pages/InvitationPage';
import { SharedReportPage } from './pages/SharedReportPage';
import { LensEventProvider } from './notifications/LensEventProvider';
import { ConfirmDialogProvider } from './notifications/ConfirmDialogProvider';

const AUTH_ROUTES = new Set(['/login', '/register', '/forgot-password', '/reset-password', '/verify-email']);
// Phase 17 — public, reachable whether signed in or not (unlike AUTH_ROUTES,
// an already-signed-in visitor is NOT redirected away from these).
const PUBLIC_ROUTES = new Set(['/pricing']);

/**
 * The auth pages (Phase 16/H) are full-bleed and render their own complete
 * shell (AuthLayout) — no TopNav/ServiceHealthBanner, no .page-container,
 * and deliberately reachable whether or not a session exists (RequireAuth
 * only guards the routes below, not these). Everything else keeps the
 * original app chrome + RequireAuth gate unchanged.
 */
function AppShell() {
  const location = useLocation();
  const { user, loading } = useAuth();

  // Phase 20 — reachable whether or not the visitor is signed in (like
  // PUBLIC_ROUTES below), but path-parameterized so it can't live in that
  // fixed Set. The page manages every auth state itself via useAuth().
  if (location.pathname.startsWith('/invitations/')) {
    return (
      <Routes>
        <Route path="/invitations/:token" element={<InvitationPage />} />
      </Routes>
    );
  }

  // Same shape as /invitations/ above — a public, read-only report page
  // reachable whether or not the visitor is signed in. The token itself is
  // the authorization (see report-share-service.ts); this never touches
  // RequireAuth or the login-redirect logic below.
  if (location.pathname.startsWith('/reports/share/')) {
    return (
      <Routes>
        <Route path="/reports/share/:token" element={<SharedReportPage />} />
      </Routes>
    );
  }

  if (AUTH_ROUTES.has(location.pathname)) {
    // An already-signed-in visitor has no reason to see a sign-in/register
    // page — send them to the dashboard instead. /reset-password is exempt:
    // a signed-in user (or one signed in from a different tab) should still
    // be able to follow a real reset link and change their password.
    //
    // Honors the same location.state.from LoginPage.tsx/RegisterPage.tsx
    // read (set by InvitationPage.tsx's sign-in/sign-up CTAs) rather than
    // always '/': `user` can flip true (via AuthProvider's setUser) in a
    // render that fires before LoginPage/RegisterPage's own explicit
    // navigate(from...) call commits, so THIS redirect can win that race.
    // Sending it to the same destination makes the race harmless instead of
    // silently dropping the user back on the dashboard after registering
    // through an invitation link. /verify-email is exempt for the same
    // reason as /reset-password: a signed-in user (e.g. right after
    // registering) should still be able to follow a real verification link.
    if (!loading && user && location.pathname !== '/reset-password' && location.pathname !== '/verify-email') {
      const from = (location.state as { from?: Location } | null)?.from;
      return <Navigate to={from ? `${from.pathname}${from.search}` : '/'} replace />;
    }
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
      </Routes>
    );
  }

  // Only the bare, no-chrome version for a visitor who isn't (yet) signed
  // in — once authenticated, /pricing is just another page inside the
  // normal app shell below, same as every other nav item, so the header
  // never disappears when someone clicks "Pricing" from inside the app.
  if (PUBLIC_ROUTES.has(location.pathname) && !user) {
    return (
      <Routes>
        <Route path="/pricing" element={<PricingPage />} />
      </Routes>
    );
  }

  return (
    <div className="app-shell">
      <TopNav />
      <ServiceHealthBanner />
      <main className="page-container">
        <RequireAuth>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/scans" element={<ScansListPage />} />
            <Route path="/scans/:scanId" element={<DashboardPage />} />
            <Route path="/scans/:scanId/pages/:pageScanId" element={<PageScanDetailPage />} />
            <Route path="/issues/:issueId" element={<IssueDetailPage />} />
            <Route path="/components" element={<ComponentsListPage />} />
            <Route path="/components/:jobId" element={<ComponentDetailPage />} />
            <Route path="/repositories" element={<RepositoriesListPage />} />
            <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
            <Route path="/repositories/:id/issues/:issueId" element={<RepositoryIssueDetailPage />} />
            <Route path="/billing/success" element={<BillingSuccessPage />} />
            <Route path="/billing/cancel" element={<BillingCancelPage />} />
            <Route path="/billing/settings" element={<BillingSettingsPage />} />
            <Route path="/workspace/members" element={<WorkspaceMembersPage />} />
            <Route
              path="/admin"
              element={
                <RequirePlatformAdmin>
                  <AdminPage />
                </RequirePlatformAdmin>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </RequireAuth>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      {/* Mounted here, above AppShell's four mutually-exclusive route branches
          (invitation page / auth pages / public pages / normal app shell) —
          this is the only point common to all of them, so notify.*()/confirm()
          work identically on every route. */}
      <LensEventProvider>
        <ConfirmDialogProvider>
          <AppShell />
        </ConfirmDialogProvider>
      </LensEventProvider>
    </AuthProvider>
  );
}
