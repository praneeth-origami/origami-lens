import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthUser, PlatformRole } from '@origami/contracts';
import {
  AdminError,
  listUsersForAdmin,
  listWorkspacesForAdmin,
  updateUserPlatformRole,
  searchUsersForAdmin,
  getUserDetailForAdmin,
  type AdminServiceDeps,
} from './admin-service.js';

function fakeUser(id: string, platformRole: PlatformRole = 'USER'): AuthUser {
  return { id, primaryProvider: 'GITHUB', primaryProviderLogin: id, email: `${id}@example.com`, platformRole, createdAt: new Date().toISOString() };
}

function buildDeps(
  overrides: Partial<{
    users: AuthUser[];
    founderCount: number;
    personalOrgByUser: Record<string, string>;
    membershipRoles: Record<string, string>;
    organizations: Record<string, { id: string; name: string }>;
    plans: Record<string, string>;
    usageToday: unknown[];
    lastActiveAt: string;
  }> = {},
) {
  const users = new Map((overrides.users ?? []).map((u) => [u.id, u]));
  const updateCalls: { id: string; role: PlatformRole }[] = [];
  const auditCalls: unknown[] = [];

  const deps: AdminServiceDeps = {
    userRepo: {
      listAll: async () => [...users.values()],
      getById: async (id) => users.get(id),
      updatePlatformRole: async (id, platformRole) => {
        updateCalls.push({ id, role: platformRole });
        const updated = { ...users.get(id)!, platformRole };
        users.set(id, updated);
        return updated;
      },
      countByPlatformRole: async (role) => overrides.founderCount ?? [...users.values()].filter((u) => u.platformRole === role).length,
      countCreatedSince: async () => 0,
      countAll: async () => users.size,
    },
    organizationRepo: {
      listAllForAdmin: async () => [{ id: 'org-1', name: 'Test Org', createdAt: new Date().toISOString(), ownerEmail: 'a@example.com' }],
      countMembers: async () => 2,
      getOrganizationIdsForUser: async (userId) => (overrides.personalOrgByUser?.[userId] ? [overrides.personalOrgByUser[userId]] : ['org-1']),
      getById: async (organizationId) => overrides.organizations?.[organizationId],
      getPersonalOrganization: async (userId) => {
        const orgId = overrides.personalOrgByUser?.[userId];
        return orgId ? { id: orgId } : undefined;
      },
      getMembershipRole: async (_organizationId, userId) => overrides.membershipRoles?.[userId] as never,
    },
    subscriptionRepo: {
      findByOrganizationId: async (organizationId) => ({ plan: (overrides.plans?.[organizationId] ?? 'PRO') as never }),
    },
    sessionRepo: {
      getLastActiveAt: async () => overrides.lastActiveAt,
      countActiveSince: async () => 0,
    },
    getUsageToday: async () => (overrides.usageToday ?? []) as never,
    auditLog: {
      record: async (input) => {
        auditCalls.push(input);
      },
      listRecent: async () => [],
    },
  };

  return { deps, updateCalls, auditCalls };
}

describe('listUsersForAdmin', () => {
  it('returns every user with their platform role and workspace count', async () => {
    const { deps } = buildDeps({ users: [fakeUser('a'), fakeUser('b', 'ADMIN')] });
    const users = await listUsersForAdmin(deps);
    assert.equal(users.length, 2);
    assert.equal(users[1].platformRole, 'ADMIN');
    assert.equal(users[0].workspaceCount, 1);
  });
});

describe('listWorkspacesForAdmin', () => {
  it('returns every organization with its plan, member count, and owner email', async () => {
    const { deps } = buildDeps();
    const workspaces = await listWorkspacesForAdmin(deps);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].plan, 'PRO');
    assert.equal(workspaces[0].memberCount, 2);
    assert.equal(workspaces[0].ownerEmail, 'a@example.com');
  });
});

describe('updateUserPlatformRole', () => {
  it('updates the target user\'s platform role and audit-logs it', async () => {
    const { deps, updateCalls, auditCalls } = buildDeps({ users: [fakeUser('founder-1', 'FOUNDER'), fakeUser('target-1')] });
    const updated = await updateUserPlatformRole(deps, 'founder-1', 'target-1', 'ADMIN');
    assert.equal(updated.platformRole, 'ADMIN');
    assert.deepEqual(updateCalls, [{ id: 'target-1', role: 'ADMIN' }]);
    assert.equal(auditCalls.length, 1);
  });

  it('rejects for a nonexistent target user', async () => {
    const { deps } = buildDeps({ users: [fakeUser('founder-1', 'FOUNDER')] });
    await assert.rejects(
      () => updateUserPlatformRole(deps, 'founder-1', 'ghost', 'ADMIN'),
      (error: unknown) => error instanceof AdminError && error.code === 'USER_NOT_FOUND',
    );
  });

  it('blocks demoting the last remaining Founder', async () => {
    const { deps } = buildDeps({ users: [fakeUser('founder-1', 'FOUNDER')], founderCount: 1 });
    await assert.rejects(
      () => updateUserPlatformRole(deps, 'founder-1', 'founder-1', 'ADMIN'),
      (error: unknown) => error instanceof AdminError && error.code === 'CANNOT_DEMOTE_LAST_FOUNDER',
    );
  });

  it('allows demoting a Founder when another Founder still exists', async () => {
    const { deps, updateCalls } = buildDeps({ users: [fakeUser('founder-1', 'FOUNDER'), fakeUser('founder-2', 'FOUNDER')], founderCount: 2 });
    await updateUserPlatformRole(deps, 'founder-1', 'founder-1', 'ADMIN');
    assert.deepEqual(updateCalls, [{ id: 'founder-1', role: 'ADMIN' }]);
  });

  it('allows a Founder to promote someone else to Founder without the last-Founder check applying', async () => {
    const { deps, updateCalls } = buildDeps({ users: [fakeUser('founder-1', 'FOUNDER'), fakeUser('target-1')], founderCount: 1 });
    await updateUserPlatformRole(deps, 'founder-1', 'target-1', 'FOUNDER');
    assert.deepEqual(updateCalls, [{ id: 'target-1', role: 'FOUNDER' }]);
  });
});

describe('searchUsersForAdmin', () => {
  it('with no filters, returns every user (same as listUsersForAdmin) plus their personal-org plan', async () => {
    const { deps } = buildDeps({
      users: [fakeUser('a'), fakeUser('b', 'ADMIN')],
      personalOrgByUser: { a: 'org-a', b: 'org-b' },
      plans: { 'org-a': 'FREE', 'org-b': 'TEAM' },
    });
    const users = await searchUsersForAdmin(deps);
    assert.equal(users.length, 2);
    assert.equal(users.find((u) => u.id === 'a')?.plan, 'FREE');
    assert.equal(users.find((u) => u.id === 'b')?.plan, 'TEAM');
  });

  it('filters by role', async () => {
    const { deps } = buildDeps({ users: [fakeUser('a', 'USER'), fakeUser('b', 'ADMIN')] });
    const users = await searchUsersForAdmin(deps, { role: 'ADMIN' });
    assert.deepEqual(users.map((u) => u.id), ['b']);
  });

  it('filters by plan', async () => {
    const { deps } = buildDeps({
      users: [fakeUser('a'), fakeUser('b')],
      personalOrgByUser: { a: 'org-a', b: 'org-b' },
      plans: { 'org-a': 'FREE', 'org-b': 'TEAM' },
    });
    const users = await searchUsersForAdmin(deps, { plan: 'TEAM' });
    assert.deepEqual(users.map((u) => u.id), ['b']);
  });

  it('filters by case-insensitive email/name search', async () => {
    const { deps } = buildDeps({ users: [fakeUser('alice'), fakeUser('bob')] });
    const users = await searchUsersForAdmin(deps, { search: 'ALICE' });
    assert.deepEqual(users.map((u) => u.id), ['alice']);
  });
});

describe('getUserDetailForAdmin', () => {
  it('returns the full detail shape: workspaces, plan, usage, last-active', async () => {
    const { deps } = buildDeps({
      users: [fakeUser('a')],
      personalOrgByUser: { a: 'org-a' },
      organizations: { 'org-a': { id: 'org-a', name: 'Alice workspace' } },
      membershipRoles: { a: 'OWNER' },
      plans: { 'org-a': 'PRO' },
      usageToday: [{ metric: 'INSPECTION', count: 3, limit: 50 }],
      lastActiveAt: '2026-01-01T00:00:00.000Z',
    });

    const detail = await getUserDetailForAdmin(deps, 'a');
    assert.equal(detail.id, 'a');
    assert.equal(detail.subscriptionPlan, 'PRO');
    assert.equal(detail.lastActiveAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(detail.workspaces, [{ organizationId: 'org-a', organizationName: 'Alice workspace', role: 'OWNER' }]);
    assert.deepEqual(detail.usageToday, [{ metric: 'INSPECTION', count: 3, limit: 50 }]);
  });

  it('never includes a password hash, OAuth tokens, or any credential field', async () => {
    const { deps } = buildDeps({ users: [fakeUser('a')], personalOrgByUser: { a: 'org-a' } });
    const detail = await getUserDetailForAdmin(deps, 'a');
    const forbidden = ['passwordHash', 'password_hash', 'accessToken', 'refreshToken', 'oauthToken', 'stripeSecretKey', 'apiKey'];
    for (const key of forbidden) {
      assert.equal(Object.prototype.hasOwnProperty.call(detail, key), false, `must never expose ${key}`);
    }
  });

  it('rejects for a nonexistent user', async () => {
    const { deps } = buildDeps({ users: [] });
    await assert.rejects(
      () => getUserDetailForAdmin(deps, 'ghost'),
      (error: unknown) => error instanceof AdminError && error.code === 'USER_NOT_FOUND',
    );
  });
});
