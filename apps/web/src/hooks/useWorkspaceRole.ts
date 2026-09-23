import { useCallback, useEffect, useState } from 'react';
import type { OrganizationRole } from '@origami/contracts';
import { fetchWorkspaceRole } from '../api/client';

export interface WorkspaceRoleState {
  role: OrganizationRole | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * The one lightweight lookup pages use to hide/disable actions a user can't
 * perform (see workspace-permissions.ts on the backend for the real
 * decisions this mirrors) — the API remains authoritative regardless of
 * what this hook returns; every mutating route re-checks the role itself
 * server-side. Same page-local-hook shape as useBillingStatus.ts, not a
 * Context provider — only a handful of pages need this.
 */
export function useWorkspaceRole(): WorkspaceRoleState {
  const [role, setRole] = useState<OrganizationRole | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchWorkspaceRole()
      .then((result) => setRole(result.role))
      .catch(() => setRole(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return { role, loading, refresh: load };
}
