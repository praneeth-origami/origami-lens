/**
 * The one function every workspace-role-gated route calls, after the
 * existing organization-membership boundary already passed (resolving to a
 * real organizationId at all means the caller is a member — see
 * resolveOrganizationIds in index.ts). This never handles the "not a member
 * at all" case — that stays a 404, exactly as it is today, via the existing
 * boundary. This only ever fires once membership is established, which is
 * why an insufficient role here is a 403, not a 404: the caller already
 * knows the resource/workspace exists.
 */
import type { OrganizationRole } from '@origami/contracts';

export class WorkspaceAuthorizationError extends Error {
  constructor(message = 'You do not have permission to perform this action in this workspace.') {
    super(message);
    this.name = 'WorkspaceAuthorizationError';
  }
}

export interface WorkspaceRoleRepo {
  getMembershipRole(organizationId: string, userId: string): Promise<OrganizationRole | undefined>;
}

export async function getWorkspaceRoleOrThrow(
  repo: WorkspaceRoleRepo,
  userId: string,
  organizationId: string,
): Promise<OrganizationRole> {
  const role = await repo.getMembershipRole(organizationId, userId);
  if (!role) throw new WorkspaceAuthorizationError();
  return role;
}

export async function assertWorkspaceRole(
  repo: WorkspaceRoleRepo,
  userId: string,
  organizationId: string,
  permission: (role: OrganizationRole | undefined) => boolean,
): Promise<void> {
  const role = await repo.getMembershipRole(organizationId, userId);
  if (!permission(role)) {
    throw new WorkspaceAuthorizationError();
  }
}
