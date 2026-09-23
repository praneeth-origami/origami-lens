import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthUser, OrganizationRole, SubscriptionPlan, WorkspaceInvitation } from '@origami/contracts';
import {
  WorkspaceInvitationError,
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
  resendWorkspaceInvitation,
  getInvitationPreview,
  acceptWorkspaceInvitation,
  type WorkspaceInvitationServiceDeps,
} from './workspace-invitation-service.js';
import type { AcceptInvitationResult, InvitationPreview } from './db/workspace-invitation-repository.js';

function fakeUser(id: string, email: string, displayName?: string): AuthUser {
  return { id, primaryProvider: 'EMAIL', primaryProviderLogin: id, email, displayName, platformRole: 'USER', createdAt: new Date().toISOString() };
}

function fakeInvitation(overrides: Partial<WorkspaceInvitation> = {}): WorkspaceInvitation {
  return {
    id: 'inv-1',
    organizationId: 'org-1',
    invitedEmail: 'invitee@example.com',
    invitedByUserId: 'owner-1',
    role: 'MEMBER',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Fakes {
  deps: WorkspaceInvitationServiceDeps;
  createCalls: unknown[];
  revokeCalls: string[];
  rotateCalls: string[];
  sentEmails: { to: string; role: string }[];
  auditCalls: unknown[];
}

function buildFakes(opts: {
  plan?: SubscriptionPlan;
  users?: Record<string, AuthUser>;
  memberships?: Record<string, OrganizationRole>;
  pendingInvitation?: WorkspaceInvitation;
  invitationById?: WorkspaceInvitation;
  preview?: InvitationPreview;
  acceptResult?: AcceptInvitationResult;
  emailShouldFail?: boolean;
} = {}): Fakes {
  const createCalls: unknown[] = [];
  const revokeCalls: string[] = [];
  const rotateCalls: string[] = [];
  const sentEmails: { to: string; role: string }[] = [];
  const auditCalls: unknown[] = [];

  const deps: WorkspaceInvitationServiceDeps = {
    invitationRepo: {
      create: async (input) => {
        createCalls.push(input);
        return fakeInvitation({ invitedEmail: input.invitedEmail, role: input.role, organizationId: input.organizationId });
      },
      findPendingByOrgAndEmail: async () => opts.pendingInvitation,
      findById: async () => opts.invitationById,
      listByOrganization: async () => [fakeInvitation()],
      revoke: async (id) => { revokeCalls.push(id); },
      rotateToken: async (id) => {
        rotateCalls.push(id);
        return opts.invitationById ? { ...opts.invitationById, expiresAt: new Date(Date.now() + 999999).toISOString() } : undefined;
      },
      findPreviewByTokenHash: async () => opts.preview,
      acceptByTokenHash: async () => opts.acceptResult ?? { ok: false, reason: 'NOT_FOUND' },
    },
    organizationRepo: {
      getMembershipRole: async (_orgId, userId) => opts.memberships?.[userId],
      getById: async () => ({ id: 'org-1', name: 'Acme Workspace' }),
    },
    userRepo: {
      findByEmail: async (email) => Object.values(opts.users ?? {}).find((u) => u.email === email),
      getById: async (id) => (opts.users ?? {})[id],
    },
    getPlan: async () => opts.plan ?? 'TEAM',
    auditLog: { record: async (input) => { auditCalls.push(input); } },
    sendWorkspaceInvitationEmail: async (to, input) => {
      if (opts.emailShouldFail) throw new Error('smtp down');
      sentEmails.push({ to, role: input.role });
    },
    webAppBaseUrl: 'http://localhost:5173',
    expirationDays: 7,
  };

  return { deps, createCalls, revokeCalls, rotateCalls, sentEmails, auditCalls };
}

describe('createWorkspaceInvitation', () => {
  it('creates a PENDING invitation and delivers the email', async () => {
    const { deps, createCalls, sentEmails, auditCalls } = buildFakes();
    const { invitation, emailDelivered } = await createWorkspaceInvitation(deps, 'org-1', 'owner-1', 'Invitee@Example.com  ', 'MEMBER');

    assert.equal(emailDelivered, true);
    assert.equal(invitation.invitedEmail, 'invitee@example.com');
    assert.equal(createCalls.length, 1);
    assert.equal((createCalls[0] as { invitedEmail: string }).invitedEmail, 'invitee@example.com');
    assert.equal(sentEmails.length, 1);
    assert.equal(auditCalls.length, 1);
  });

  it('reports emailDelivered:false without throwing when sending fails', async () => {
    const { deps } = buildFakes({ emailShouldFail: true });
    const { emailDelivered } = await createWorkspaceInvitation(deps, 'org-1', 'owner-1', 'invitee@example.com', 'MEMBER');
    assert.equal(emailDelivered, false);
  });

  it('rejects inviting as OWNER', async () => {
    const { deps } = buildFakes();
    await assert.rejects(
      () => createWorkspaceInvitation(deps, 'org-1', 'owner-1', 'invitee@example.com', 'OWNER'),
      (error: unknown) => error instanceof WorkspaceInvitationError && error.code === 'INVALID_ROLE',
    );
  });

  it('rejects an invalid email address', async () => {
    const { deps } = buildFakes();
    await assert.rejects(
      () => createWorkspaceInvitation(deps, 'org-1', 'owner-1', 'not-an-email', 'MEMBER'),
      (error: unknown) => error instanceof WorkspaceInvitationError && error.code === 'INVALID_EMAIL',
    );
  });

  it('rejects on a plan that does not support multiple members', async () => {
    const { deps } = buildFakes({ plan: 'PRO' });
    await assert.rejects(
      () => createWorkspaceInvitation(deps, 'org-1', 'owner-1', 'invitee@example.com', 'MEMBER'),
      (error: unknown) => error instanceof WorkspaceInvitationError && error.code === 'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN',
    );
  });

  it('rejects when the invited email already belongs to a member', async () => {
    const alice = fakeUser('alice', 'alice@example.com');
    const { deps } = buildFakes({ users: { alice }, memberships: { alice: 'VIEWER' } });
    await assert.rejects(
      () => createWorkspaceInvitation(deps, 'org-1', 'owner-1', 'alice@example.com', 'MEMBER'),
      (error: unknown) => error instanceof WorkspaceInvitationError && error.code === 'MEMBER_ALREADY_EXISTS',
    );
  });

  it('allows inviting an email that already has an account but is not yet a member', async () => {
    const alice = fakeUser('alice', 'alice@example.com');
    const { deps, createCalls } = buildFakes({ users: { alice }, memberships: {} });
    await createWorkspaceInvitation(deps, 'org-1', 'owner-1', 'alice@example.com', 'MEMBER');
    assert.equal(createCalls.length, 1);
  });

  it('revokes a previous PENDING invitation for the same org/email before creating a new one', async () => {
    const previous = fakeInvitation({ id: 'inv-old' });
    const { deps, revokeCalls, createCalls } = buildFakes({ pendingInvitation: previous });
    await createWorkspaceInvitation(deps, 'org-1', 'owner-1', 'invitee@example.com', 'MEMBER');
    assert.deepEqual(revokeCalls, ['inv-old']);
    assert.equal(createCalls.length, 1);
  });

  it('allows inviting as ADMIN — matches the existing instant add-by-email capability', async () => {
    const { deps, createCalls } = buildFakes();
    await createWorkspaceInvitation(deps, 'org-1', 'owner-1', 'invitee@example.com', 'ADMIN');
    assert.equal((createCalls[0] as { role: OrganizationRole }).role, 'ADMIN');
  });
});

describe('listWorkspaceInvitations', () => {
  it('returns the organization\'s invitations', async () => {
    const { deps } = buildFakes();
    const invitations = await listWorkspaceInvitations(deps, 'org-1');
    assert.equal(invitations.length, 1);
  });
});

describe('revokeWorkspaceInvitation', () => {
  it('revokes a PENDING invitation', async () => {
    const { deps, revokeCalls, auditCalls } = buildFakes({ invitationById: fakeInvitation() });
    await revokeWorkspaceInvitation(deps, 'org-1', 'owner-1', 'inv-1');
    assert.deepEqual(revokeCalls, ['inv-1']);
    assert.equal(auditCalls.length, 1);
  });

  it('rejects when the invitation does not exist in this organization', async () => {
    const { deps } = buildFakes({ invitationById: undefined });
    await assert.rejects(
      () => revokeWorkspaceInvitation(deps, 'org-1', 'owner-1', 'ghost'),
      (error: unknown) => error instanceof WorkspaceInvitationError && error.code === 'INVITATION_NOT_FOUND',
    );
  });

  it('rejects revoking an invitation that is no longer PENDING', async () => {
    const { deps } = buildFakes({ invitationById: fakeInvitation({ status: 'ACCEPTED' }) });
    await assert.rejects(
      () => revokeWorkspaceInvitation(deps, 'org-1', 'owner-1', 'inv-1'),
      (error: unknown) => error instanceof WorkspaceInvitationError && error.code === 'INVITATION_NOT_FOUND',
    );
  });
});

describe('resendWorkspaceInvitation', () => {
  it('rotates the token and re-sends', async () => {
    const { deps, rotateCalls, sentEmails, auditCalls } = buildFakes({ invitationById: fakeInvitation() });
    await resendWorkspaceInvitation(deps, 'org-1', 'owner-1', 'inv-1');
    assert.deepEqual(rotateCalls, ['inv-1']);
    assert.equal(sentEmails.length, 1);
    assert.equal(auditCalls.length, 1);
  });

  it('rejects when the invitation does not exist', async () => {
    const { deps } = buildFakes({ invitationById: undefined });
    await assert.rejects(
      () => resendWorkspaceInvitation(deps, 'org-1', 'owner-1', 'ghost'),
      (error: unknown) => error instanceof WorkspaceInvitationError && error.code === 'INVITATION_NOT_FOUND',
    );
  });
});

describe('getInvitationPreview', () => {
  it('returns NOT_FOUND for an unknown token', async () => {
    const { deps } = buildFakes({ preview: undefined });
    const result = await getInvitationPreview(deps, 'bogus-token');
    assert.equal(result.status, 'NOT_FOUND');
  });

  it('returns the invitation preview for a known token', async () => {
    const { deps } = buildFakes({
      preview: {
        organizationId: 'org-1',
        organizationName: 'Acme Workspace',
        inviterEmail: 'owner@example.com',
        invitedEmail: 'invitee@example.com',
        role: 'MEMBER',
        status: 'PENDING',
        expiresAt: new Date().toISOString(),
      },
    });
    const result = await getInvitationPreview(deps, 'real-token');
    assert.equal(result.status, 'PENDING');
    assert.equal(result.organizationName, 'Acme Workspace');
    assert.equal(result.invitedEmail, 'invitee@example.com');
  });
});

describe('acceptWorkspaceInvitation', () => {
  const acceptor = fakeUser('bob', 'invitee@example.com');

  it('accepts a valid invitation and returns the workspace', async () => {
    const { deps, auditCalls } = buildFakes({
      acceptResult: { ok: true, organizationId: 'org-1', organizationName: 'Acme Workspace', role: 'MEMBER' },
    });
    const result = await acceptWorkspaceInvitation(deps, 'raw-token', acceptor);
    assert.deepEqual(result, { organizationId: 'org-1', organizationName: 'Acme Workspace', role: 'MEMBER' });
    assert.equal(auditCalls.length, 1);
  });

  for (const [reason, code] of [
    ['NOT_FOUND', 'INVITATION_NOT_FOUND'],
    ['EMAIL_MISMATCH', 'EMAIL_MISMATCH'],
    ['EXPIRED', 'INVITATION_EXPIRED'],
    ['REVOKED', 'INVITATION_REVOKED'],
    ['ALREADY_ACCEPTED', 'INVITATION_ALREADY_ACCEPTED'],
  ] as const) {
    it(`maps repository reason ${reason} to error code ${code}`, async () => {
      const { deps } = buildFakes({ acceptResult: { ok: false, reason } });
      await assert.rejects(
        () => acceptWorkspaceInvitation(deps, 'raw-token', acceptor),
        (error: unknown) => error instanceof WorkspaceInvitationError && error.code === code,
      );
    });
  }
});
