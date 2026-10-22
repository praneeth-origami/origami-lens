import '../load-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool, isDatabaseEnabled } from './pool.js';
import { UserRepository } from './user-repository.js';
import { OrganizationRepository } from './organization-repository.js';

/** Requires a real Postgres instance (migration 015) — skips rather than fails when DATABASE_URL isn't configured, matching this project's convention (see user-repository.test.ts). */
const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

async function createRealUser(login: string) {
  const userRepo = new UserRepository();
  return userRepo.upsertByProviderAccount({
    id: randomUUID(),
    primaryProvider: 'GITHUB',
    primaryProviderAccountId: randomUUID(),
    primaryProviderLogin: login,
    displayName: login,
  });
}

describeIfDb('OrganizationRepository (migration 015, real Postgres)', () => {
  it('getOrCreatePersonalOrganization creates a personal org + OWNER membership for a brand-new user', async () => {
    const user = await createRealUser('octocat');
    const orgRepo = new OrganizationRepository();

    const organization = await orgRepo.getOrCreatePersonalOrganization(user.id, 'octocat');

    assert.equal(organization.personalOwnerUserId, user.id);
    assert.equal(organization.name, 'octocat workspace');

    const pool = getPool()!;
    const membership = await pool.query(
      `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
      [organization.id, user.id],
    );
    assert.equal(membership.rows.length, 1);
    assert.equal(membership.rows[0].role, 'OWNER');
  });

  it('getOrCreatePersonalOrganization is idempotent: a second call for the same user returns the same organization, not a second one', async () => {
    const user = await createRealUser('idempotent-user');
    const orgRepo = new OrganizationRepository();

    const first = await orgRepo.getOrCreatePersonalOrganization(user.id, 'idempotent-user');
    const second = await orgRepo.getOrCreatePersonalOrganization(user.id, 'idempotent-user');

    assert.equal(second.id, first.id);

    const pool = getPool()!;
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM organizations WHERE personal_owner_user_id = $1`, [user.id]);
    assert.equal(count.rows[0].count, 1);
  });

  it('getPersonalOrganization returns undefined for a user with no personal organization yet', async () => {
    const user = await createRealUser('no-org-yet');
    const orgRepo = new OrganizationRepository();

    const found = await orgRepo.getPersonalOrganization(user.id);
    assert.equal(found, undefined);
  });

  it('getOrganizationIdsForUser returns the user\'s personal organization id once created, and only that user\'s', async () => {
    const userA = await createRealUser('user-a');
    const userB = await createRealUser('user-b');
    const orgRepo = new OrganizationRepository();

    const orgA = await orgRepo.getOrCreatePersonalOrganization(userA.id, 'user-a');
    await orgRepo.getOrCreatePersonalOrganization(userB.id, 'user-b');

    const idsForA = await orgRepo.getOrganizationIdsForUser(userA.id);
    assert.deepEqual(idsForA, [orgA.id]);
  });

  it('two different users never share a personal organization', async () => {
    const userA = await createRealUser('distinct-a');
    const userB = await createRealUser('distinct-b');
    const orgRepo = new OrganizationRepository();

    const orgA = await orgRepo.getOrCreatePersonalOrganization(userA.id, 'distinct-a');
    const orgB = await orgRepo.getOrCreatePersonalOrganization(userB.id, 'distinct-b');

    assert.notEqual(orgA.id, orgB.id);
  });
});

describeIfDb('OrganizationRepository — Phase 18 membership management (real Postgres)', () => {
  it('getMembershipRole returns undefined for a non-member, and the real role once added', async () => {
    const owner = await createRealUser('member-mgmt-owner');
    const outsider = await createRealUser('member-mgmt-outsider');
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, 'member-mgmt-owner');

    assert.equal(await orgRepo.getMembershipRole(org.id, outsider.id), undefined);

    await orgRepo.addMember(org.id, outsider.id, 'MEMBER');
    assert.equal(await orgRepo.getMembershipRole(org.id, outsider.id), 'MEMBER');
  });

  it('listMembers returns every member joined with their user info, ordered by join time', async () => {
    const owner = await createRealUser('list-members-owner');
    const member = await createRealUser('list-members-member');
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, 'list-members-owner');
    await orgRepo.addMember(org.id, member.id, 'VIEWER');

    const members = await orgRepo.listMembers(org.id);
    assert.equal(members.length, 2);
    assert.equal(members[0].userId, owner.id);
    assert.equal(members[0].role, 'OWNER');
    assert.equal(members[1].userId, member.id);
    assert.equal(members[1].role, 'VIEWER');
  });

  it('addMember rejects a duplicate (organizationId, userId) pair via the unique constraint', async () => {
    const owner = await createRealUser('dup-member-owner');
    const member = await createRealUser('dup-member-member');
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, 'dup-member-owner');
    await orgRepo.addMember(org.id, member.id, 'MEMBER');

    await assert.rejects(() => orgRepo.addMember(org.id, member.id, 'ADMIN'));
  });

  it('removeMember removes exactly that membership', async () => {
    const owner = await createRealUser('remove-member-owner');
    const member = await createRealUser('remove-member-member');
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, 'remove-member-owner');
    await orgRepo.addMember(org.id, member.id, 'MEMBER');

    await orgRepo.removeMember(org.id, member.id);
    assert.equal(await orgRepo.getMembershipRole(org.id, member.id), undefined);
    assert.equal(await orgRepo.getMembershipRole(org.id, owner.id), 'OWNER');
  });

  it('updateMemberRole changes only the targeted membership', async () => {
    const owner = await createRealUser('update-role-owner');
    const member = await createRealUser('update-role-member');
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, 'update-role-owner');
    await orgRepo.addMember(org.id, member.id, 'VIEWER');

    await orgRepo.updateMemberRole(org.id, member.id, 'ADMIN');
    assert.equal(await orgRepo.getMembershipRole(org.id, member.id), 'ADMIN');
    assert.equal(await orgRepo.getMembershipRole(org.id, owner.id), 'OWNER');
  });

  it('countMembersByRole counts correctly', async () => {
    const owner = await createRealUser('count-role-owner');
    const memberA = await createRealUser('count-role-a');
    const memberB = await createRealUser('count-role-b');
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, 'count-role-owner');
    await orgRepo.addMember(org.id, memberA.id, 'ADMIN');
    await orgRepo.addMember(org.id, memberB.id, 'ADMIN');

    assert.equal(await orgRepo.countMembersByRole(org.id, 'OWNER'), 1);
    assert.equal(await orgRepo.countMembersByRole(org.id, 'ADMIN'), 2);
    assert.equal(await orgRepo.countMembersByRole(org.id, 'VIEWER'), 0);
  });

  it('transferOwnership atomically swaps OWNER: old owner becomes ADMIN, new owner becomes OWNER', async () => {
    const owner = await createRealUser('transfer-owner');
    const member = await createRealUser('transfer-member');
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, 'transfer-owner');
    await orgRepo.addMember(org.id, member.id, 'MEMBER');

    await orgRepo.transferOwnership(org.id, owner.id, member.id);

    assert.equal(await orgRepo.getMembershipRole(org.id, member.id), 'OWNER');
    assert.equal(await orgRepo.getMembershipRole(org.id, owner.id), 'ADMIN');
    assert.equal(await orgRepo.countMembersByRole(org.id, 'OWNER'), 1);
  });

  it('listAllForAdmin includes the organization with its owner email', async () => {
    const owner = await createRealUser('admin-list-owner');
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, 'admin-list-owner');

    const all = await orgRepo.listAllForAdmin();
    const found = all.find((o) => o.id === org.id);
    assert.ok(found);
    assert.equal(found?.name, org.name);
  });

  it('countInternalMembers excludes CLIENT_VIEWER but countMembers includes everyone (Agency bugfix: client viewers never consume an internal seat)', async () => {
    const owner = await createRealUser('seat-count-owner');
    const internalMember = await createRealUser('seat-count-internal');
    const clientViewer = await createRealUser('seat-count-client-viewer');
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, 'seat-count-owner');
    await orgRepo.addMember(org.id, internalMember.id, 'MEMBER');
    await orgRepo.addMember(org.id, clientViewer.id, 'CLIENT_VIEWER');

    assert.equal(await orgRepo.countMembers(org.id), 3);
    assert.equal(await orgRepo.countInternalMembers(org.id), 2);
  });

  it('createClientWorkspace (Agency plan) creates a NEW, non-personal organization owned by the creator, linked to the agency', async () => {
    const agencyOwner = await createRealUser('client-ws-agency-owner');
    const orgRepo = new OrganizationRepository();
    const agencyOrg = await orgRepo.getOrCreatePersonalOrganization(agencyOwner.id, 'client-ws-agency-owner');

    const client = await orgRepo.createClientWorkspace(agencyOrg.id, agencyOwner.id, 'Acme Client');

    assert.equal(client.name, 'Acme Client');
    assert.equal(client.parentOrganizationId, agencyOrg.id);
    assert.notEqual(client.id, agencyOrg.id);
    assert.equal(await orgRepo.getMembershipRole(client.id, agencyOwner.id), 'OWNER');
  });

  it('listClientWorkspacesForAgency lists only THIS agency\'s own client workspaces, with a live member count', async () => {
    const agencyOwner = await createRealUser('client-ws-list-owner');
    const otherAgencyOwner = await createRealUser('client-ws-other-agency-owner');
    const orgRepo = new OrganizationRepository();
    const agencyOrg = await orgRepo.getOrCreatePersonalOrganization(agencyOwner.id, 'client-ws-list-owner');
    const otherAgencyOrg = await orgRepo.getOrCreatePersonalOrganization(otherAgencyOwner.id, 'client-ws-other-agency-owner');

    const clientA = await orgRepo.createClientWorkspace(agencyOrg.id, agencyOwner.id, 'Client A');
    await orgRepo.createClientWorkspace(otherAgencyOrg.id, otherAgencyOwner.id, 'Someone Else\'s Client');

    const staffer = await createRealUser('client-ws-list-staffer');
    await orgRepo.addMember(clientA.id, staffer.id, 'ADMIN');

    const clients = await orgRepo.listClientWorkspacesForAgency(agencyOrg.id);
    assert.equal(clients.length, 1);
    assert.equal(clients[0].organizationId, clientA.id);
    assert.equal(clients[0].name, 'Client A');
    assert.equal(clients[0].memberCount, 2); // the agency owner (OWNER) + the invited staffer (ADMIN)
  });

  it('isClientWorkspaceOfAgency correctly distinguishes a real parent/child relationship from an unrelated organization', async () => {
    const agencyOwner = await createRealUser('client-ws-check-owner');
    const unrelatedOwner = await createRealUser('client-ws-check-unrelated');
    const orgRepo = new OrganizationRepository();
    const agencyOrg = await orgRepo.getOrCreatePersonalOrganization(agencyOwner.id, 'client-ws-check-owner');
    const unrelatedOrg = await orgRepo.getOrCreatePersonalOrganization(unrelatedOwner.id, 'client-ws-check-unrelated');
    const client = await orgRepo.createClientWorkspace(agencyOrg.id, agencyOwner.id, 'Real Client');

    assert.equal(await orgRepo.isClientWorkspaceOfAgency(client.id, agencyOrg.id), true);
    assert.equal(await orgRepo.isClientWorkspaceOfAgency(client.id, unrelatedOrg.id), false);
    assert.equal(await orgRepo.isClientWorkspaceOfAgency(unrelatedOrg.id, agencyOrg.id), false);
  });
});

describe('OrganizationRepository.isEnabled()', () => {
  it('reflects DATABASE_URL configuration', () => {
    const repo = new OrganizationRepository();
    assert.equal(repo.isEnabled(), isDatabaseEnabled());
  });
});
