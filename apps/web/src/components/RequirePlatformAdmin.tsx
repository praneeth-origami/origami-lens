import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

/**
 * Gates /admin behind platformRole !== 'USER'. Nested inside RequireAuth
 * (App.tsx), so `user` is always set by the time this renders. Redirects a
 * plain USER to the dashboard rather than rendering a dead-end page — the
 * API's own /admin/* routes reject the same caller with 403 regardless, so
 * this is purely a better-UX redirect, never the real gate.
 */
export function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="auth-gate-loading">Loading…</div>;
  }

  if (!user || user.platformRole === 'USER') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
