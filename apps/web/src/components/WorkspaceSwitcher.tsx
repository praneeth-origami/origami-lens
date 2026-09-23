import { useEffect, useState } from 'react';
import type { WorkspaceListItem } from '@origami/contracts';
import { fetchMyWorkspaces, switchWorkspace } from '../api/client';
import { useAuth } from '../hooks/useAuth';

/**
 * Only renders once a user actually belongs to more than one workspace
 * (e.g. after accepting a workspace invitation) — every user who has only
 * ever had their own personal workspace sees nothing here, matching how
 * this nav bar looked before Phase 20. A full page reload after switching
 * is deliberate: no page in this app re-fetches its data when the active
 * organization changes underneath it, so a reload is the simplest correct
 * way to make every view reflect the new workspace immediately.
 */
export function WorkspaceSwitcher() {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[] | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    fetchMyWorkspaces()
      .then((res) => setWorkspaces(res.workspaces))
      .catch(() => setWorkspaces([]));
  }, []);

  if (!workspaces || workspaces.length <= 1) return null;

  // Mirrors index.ts's resolveOrganizationIdForAuthenticatedRequest: the
  // user's explicit active workspace if set, else the first one — so the
  // dropdown always shows the workspace the rest of the app is actually
  // using right now, never an empty placeholder.
  const activeId = user?.activeOrganizationId && workspaces.some((w) => w.organizationId === user.activeOrganizationId)
    ? user.activeOrganizationId
    : workspaces[0].organizationId;

  const handleChange = async (organizationId: string) => {
    if (organizationId === activeId) return;
    setSwitching(true);
    try {
      await switchWorkspace({ organizationId });
      window.location.reload();
    } catch {
      setSwitching(false);
    }
  };

  return (
    <select
      className="workspace-switcher"
      aria-label="Switch workspace"
      disabled={switching}
      value={activeId}
      onChange={(e) => void handleChange(e.target.value)}
    >
      {workspaces.map((w) => (
        <option key={w.organizationId} value={w.organizationId}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
