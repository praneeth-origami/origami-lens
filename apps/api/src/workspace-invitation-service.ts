/**
 * Workspace invitation lifecycle — create/list/revoke/resend/preview/accept.
 * Mirrors workspace-member-service.ts's shape (error-with-code class,
 * best-effort audit helper, DI-injected repo interfaces) but membership is
 * created ONLY on explicit acceptance (workspace-invitation-repository.ts's
 * acceptByTokenHash), never at invitation-creation time.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type {
  AcceptInvitationResponse,
  AuthUser,
  InvitationPreviewResponse,
  OrganizationRole,
  SubscriptionPlan,
  WorkspaceInvitation,
  WorkspaceInvitationErrorCode,
} from '@origami/contracts';
import type { RecordAuditEventInput } from './db/audit-log-repository.js';
import type { InvitationPreview, AcceptInvitationResult } from './db/workspace-invitation-repository.js';
import { MULTI_MEMBER_PLANS } from './workspace-member-service.js';
import { normalizeEmail } from './shared/normalize-email.js';
import { EmailNotConfiguredError, type WorkspaceInvitationEmailInput } from './email-service.js';

export class WorkspaceInvitationError extends Error {
  constructor(message: string, public readonly code: WorkspaceInvitationErrorCode) {
    super(message);
    this.name = 'WorkspaceInvitationError';
  }
}

/** Matches the frontend's existing ASSIGNABLE_ROLES for instant add-by-email — the product already lets OWNER/ADMIN assign ADMIN directly, so invitations don't restrict it further. OWNER is never invitable; ownership transfer is a separate, explicit operation. */
export const INVITABLE_ROLES: OrganizationRole[] = ['ADMIN', 'MEMBER', 'VIEWER', 'CLIENT_VIEWER'];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface WorkspaceInvitationRepo {
  create(input: {
    id: string;
    organizationId: string;
    invitedEmail: string;
    invitedByUserId: string;
    role: OrganizationRole;
    tokenHash: string;
    expiresAt: string;
  }): Promise<WorkspaceInvitation>;
  findPendingByOrgAndEmail(organizationId: string, invitedEmail: string): Promise<WorkspaceInvitation | undefined>;
  findById(organizationId: string, id: string): Promise<WorkspaceInvitation | undefined>;
  listByOrganization(organizationId: string, limit?: number): Promise<WorkspaceInvitation[]>;
  revoke(id: string): Promise<void>;
  rotateToken(id: string, tokenHash: string, expiresAt: string): Promise<WorkspaceInvitation | undefined>;
  findPreviewByTokenHash(tokenHash: string): Promise<InvitationPreview | undefined>;
  acceptByTokenHash(tokenHash: string, acceptingUserId: string, normalizedAcceptingEmail: string): Promise<AcceptInvitationResult>;
}

export interface WorkspaceInvitationOrganizationRepo {
  getMembershipRole(organizationId: string, userId: string): Promise<OrganizationRole | undefined>;
  getById(organizationId: string): Promise<{ id: string; name: string } | undefined>;
}

export interface WorkspaceInvitationUserRepo {
  findByEmail(email: string): Promise<AuthUser | undefined>;
  getById(id: string): Promise<AuthUser | undefined>;
}

export interface WorkspaceInvitationServiceDeps {
  invitationRepo: WorkspaceInvitationRepo;
  organizationRepo: WorkspaceInvitationOrganizationRepo;
  userRepo: WorkspaceInvitationUserRepo;
  getPlan(organizationId: string): Promise<SubscriptionPlan>;
  auditLog: { record(input: RecordAuditEventInput): Promise<void> };
  sendWorkspaceInvitationEmail(to: string, input: WorkspaceInvitationEmailInput): Promise<void>;
  webAppBaseUrl: string;
  /** WORKSPACE_INVITATION_EXPIRATION_DAYS, injected so this stays unit-testable without reading process.env directly. */
  expirationDays: number;
}

async function recordAudit(deps: WorkspaceInvitationServiceDeps, input: RecordAuditEventInput): Promise<void> {
  await deps.auditLog.record(input).catch(() => {});
}

function generateToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

function buildInvitationUrl(webAppBaseUrl: string, rawToken: string): string {
  return `${webAppBaseUrl}/invitations/${rawToken}`;
}

/** Best-effort send — a delivery failure never blocks the invitation from existing (spec §30). In non-production, the raw link is logged server-side (never returned by any API response) so the feature is testable without real SMTP configured. */
async function sendInvitationEmailBestEffort(
  deps: WorkspaceInvitationServiceDeps,
  to: string,
  emailInput: WorkspaceInvitationEmailInput,
  rawUrl: string,
): Promise<boolean> {
  try {
    await deps.sendWorkspaceInvitationEmail(to, emailInput);
    return true;
  } catch (error) {
    if (error instanceof EmailNotConfiguredError) {
      console.error('[workspace-invitation-service] Invitation created but email sending is not configured.');
    } else {
      console.error('[workspace-invitation-service] Failed to send invitation email:', error instanceof Error ? error.message : error);
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[workspace-invitation-service] (dev only) invitation link for ${to}: ${rawUrl}`);
    }
    return false;
  }
}

export async function createWorkspaceInvitation(
  deps: WorkspaceInvitationServiceDeps,
  organizationId: string,
  actingUserId: string,
  emailInput: string,
  role: OrganizationRole,
): Promise<{ invitation: WorkspaceInvitation; emailDelivered: boolean }> {
  if (!INVITABLE_ROLES.includes(role)) {
    throw new WorkspaceInvitationError('That role cannot be assigned through an invitation.', 'INVALID_ROLE');
  }

  const email = normalizeEmail(emailInput);
  if (!EMAIL_PATTERN.test(email)) {
    throw new WorkspaceInvitationError('Enter a valid email address.', 'INVALID_EMAIL');
  }

  const plan = await deps.getPlan(organizationId);
  if (!MULTI_MEMBER_PLANS.includes(plan)) {
    throw new WorkspaceInvitationError(
      'This plan does not support multiple workspace members. Upgrade to Team to add teammates.',
      'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN',
    );
  }

  const existingAccount = await deps.userRepo.findByEmail(email);
  if (existingAccount) {
    const existingRole = await deps.organizationRepo.getMembershipRole(organizationId, existingAccount.id);
    if (existingRole) {
      throw new WorkspaceInvitationError('This person is already a member of this workspace.', 'MEMBER_ALREADY_EXISTS');
    }
  }

  const previousPending = await deps.invitationRepo.findPendingByOrgAndEmail(organizationId, email);
  if (previousPending) {
    await deps.invitationRepo.revoke(previousPending.id);
  }

  const { rawToken, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + deps.expirationDays * 24 * 60 * 60 * 1000).toISOString();

  const invitation = await deps.invitationRepo.create({
    id: randomUUID(),
    organizationId,
    invitedEmail: email,
    invitedByUserId: actingUserId,
    role,
    tokenHash,
    expiresAt,
  });

  const [organization, inviter] = await Promise.all([
    deps.organizationRepo.getById(organizationId),
    deps.userRepo.getById(actingUserId),
  ]);
  const rawUrl = buildInvitationUrl(deps.webAppBaseUrl, rawToken);
  const emailDelivered = await sendInvitationEmailBestEffort(
    deps,
    email,
    {
      workspaceName: organization?.name ?? 'Origami Lens',
      inviterName: inviter?.displayName ?? inviter?.email ?? 'A teammate',
      role,
      url: rawUrl,
      expiresAt,
    },
    rawUrl,
  );

  await recordAudit(deps, {
    actorUserId: actingUserId,
    eventType: 'workspace.invitation.created',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { email, role, emailDelivered },
  });

  return { invitation, emailDelivered };
}

export async function listWorkspaceInvitations(deps: WorkspaceInvitationServiceDeps, organizationId: string): Promise<WorkspaceInvitation[]> {
  return deps.invitationRepo.listByOrganization(organizationId);
}

export async function revokeWorkspaceInvitation(
  deps: WorkspaceInvitationServiceDeps,
  organizationId: string,
  actingUserId: string,
  invitationId: string,
): Promise<void> {
  const invitation = await deps.invitationRepo.findById(organizationId, invitationId);
  if (!invitation || invitation.status !== 'PENDING') {
    throw new WorkspaceInvitationError('Invitation not found.', 'INVITATION_NOT_FOUND');
  }

  await deps.invitationRepo.revoke(invitationId);
  await recordAudit(deps, {
    actorUserId: actingUserId,
    eventType: 'workspace.invitation.revoked',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { invitationId, email: invitation.invitedEmail },
  });
}

export async function resendWorkspaceInvitation(
  deps: WorkspaceInvitationServiceDeps,
  organizationId: string,
  actingUserId: string,
  invitationId: string,
): Promise<{ invitation: WorkspaceInvitation; emailDelivered: boolean }> {
  const existing = await deps.invitationRepo.findById(organizationId, invitationId);
  if (!existing || existing.status !== 'PENDING') {
    throw new WorkspaceInvitationError('Invitation not found.', 'INVITATION_NOT_FOUND');
  }

  const { rawToken, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + deps.expirationDays * 24 * 60 * 60 * 1000).toISOString();
  const rotated = await deps.invitationRepo.rotateToken(invitationId, tokenHash, expiresAt);
  if (!rotated) {
    throw new WorkspaceInvitationError('Invitation not found.', 'INVITATION_NOT_FOUND');
  }

  const [organization, inviter] = await Promise.all([
    deps.organizationRepo.getById(organizationId),
    deps.userRepo.getById(actingUserId),
  ]);
  const rawUrl = buildInvitationUrl(deps.webAppBaseUrl, rawToken);
  const emailDelivered = await sendInvitationEmailBestEffort(
    deps,
    existing.invitedEmail,
    {
      workspaceName: organization?.name ?? 'Origami Lens',
      inviterName: inviter?.displayName ?? inviter?.email ?? 'A teammate',
      role: existing.role,
      url: rawUrl,
      expiresAt,
    },
    rawUrl,
  );

  await recordAudit(deps, {
    actorUserId: actingUserId,
    eventType: 'workspace.invitation.resent',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { invitationId, email: existing.invitedEmail, emailDelivered },
  });

  return { invitation: rotated, emailDelivered };
}

export async function getInvitationPreview(deps: WorkspaceInvitationServiceDeps, rawToken: string): Promise<InvitationPreviewResponse> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const preview = await deps.invitationRepo.findPreviewByTokenHash(tokenHash);
  if (!preview) return { status: 'NOT_FOUND' };
  return {
    status: preview.status,
    organizationName: preview.organizationName,
    inviterEmail: preview.inviterEmail,
    invitedEmail: preview.invitedEmail,
    role: preview.role,
    expiresAt: preview.expiresAt,
  };
}

function acceptErrorFor(reason: Exclude<AcceptInvitationResult, { ok: true }>['reason']): WorkspaceInvitationError {
  switch (reason) {
    case 'NOT_FOUND':
      return new WorkspaceInvitationError('This invitation link is invalid.', 'INVITATION_NOT_FOUND');
    case 'EMAIL_MISMATCH':
      return new WorkspaceInvitationError('This invitation was sent to a different email address.', 'EMAIL_MISMATCH');
    case 'EXPIRED':
      return new WorkspaceInvitationError('This invitation has expired.', 'INVITATION_EXPIRED');
    case 'REVOKED':
      return new WorkspaceInvitationError('This invitation has been revoked.', 'INVITATION_REVOKED');
    case 'ALREADY_ACCEPTED':
      return new WorkspaceInvitationError('This invitation has already been accepted.', 'INVITATION_ALREADY_ACCEPTED');
  }
}

export async function acceptWorkspaceInvitation(
  deps: WorkspaceInvitationServiceDeps,
  rawToken: string,
  acceptingUser: Pick<AuthUser, 'id' | 'email'>,
): Promise<AcceptInvitationResponse> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const normalizedEmail = normalizeEmail(acceptingUser.email ?? '');
  const result = await deps.invitationRepo.acceptByTokenHash(tokenHash, acceptingUser.id, normalizedEmail);

  if (!result.ok) {
    throw acceptErrorFor(result.reason);
  }

  await recordAudit(deps, {
    actorUserId: acceptingUser.id,
    eventType: 'workspace.invitation.accepted',
    targetType: 'organization',
    targetId: result.organizationId,
    metadata: { role: result.role },
  });

  return { organizationId: result.organizationId, organizationName: result.organizationName, role: result.role };
}
