import '../load-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool, isDatabaseEnabled } from './pool.js';
import { UserRepository } from './user-repository.js';
import { ProviderConnectionRepository } from './provider-connection-repository.js';

const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

async function createFixtureUser(): Promise<string> {
  const userRepo = new UserRepository();
  const user = await userRepo.upsertByProviderAccount({
    id: randomUUID(), primaryProvider: 'GITHUB', primaryProviderAccountId: randomUUID(), primaryProviderLogin: 'octocat',
  });
  return user.id;
}

describeIfDb('ProviderConnectionRepository (migration 013, real Postgres)', () => {
  it('upsertGitHubInstallation creates a connection owned by the given user', async () => {
    const userId = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    const installationId = Math.floor(Math.random() * 1_000_000_000);

    const connection = await repo.upsertGitHubInstallation({ id: randomUUID(), userId, installationId, externalAccountLogin: 'octocat' });
    assert.equal(connection.userId, userId);
    assert.equal(connection.installationId, installationId);
    assert.equal(connection.status, 'ACTIVE');
  });

  it('a second upsert for the same installation_id reassigns ownership rather than duplicating', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    const installationId = Math.floor(Math.random() * 1_000_000_000);

    const first = await repo.upsertGitHubInstallation({ id: randomUUID(), userId: userA, installationId, externalAccountLogin: 'octocat' });
    const second = await repo.upsertGitHubInstallation({ id: randomUUID(), userId: userB, installationId, externalAccountLogin: 'octocat' });

    assert.equal(second.id, first.id, 'same installation_id must update the same row, not create a second one');
    assert.equal(second.userId, userB, 'ownership must move to whoever completed the latest real install/callback');

    const stillOwnedByA = await repo.findActiveForUserAndInstallation(userA, installationId);
    assert.equal(stillOwnedByA, undefined, 'the previous owner must no longer resolve credentials for this installation');
  });

  it('IDOR — findActiveForUserAndInstallation returns undefined for a real installation owned by a different user', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    const installationId = Math.floor(Math.random() * 1_000_000_000);
    await repo.upsertGitHubInstallation({ id: randomUUID(), userId: userA, installationId, externalAccountLogin: 'octocat' });

    assert.equal(await repo.findActiveForUserAndInstallation(userB, installationId), undefined);
    assert.ok(await repo.findActiveForUserAndInstallation(userA, installationId));
  });

  it('listForUser only ever returns that user\'s own connections', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    await repo.upsertGitHubInstallation({ id: randomUUID(), userId: userA, installationId: Math.floor(Math.random() * 1e9), externalAccountLogin: 'a-org' });
    await repo.upsertGitHubInstallation({ id: randomUUID(), userId: userB, installationId: Math.floor(Math.random() * 1e9), externalAccountLogin: 'b-org' });

    const listA = await repo.listForUser(userA);
    assert.equal(listA.length, 1);
    assert.equal(listA[0].externalAccountLogin, 'a-org');
  });

  it('revokeForUser only revokes when the caller actually owns the connection', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    const installationId = Math.floor(Math.random() * 1_000_000_000);
    const connection = await repo.upsertGitHubInstallation({ id: randomUUID(), userId: userA, installationId, externalAccountLogin: 'octocat' });

    const revokedByAttacker = await repo.revokeForUser(userB, connection.id);
    assert.equal(revokedByAttacker, false);
    assert.ok(await repo.findActiveForUserAndInstallation(userA, installationId), 'must remain ACTIVE after a non-owner\'s revoke attempt');

    const revokedByOwner = await repo.revokeForUser(userA, connection.id);
    assert.equal(revokedByOwner, true);
    assert.equal(await repo.findActiveForUserAndInstallation(userA, installationId), undefined);
  });

  it('deleting a user cascades to delete their provider connections', async () => {
    const userId = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    const installationId = Math.floor(Math.random() * 1_000_000_000);
    await repo.upsertGitHubInstallation({ id: randomUUID(), userId, installationId, externalAccountLogin: 'octocat' });

    const pool = getPool()!;
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    assert.equal((await repo.listForUser(userId)).length, 0);
  });

  it('Phase 16/D — upsertGitLabConnection creates a connection owned by the given user, storing only encrypted values', async () => {
    const userId = await createFixtureUser();
    const repo = new ProviderConnectionRepository();

    const connection = await repo.upsertGitLabConnection({
      id: randomUUID(), userId, externalAccountLogin: 'gl-octocat',
      encryptedAccessToken: 'encrypted-access-blob', encryptedRefreshToken: 'encrypted-refresh-blob',
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal(connection.userId, userId);
    assert.equal(connection.installationId, undefined, 'GitLab connections have no installation_id');
    assert.equal(connection.encryptedAccessToken, 'encrypted-access-blob');
    assert.equal(connection.status, 'ACTIVE');
  });

  it('a second upsertGitLabConnection for the same user updates the existing row rather than creating a second active connection', async () => {
    const userId = await createFixtureUser();
    const repo = new ProviderConnectionRepository();

    const first = await repo.upsertGitLabConnection({
      id: randomUUID(), userId, externalAccountLogin: 'gl-octocat',
      encryptedAccessToken: 'enc-access-1', encryptedRefreshToken: 'enc-refresh-1', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const second = await repo.upsertGitLabConnection({
      id: randomUUID(), userId, externalAccountLogin: 'gl-octocat',
      encryptedAccessToken: 'enc-access-2', encryptedRefreshToken: 'enc-refresh-2', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    assert.equal(second.id, first.id, 'reconnecting must update the same row, not duplicate it');
    assert.equal(second.encryptedAccessToken, 'enc-access-2');

    const all = await repo.listForUser(userId);
    assert.equal(all.filter((c) => c.provider === 'GITLAB').length, 1);
  });

  it('IDOR — findActiveGitLabConnectionForUser only ever resolves this exact user\'s own GitLab connection', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    await repo.upsertGitLabConnection({
      id: randomUUID(), userId: userA, externalAccountLogin: 'a-gitlab',
      encryptedAccessToken: 'enc-a', encryptedRefreshToken: 'enc-a-refresh', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    assert.equal(await repo.findActiveGitLabConnectionForUser(userB), undefined);
    const ownConnection = await repo.findActiveGitLabConnectionForUser(userA);
    assert.equal(ownConnection?.externalAccountLogin, 'a-gitlab');
  });

  it('updateGitLabTokens persists a rotated token pair on the correct connection', async () => {
    const userId = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    const connection = await repo.upsertGitLabConnection({
      id: randomUUID(), userId, externalAccountLogin: 'gl-octocat',
      encryptedAccessToken: 'enc-old', encryptedRefreshToken: 'enc-old-refresh', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const newExpiry = new Date(Date.now() + 7200_000).toISOString();
    await repo.updateGitLabTokens(connection.id, 'enc-new', 'enc-new-refresh', newExpiry);

    const updated = await repo.findActiveGitLabConnectionForUser(userId);
    assert.equal(updated?.encryptedAccessToken, 'enc-new');
    assert.equal(updated?.encryptedRefreshToken, 'enc-new-refresh');
  });

  it('revokeForUser also works for a GitLab connection, scoped to the real owner', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    const connection = await repo.upsertGitLabConnection({
      id: randomUUID(), userId: userA, externalAccountLogin: 'a-gitlab',
      encryptedAccessToken: 'enc-a', encryptedRefreshToken: 'enc-a-refresh', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    assert.equal(await repo.revokeForUser(userB, connection.id), false);
    assert.ok(await repo.findActiveGitLabConnectionForUser(userA));

    assert.equal(await repo.revokeForUser(userA, connection.id), true);
    assert.equal(await repo.findActiveGitLabConnectionForUser(userA), undefined);
  });

  it('Phase 16/E — upsertBitbucketConnection creates a connection owned by the given user, storing only encrypted values', async () => {
    const userId = await createFixtureUser();
    const repo = new ProviderConnectionRepository();

    const connection = await repo.upsertBitbucketConnection({
      id: randomUUID(), userId, externalAccountLogin: 'bb-octocat',
      encryptedAccessToken: 'encrypted-access-blob', encryptedRefreshToken: 'encrypted-refresh-blob',
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal(connection.userId, userId);
    assert.equal(connection.installationId, undefined, 'Bitbucket connections have no installation_id');
    assert.equal(connection.encryptedAccessToken, 'encrypted-access-blob');
    assert.equal(connection.status, 'ACTIVE');
  });

  it('a second upsertBitbucketConnection for the same user updates the existing row rather than creating a second active connection', async () => {
    const userId = await createFixtureUser();
    const repo = new ProviderConnectionRepository();

    const first = await repo.upsertBitbucketConnection({
      id: randomUUID(), userId, externalAccountLogin: 'bb-octocat',
      encryptedAccessToken: 'enc-access-1', encryptedRefreshToken: 'enc-refresh-1', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const second = await repo.upsertBitbucketConnection({
      id: randomUUID(), userId, externalAccountLogin: 'bb-octocat',
      encryptedAccessToken: 'enc-access-2', encryptedRefreshToken: 'enc-refresh-2', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    assert.equal(second.id, first.id, 'reconnecting must update the same row, not duplicate it');
    assert.equal(second.encryptedAccessToken, 'enc-access-2');

    const all = await repo.listForUser(userId);
    assert.equal(all.filter((c) => c.provider === 'BITBUCKET').length, 1);
  });

  it('IDOR — findActiveBitbucketConnectionForUser only ever resolves this exact user\'s own Bitbucket connection', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    await repo.upsertBitbucketConnection({
      id: randomUUID(), userId: userA, externalAccountLogin: 'a-bitbucket',
      encryptedAccessToken: 'enc-a', encryptedRefreshToken: 'enc-a-refresh', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    assert.equal(await repo.findActiveBitbucketConnectionForUser(userB), undefined);
    const ownConnection = await repo.findActiveBitbucketConnectionForUser(userA);
    assert.equal(ownConnection?.externalAccountLogin, 'a-bitbucket');
  });

  it('updateBitbucketTokens persists a token pair on the correct connection', async () => {
    const userId = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    const connection = await repo.upsertBitbucketConnection({
      id: randomUUID(), userId, externalAccountLogin: 'bb-octocat',
      encryptedAccessToken: 'enc-old', encryptedRefreshToken: 'enc-old-refresh', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const newExpiry = new Date(Date.now() + 7200_000).toISOString();
    await repo.updateBitbucketTokens(connection.id, 'enc-new', 'enc-new-refresh', newExpiry);

    const updated = await repo.findActiveBitbucketConnectionForUser(userId);
    assert.equal(updated?.encryptedAccessToken, 'enc-new');
    assert.equal(updated?.encryptedRefreshToken, 'enc-new-refresh');
  });

  it('revokeForUser also works for a Bitbucket connection, scoped to the real owner', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const repo = new ProviderConnectionRepository();
    const connection = await repo.upsertBitbucketConnection({
      id: randomUUID(), userId: userA, externalAccountLogin: 'a-bitbucket',
      encryptedAccessToken: 'enc-a', encryptedRefreshToken: 'enc-a-refresh', tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    assert.equal(await repo.revokeForUser(userB, connection.id), false);
    assert.ok(await repo.findActiveBitbucketConnectionForUser(userA));

    assert.equal(await repo.revokeForUser(userA, connection.id), true);
    assert.equal(await repo.findActiveBitbucketConnectionForUser(userA), undefined);
  });
});

describe('ProviderConnectionRepository.isEnabled()', () => {
  it('reflects DATABASE_URL configuration', () => {
    const repo = new ProviderConnectionRepository();
    assert.equal(repo.isEnabled(), isDatabaseEnabled());
  });
});
