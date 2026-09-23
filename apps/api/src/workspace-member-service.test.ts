import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthUser, OrganizationRole, SubscriptionPlan } from '@origami/contracts';
import {
  WorkspaceMemberError,
  addWorkspaceMemberByEmail,
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
  transferWorkspaceOwnership,
  type WorkspaceMemberServiceDeps,
} from './workspace-member-service.js';

function fakeUser(id: string, email: string): AuthUser {
  return { id, primaryProvider: 'GITHUB', primaryProviderLogin: id, email, platformRole: 'USER', createdAt: new Date().toISOString() };
}

interface Fakes {
  deps: WorkspaceMemberServiceDeps;
  addCalls: { organizationId: string; userId: string; role: OrganizationRole }[];
  removeCalls: string[];
  updateRoleCalls: { userId: string; role: OrganizationRole }[];
  transferCalls: { from: string; to: string }[];
  auditCalls: unknown[];
  memberAddedEmails: { to: string; workspaceName: string; role: OrganizationRole }[];
  memberRemovedEmails: { to: string; workspaceName: string }[];
}

function buildFakes(opts: {
  plan?: SubscriptionPlan;
  users?: Record<string, AuthUser>;
  memberships?: Record<string, OrganizationRole>;
  ownerCount?: number;
  orgName?: string;
} = {}): Fakes {
  const addCalls: Fakes['addCalls'] = [];
  const removeCalls: string[] = [];
  const updateRoleCalls: Fakes['updateRoleCalls'] = [];
  const transferCalls: Fakes['transferCalls'] = [];
  const auditCalls: unknown[] = [];
  const memberAddedEmails: Fakes['memberAddedEmails'] = [];
  const memberRemovedEmails: Fakes['memberRemovedEmails'] = [];
  const memberships = { ...(opts.memberships ?? {}) };

  const deps: WorkspaceMemberServiceDeps = {
    userRepo: {
      findByEmail: async (email) => Object.values(opts.users ?? {}).find((u) => u.email === email),
      getById: async (id) => opts.users?.[id],
    },
    organizationRepo: {
      getMembershipRole: async (_orgId, userId) => memberships[userId],
      listMembers: async () => [],
      addMember: async (organizationId, userId, role) => {
        addCalls.push({ organizationId, userId, role });
        memberships[userId] = role;
      },
      removeMember: async (_orgId, userId) => {
        removeCalls.push(userId);
        delete memberships[userId];
      },
      updateMemberRole: async (_orgId, userId, role) => {
        updateRoleCalls.push({ userId, role });
        memberships[userId] = role;
      },
      countMembersByRole: async (_orgId, role) => (opts.ownerCount !== undefined && role === 'OWNER' ? opts.ownerCount : Object.values(memberships).filter((r) => r === role).length),
      transferOwnership: async (_orgId, from, to) => {
        transferCalls.push({ from, to });
      },
      getById: async (organizationId) => ({ id: organizationId, name: opts.orgName ?? 'Test Org' }),
    },
    getPlan: async () => opts.plan ?? 'TEAM',
    auditLog: { record: async (input) => { auditCalls.push(input); } },
    sendWorkspaceMemberAddedEmail: async (to, data) => { memberAddedEmails.push({ to, workspaceName: data.workspaceName, role: data.role }); },
    sendWorkspaceMemberRemovedEmail: async (to, data) => { memberRemovedEmails.push({ to, workspaceName: data.workspaceName }); },
    webAppBaseUrl: 'http://localhost:5173',
  };

  return { deps, addCalls, removeCalls, updateRoleCalls, transferCalls, auditCalls, memberAddedEmails, memberRemovedEmails };
}

describe('addWorkspaceMemberByEmail', () => {
  it('adds an existing user by email with the requested role', async () => {
    const alice = fakeUser('alice', 'alice@example.com');
    const { deps, addCalls, auditCalls } = buildFakes({ users: { alice } });

    const result = await addWorkspaceMemberByEmail(deps, 'org-1', 'owner-1', 'alice@example.com', 'MEMBER');

    assert.equal(result.userId, 'alice');
    assert.equal(result.role, 'MEMBER');
    assert.deepEqual(addCalls, [{ organizationId: 'org-1', userId: 'alice', role: 'MEMBER' }]);
    assert.equal(auditCalls.length, 1);
  });

  it('sends a best-effort workspace-member-added email to the new member', async () => {
    const alice = fakeUser('alice', 'alice@example.com');
    const { deps, memberAddedEmails } = buildFakes({ users: { alice }, orgName: 'Acme Corp' });

    await addWorkspaceMemberByEmail(deps, 'org-1', 'owner-1', 'alice@example.com', 'MEMBER');

    assert.deepEqual(memberAddedEmails, [{ to: 'alice@example.com', workspaceName: 'Acme Corp', role: 'MEMBER' }]);
  });

  it('still adds the member even if the notification email send fails', async () => {
    const alice = fakeUser('alice', 'alice@example.com');
    const { deps, addCalls } = buildFakes({ users: { alice } });
    deps.sendWorkspaceMemberAddedEmail = async () => { throw new Error('SMTP down'); };

    const result = await addWorkspaceMemberByEmail(deps, 'org-1', 'owner-1', 'alice@example.com', 'MEMBER');

    assert.equal(result.userId, 'alice');
    assert.equal(addCalls.length, 1);
  });

  it('rejects with MEMBER_NOT_FOUND when no account exists for that email', async () => {
    const { deps } = buildFakes({ users: {} });
    await assert.rejects(
      () => addWorkspaceMemberByEmail(deps, 'org-1', 'owner-1', 'ghost@example.com', 'MEMBER'),
      (error: unknown) => error instanceof WorkspaceMemberError && error.code === 'MEMBER_NOT_FOUND',
    );
  });

  it('rejects with MEMBER_ALREADY_EXISTS for someone already in the workspace', async () => {
    const alice = fakeUser('alice', 'alice@example.com');
    const { deps } = buildFakes({ users: { alice }, memberships: { alice: 'VIEWER' } });
    await assert.rejects(
      () => addWorkspaceMemberByEmail(deps, 'org-1', 'owner-1', 'alice@example.com', 'MEMBER'),
      (error: unknown) => error instanceof WorkspaceMemberError && error.code === 'MEMBER_ALREADY_EXISTS',
    );
  });

  it('rejects with MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN for a FREE/DEVELOPER/PRO organization', async () => {
    const alice = fakeUser('alice', 'alice@example.com');
    const { deps } = buildFakes({ users: { alice }, plan: 'PRO' });
    await assert.rejects(
      () => addWorkspaceMemberByEmail(deps, 'org-1', 'owner-1', 'alice@example.com', 'MEMBER'),
      (error: unknown) => error instanceof WorkspaceMemberError && error.code === 'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN',
    );
  });

  it('rejects assigning OWNER via add-member — must go through transfer-ownership instead', async () => {
    const alice = fakeUser('alice', 'alice@example.com');
    const { deps } = buildFakes({ users: { alice } });
    await assert.rejects(
      () => addWorkspaceMemberByEmail(deps, 'org-1', 'owner-1', 'alice@example.com', 'OWNER'),
      (error: unknown) => error instanceof WorkspaceMemberError && error.code === 'FORBIDDEN',
    );
  });
});

describe('removeWorkspaceMember', () => {
  it('removes an ordinary member', async () => {
    const { deps, removeCalls } = buildFakes({ memberships: { bob: 'MEMBER' } });
    await removeWorkspaceMember(deps, 'org-1', 'owner-1', 'bob');
    assert.deepEqual(removeCalls, ['bob']);
  });

  it('sends a best-effort workspace-member-removed email to the removed member', async () => {
    const bob = fakeUser('bob', 'bob@example.com');
    const { deps, memberRemovedEmails } = buildFakes({ memberships: { bob: 'MEMBER' }, users: { bob }, orgName: 'Acme Corp' });
    await removeWorkspaceMember(deps, 'org-1', 'owner-1', 'bob');
    assert.deepEqual(memberRemovedEmails, [{ to: 'bob@example.com', workspaceName: 'Acme Corp' }]);
  });

  it('skips the notification when the removed user has no email on file', async () => {
    const bob: AuthUser = { id: 'bob', primaryProvider: 'GITHUB', primaryProviderLogin: 'bob', platformRole: 'USER', createdAt: new Date().toISOString() };
    const { deps, memberRemovedEmails, removeCalls } = buildFakes({ memberships: { bob: 'MEMBER' }, users: { bob } });
    await removeWorkspaceMember(deps, 'org-1', 'owner-1', 'bob');
    assert.deepEqual(removeCalls, ['bob']);
    assert.deepEqual(memberRemovedEmails, []);
  });

  it('rejects removing the workspace\'s only OWNER', async () => {
    const { deps } = buildFakes({ memberships: { owner1: 'OWNER' }, ownerCount: 1 });
    await assert.rejects(
      () => removeWorkspaceMember(deps, 'org-1', 'owner-1', 'owner1'),
      (error: unknown) => error instanceof WorkspaceMemberError && error.code === 'CANNOT_REMOVE_LAST_OWNER',
    );
  });

  it('allows removing an OWNER when a second OWNER exists', async () => {
    const { deps, removeCalls } = buildFakes({ memberships: { owner1: 'OWNER', owner2: 'OWNER' }, ownerCount: 2 });
    await removeWorkspaceMember(deps, 'org-1', 'owner-1', 'owner1');
    assert.deepEqual(removeCalls, ['owner1']);
  });
});

describe('updateWorkspaceMemberRole', () => {
  it('changes an ordinary member\'s role', async () => {
    const { deps, updateRoleCalls } = buildFakes({ memberships: { bob: 'VIEWER' } });
    await updateWorkspaceMemberRole(deps, 'org-1', 'owner-1', 'bob', 'ADMIN');
    assert.deepEqual(updateRoleCalls, [{ userId: 'bob', role: 'ADMIN' }]);
  });

  it('rejects setting role to OWNER directly — must use transfer-ownership', async () => {
    const { deps } = buildFakes({ memberships: { bob: 'MEMBER' } });
    await assert.rejects(
      () => updateWorkspaceMemberRole(deps, 'org-1', 'owner-1', 'bob', 'OWNER'),
      (error: unknown) => error instanceof WorkspaceMemberError && error.code === 'FORBIDDEN',
    );
  });

  it('rejects changing the current OWNER\'s role directly', async () => {
    const { deps } = buildFakes({ memberships: { owner1: 'OWNER' } });
    await assert.rejects(
      () => updateWorkspaceMemberRole(deps, 'org-1', 'owner-1', 'owner1', 'MEMBER'),
      (error: unknown) => error instanceof WorkspaceMemberError && error.code === 'CANNOT_REMOVE_LAST_OWNER',
    );
  });
});

describe('transferWorkspaceOwnership', () => {
  it('transfers ownership to an existing member', async () => {
    const { deps, transferCalls, auditCalls } = buildFakes({ memberships: { bob: 'ADMIN' } });
    await transferWorkspaceOwnership(deps, 'org-1', 'owner-1', 'bob');
    assert.deepEqual(transferCalls, [{ from: 'owner-1', to: 'bob' }]);
    assert.equal(auditCalls.length, 1);
  });

  it('rejects transferring to someone who is not already a member', async () => {
    const { deps } = buildFakes({ memberships: {} });
    await assert.rejects(
      () => transferWorkspaceOwnership(deps, 'org-1', 'owner-1', 'stranger'),
      (error: unknown) => error instanceof WorkspaceMemberError && error.code === 'MEMBER_NOT_FOUND',
    );
  });
});
