import '../load-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { getPool, isDatabaseEnabled } from './pool.js';
import { UserRepository } from './user-repository.js';
import { OrganizationRepository } from './organization-repository.js';
import { WorkspaceInvitationRepository } from './workspace-invitation-repository.js';

const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

async function createRealUser(login: string) {
  const userRepo = new UserRepository();
  return userRepo.upsertByProviderAccount({
    id: randomUUID(),
    primaryProvider: 'GITHUB',
    primaryProviderAccountId: randomUUID(),
    primaryProviderLogin: login,
    email: `${login}@example.com`,
    displayName: login,
  });
}

function hashOf(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** A fresh, unique raw token per call — tests must never reuse a literal token string, since token_hash is globally unique and this suite's rows persist across runs against a real database. */
function uniqueToken(): string {
  return randomUUID();
}

describeIfDb('WorkspaceInvitationRepository (migration 030, real Postgres)', () => {
  it('create() persists a PENDING invitation, findable by org+email', async () => {
    const owner = await createRealUser(`inv-create-owner-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const invitation = await repo.create({
      id: randomUUID(),
      organizationId: org.id,
      invitedEmail: 'invitee@example.com',
      invitedByUserId: owner.id,
      role: 'MEMBER',
      tokenHash: hashOf(uniqueToken()),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    assert.equal(invitation.status, 'PENDING');
    const found = await repo.findPendingByOrgAndEmail(org.id, 'invitee@example.com');
    assert.equal(found?.id, invitation.id);
  });

  it('the partial unique index rejects a second PENDING invitation for the same org/email', async () => {
    const owner = await createRealUser(`inv-unique-owner-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();
    const email = 'dup-invitee@example.com';

    await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: email, invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(uniqueToken()), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    await assert.rejects(() =>
      repo.create({
        id: randomUUID(), organizationId: org.id, invitedEmail: email, invitedByUserId: owner.id,
        role: 'VIEWER', tokenHash: hashOf(uniqueToken()), expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    );
  });

  it('revoke() sets status REVOKED and it no longer counts as the pending invitation', async () => {
    const owner = await createRealUser(`inv-revoke-owner-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const invitation = await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: 'revoke-me@example.com', invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(uniqueToken()), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    await repo.revoke(invitation.id);
    const found = await repo.findPendingByOrgAndEmail(org.id, 'revoke-me@example.com');
    assert.equal(found, undefined);
  });

  it('findById() is scoped to the organization — a wrong org id finds nothing (existence-hiding)', async () => {
    const owner = await createRealUser(`inv-scope-owner-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const invitation = await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: 'scoped@example.com', invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(uniqueToken()), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    assert.ok(await repo.findById(org.id, invitation.id));
    assert.equal(await repo.findById(randomUUID(), invitation.id), undefined);
  });

  it('rotateToken() changes the token hash and expiry on the same row', async () => {
    const owner = await createRealUser(`inv-rotate-owner-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const oldToken = uniqueToken();
    const newToken = uniqueToken();
    const invitation = await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: 'rotate@example.com', invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(oldToken), expiresAt: new Date(Date.now() + 1000).toISOString(),
    });

    const newExpiry = new Date(Date.now() + 999999999).toISOString();
    const rotated = await repo.rotateToken(invitation.id, hashOf(newToken), newExpiry);
    assert.equal(rotated?.expiresAt, newExpiry);

    const previewOld = await repo.findPreviewByTokenHash(hashOf(oldToken));
    assert.equal(previewOld, undefined);
    const previewNew = await repo.findPreviewByTokenHash(hashOf(newToken));
    assert.equal(previewNew?.invitedEmail, 'rotate@example.com');
  });

  it('findPreviewByTokenHash opportunistically flips an expired PENDING row to EXPIRED', async () => {
    const owner = await createRealUser(`inv-expire-owner-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const token = uniqueToken();
    await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: 'already-expired@example.com', invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(token), expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const preview = await repo.findPreviewByTokenHash(hashOf(token));
    assert.equal(preview?.status, 'EXPIRED');
  });

  it('acceptByTokenHash() creates membership, marks ACCEPTED, and sets the user\'s active organization', async () => {
    const owner = await createRealUser(`inv-accept-owner-${randomUUID()}`);
    const invitee = await createRealUser(`inv-accept-invitee-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const token = uniqueToken();
    await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: invitee.email!, invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(token), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const result = await repo.acceptByTokenHash(hashOf(token), invitee.id, invitee.email!);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.organizationId, org.id);
      assert.equal(result.role, 'MEMBER');
    }

    assert.equal(await orgRepo.getMembershipRole(org.id, invitee.id), 'MEMBER');

    const pool = getPool()!;
    const userRow = await pool.query(`SELECT active_organization_id FROM users WHERE id = $1`, [invitee.id]);
    assert.equal(userRow.rows[0].active_organization_id, org.id);
  });

  it('acceptByTokenHash() rejects a mismatched email without mutating anything', async () => {
    const owner = await createRealUser(`inv-mismatch-owner-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const token = uniqueToken();
    await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: 'correct@example.com', invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(token), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const result = await repo.acceptByTokenHash(hashOf(token), randomUUID(), 'wrong@example.com');
    assert.deepEqual(result, { ok: false, reason: 'EMAIL_MISMATCH' });

    const preview = await repo.findPreviewByTokenHash(hashOf(token));
    assert.equal(preview?.status, 'PENDING');
  });

  it('acceptByTokenHash() rejects an expired invitation', async () => {
    const owner = await createRealUser(`inv-expacc-owner-${randomUUID()}`);
    const invitee = await createRealUser(`inv-expacc-invitee-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const token = uniqueToken();
    await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: invitee.email!, invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(token), expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const result = await repo.acceptByTokenHash(hashOf(token), invitee.id, invitee.email!);
    assert.deepEqual(result, { ok: false, reason: 'EXPIRED' });
  });

  it('acceptByTokenHash() rejects a revoked invitation', async () => {
    const owner = await createRealUser(`inv-revacc-owner-${randomUUID()}`);
    const invitee = await createRealUser(`inv-revacc-invitee-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const token = uniqueToken();
    const invitation = await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: invitee.email!, invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(token), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    await repo.revoke(invitation.id);

    const result = await repo.acceptByTokenHash(hashOf(token), invitee.id, invitee.email!);
    assert.deepEqual(result, { ok: false, reason: 'REVOKED' });
  });

  it('acceptByTokenHash() rejects an unknown token', async () => {
    const repo = new WorkspaceInvitationRepository();
    const result = await repo.acceptByTokenHash(hashOf(uniqueToken()), randomUUID(), 'nobody@example.com');
    assert.deepEqual(result, { ok: false, reason: 'NOT_FOUND' });
  });

  it('concurrent acceptance of the same invitation: exactly one wins, the other sees ALREADY_ACCEPTED', async () => {
    const owner = await createRealUser(`inv-race-owner-${randomUUID()}`);
    const invitee = await createRealUser(`inv-race-invitee-${randomUUID()}`);
    const orgRepo = new OrganizationRepository();
    const org = await orgRepo.getOrCreatePersonalOrganization(owner.id, owner.displayName!);
    const repo = new WorkspaceInvitationRepository();

    const token = uniqueToken();
    await repo.create({
      id: randomUUID(), organizationId: org.id, invitedEmail: invitee.email!, invitedByUserId: owner.id,
      role: 'MEMBER', tokenHash: hashOf(token), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const [first, second] = await Promise.all([
      repo.acceptByTokenHash(hashOf(token), invitee.id, invitee.email!),
      repo.acceptByTokenHash(hashOf(token), invitee.id, invitee.email!),
    ]);

    const outcomes = [first, second];
    const wins = outcomes.filter((r) => r.ok);
    const losses = outcomes.filter((r) => !r.ok);
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.deepEqual(losses[0], { ok: false, reason: 'ALREADY_ACCEPTED' });

    assert.equal(await orgRepo.getMembershipRole(org.id, invitee.id), 'MEMBER');
  });
});

describe('WorkspaceInvitationRepository.isEnabled()', () => {
  it('reflects DATABASE_URL configuration', () => {
    const repo = new WorkspaceInvitationRepository();
    assert.equal(repo.isEnabled(), isDatabaseEnabled());
  });
});
