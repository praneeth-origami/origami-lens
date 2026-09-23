/**
 * Workspace membership management — the service layer between the
 * /workspace/members routes and OrganizationRepository/UserRepository.
 * Kept out of OrganizationRepository itself so a repository never depends
 * on another repository (UserRepository, for the email lookup) — this is
 * the orchestration layer, matching repository-ai-service.ts's shape.
 *
 * This instant "add by email, existing accounts only" path is kept
 * unchanged for backward compatibility — WorkspaceMembersPage's UI now
 * defaults to the pending-invitation flow in workspace-invitation-service.ts
 * instead, which reuses MULTI_MEMBER_PLANS exported below.
 */
import type { AuthUser, OrganizationRole, SubscriptionPlan, WorkspaceErrorCode, WorkspaceMember } from '@origami/contracts';
import type { RecordAuditEventInput } from './db/audit-log-repository.js';

export class WorkspaceMemberError extends Error {
  constructor(message: string, public readonly code: WorkspaceErrorCode) {
    super(message);
    this.name = 'WorkspaceMemberError';
  }
}

export const MULTI_MEMBER_PLANS: SubscriptionPlan[] = ['TEAM', 'AGENCY'];

export interface WorkspaceMemberOrganizationRepo {
  getMembershipRole(organizationId: string, userId: string): Promise<OrganizationRole | undefined>;
  listMembers(organizationId: string): Promise<WorkspaceMember[]>;
  addMember(organizationId: string, userId: string, role: OrganizationRole): Promise<void>;
  removeMember(organizationId: string, userId: string): Promise<void>;
  updateMemberRole(organizationId: string, userId: string, role: OrganizationRole): Promise<void>;
  countMembersByRole(organizationId: string, role: OrganizationRole): Promise<number>;
  transferOwnership(organizationId: string, fromUserId: string, toUserId: string): Promise<void>;
  getById(organizationId: string): Promise<{ id: string; name: string } | undefined>;
}

export interface WorkspaceMemberServiceDeps {
  userRepo: { findByEmail(email: string): Promise<AuthUser | undefined>; getById(id: string): Promise<AuthUser | undefined> };
  organizationRepo: WorkspaceMemberOrganizationRepo;
  getPlan(organizationId: string): Promise<SubscriptionPlan>;
  auditLog: { record(input: RecordAuditEventInput): Promise<void> };
  /** Best-effort notifications — a delivery failure never blocks the membership change itself (same contract as workspace-invitation-service.ts's sendInvitationEmailBestEffort). */
  sendWorkspaceMemberAddedEmail(to: string, data: { workspaceName: string; role: OrganizationRole; webAppBaseUrl: string }): Promise<void>;
  sendWorkspaceMemberRemovedEmail(to: string, data: { workspaceName: string }): Promise<void>;
  webAppBaseUrl: string;
}

async function recordAudit(deps: WorkspaceMemberServiceDeps, input: RecordAuditEventInput): Promise<void> {
  await deps.auditLog.record(input).catch(() => {});
}

async function notifyBestEffort(label: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error(`[workspace-member-service] Failed to send ${label} email:`, error instanceof Error ? error.message : error);
  }
}

export async function listWorkspaceMembers(deps: WorkspaceMemberServiceDeps, organizationId: string): Promise<WorkspaceMember[]> {
  return deps.organizationRepo.listMembers(organizationId);
}

export async function addWorkspaceMemberByEmail(
  deps: WorkspaceMemberServiceDeps,
  organizationId: string,
  actingUserId: string,
  email: string,
  role: OrganizationRole,
): Promise<WorkspaceMember> {
  if (role === 'OWNER') {
    throw new WorkspaceMemberError('Use ownership transfer to make someone else the owner.', 'FORBIDDEN');
  }

  const plan = await deps.getPlan(organizationId);
  if (!MULTI_MEMBER_PLANS.includes(plan)) {
    throw new WorkspaceMemberError(
      'This plan does not support multiple workspace members. Upgrade to Team to add teammates.',
      'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN',
    );
  }

  const user = await deps.userRepo.findByEmail(email);
  if (!user) {
    throw new WorkspaceMemberError('No Origami Lens account exists for that email yet.', 'MEMBER_NOT_FOUND');
  }

  const existingRole = await deps.organizationRepo.getMembershipRole(organizationId, user.id);
  if (existingRole) {
    throw new WorkspaceMemberError('This person is already a member of this workspace.', 'MEMBER_ALREADY_EXISTS');
  }

  await deps.organizationRepo.addMember(organizationId, user.id, role);
  await recordAudit(deps, {
    actorUserId: actingUserId,
    eventType: 'workspace.member.added',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { userId: user.id, role },
  });

  const organization = await deps.organizationRepo.getById(organizationId);
  await notifyBestEffort('workspace-member-added', () =>
    // `email` (the search input) rather than `user.email` — AuthUser.email is
    // optional in general, but this row was just found BY that exact email.
    deps.sendWorkspaceMemberAddedEmail(email, {
      workspaceName: organization?.name ?? 'Origami Lens',
      role,
      webAppBaseUrl: deps.webAppBaseUrl,
    }),
  );

  return { userId: user.id, email: user.email, displayName: user.displayName, role, joinedAt: new Date().toISOString() };
}

export async function removeWorkspaceMember(
  deps: WorkspaceMemberServiceDeps,
  organizationId: string,
  actingUserId: string,
  targetUserId: string,
): Promise<void> {
  const targetRole = await deps.organizationRepo.getMembershipRole(organizationId, targetUserId);
  if (targetRole === 'OWNER') {
    const ownerCount = await deps.organizationRepo.countMembersByRole(organizationId, 'OWNER');
    if (ownerCount <= 1) {
      throw new WorkspaceMemberError("Cannot remove the workspace's only owner. Transfer ownership first.", 'CANNOT_REMOVE_LAST_OWNER');
    }
  }

  const targetUser = await deps.userRepo.getById(targetUserId);

  await deps.organizationRepo.removeMember(organizationId, targetUserId);
  await recordAudit(deps, {
    actorUserId: actingUserId,
    eventType: 'workspace.member.removed',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { userId: targetUserId },
  });

  if (targetUser?.email) {
    const organization = await deps.organizationRepo.getById(organizationId);
    await notifyBestEffort('workspace-member-removed', () =>
      deps.sendWorkspaceMemberRemovedEmail(targetUser.email!, { workspaceName: organization?.name ?? 'Origami Lens' }),
    );
  }
}

export async function updateWorkspaceMemberRole(
  deps: WorkspaceMemberServiceDeps,
  organizationId: string,
  actingUserId: string,
  targetUserId: string,
  role: OrganizationRole,
): Promise<void> {
  if (role === 'OWNER') {
    throw new WorkspaceMemberError('Use ownership transfer to make someone else the owner.', 'FORBIDDEN');
  }

  const targetRole = await deps.organizationRepo.getMembershipRole(organizationId, targetUserId);
  if (targetRole === 'OWNER') {
    throw new WorkspaceMemberError("Cannot change the workspace owner's role directly. Transfer ownership first.", 'CANNOT_REMOVE_LAST_OWNER');
  }

  await deps.organizationRepo.updateMemberRole(organizationId, targetUserId, role);
  await recordAudit(deps, {
    actorUserId: actingUserId,
    eventType: 'workspace.member.role_changed',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { userId: targetUserId, role },
  });
}

export async function transferWorkspaceOwnership(
  deps: WorkspaceMemberServiceDeps,
  organizationId: string,
  currentOwnerUserId: string,
  newOwnerUserId: string,
): Promise<void> {
  const newOwnerRole = await deps.organizationRepo.getMembershipRole(organizationId, newOwnerUserId);
  if (!newOwnerRole) {
    throw new WorkspaceMemberError('The new owner must already be a member of this workspace.', 'MEMBER_NOT_FOUND');
  }

  await deps.organizationRepo.transferOwnership(organizationId, currentOwnerUserId, newOwnerUserId);
  await recordAudit(deps, {
    actorUserId: currentOwnerUserId,
    eventType: 'workspace.ownership.transferred',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { fromUserId: currentOwnerUserId, toUserId: newOwnerUserId },
  });
}
