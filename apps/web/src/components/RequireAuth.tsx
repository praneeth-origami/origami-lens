import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { PersonaOnboarding } from './PersonaOnboarding';

/**
 * Gates the dashboard/scans/components/repositories views behind a signed-in
 * session — the API rejects these routes with 401 UNAUTHENTICATED for
 * anyone without a valid session. Redirects to the real /login page
 * (Phase 16/H) rather than rendering an inline gate, carrying the current
 * location so LoginPage can send the user back where they were headed.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="auth-gate-loading">Loading…</div>;
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!user.persona) {
    return <PersonaOnboarding />;
  }

  return <>{children}</>;
}
