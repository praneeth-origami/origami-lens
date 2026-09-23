import { useCallback, useEffect, useState } from 'react';
import type { AuthUser } from '@origami/contracts';
import { fetchCurrentUser, logout as logoutRequest } from '../api/client';

export interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * Phase 16/A — reads the current signed-in Origami Lens user, if any, via
 * the session cookie (never localStorage — see the Phase 16 design
 * report's threat model on why the session lives only in an httpOnly
 * cookie). Signing in itself is a full-page navigation to
 * githubLoginUrl(), not something this hook drives.
 */
export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { user: current } = await fetchCurrentUser();
    setUser(current);
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const logout = useCallback(async () => {
    await logoutRequest();
    setUser(null);
  }, []);

  return { user, loading, refresh, logout };
}
