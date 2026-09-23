import '../load-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool, isDatabaseEnabled } from './pool.js';
import { UserRepository } from './user-repository.js';

/** Requires a real Postgres instance (migration 011) — skips rather than fails when DATABASE_URL isn't configured, matching this project's convention (see repository-search-repository.test.ts). */
const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

describeIfDb('UserRepository (migration 011, real Postgres)', () => {
  it('creates a new user on first upsert, keyed by (provider, providerAccountId)', async () => {
    const repo = new UserRepository();
    const accountId = randomUUID();

    const user = await repo.upsertByProviderAccount({
      id: randomUUID(),
      primaryProvider: 'GITHUB',
      primaryProviderAccountId: accountId,
      primaryProviderLogin: 'octocat',
      email: 'octocat@example.com',
      displayName: 'The Octocat',
      avatarUrl: 'https://example.com/a.png',
    });

    assert.equal(user.primaryProvider, 'GITHUB');
    assert.equal(user.primaryProviderLogin, 'octocat');
    assert.equal(user.email, 'octocat@example.com');

    const fetched = await repo.getById(user.id);
    assert.equal(fetched?.id, user.id);
  });

  it('a second upsert for the same provider account updates display fields but keeps the same user id', async () => {
    const repo = new UserRepository();
    const accountId = randomUUID();

    const first = await repo.upsertByProviderAccount({
      id: randomUUID(),
      primaryProvider: 'GITHUB',
      primaryProviderAccountId: accountId,
      primaryProviderLogin: 'old-login',
      displayName: 'Old Name',
    });

    const second = await repo.upsertByProviderAccount({
      id: randomUUID(), // deliberately a DIFFERENT candidate id — must be ignored on conflict
      primaryProvider: 'GITHUB',
      primaryProviderAccountId: accountId,
      primaryProviderLogin: 'new-login',
      displayName: 'New Name',
    });

    assert.equal(second.id, first.id);
    assert.equal(second.primaryProviderLogin, 'new-login');
    assert.equal(second.displayName, 'New Name');

    const pool = getPool()!;
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE primary_provider_account_id = $1', [accountId]);
    assert.equal(count.rows[0].count, 1);
  });

  it('different providers with the same account id string are distinct users', async () => {
    const repo = new UserRepository();
    const accountId = randomUUID();

    const githubUser = await repo.upsertByProviderAccount({
      id: randomUUID(), primaryProvider: 'GITHUB', primaryProviderAccountId: accountId, primaryProviderLogin: 'gh-login',
    });
    const gitlabUser = await repo.upsertByProviderAccount({
      id: randomUUID(), primaryProvider: 'GITLAB', primaryProviderAccountId: accountId, primaryProviderLogin: 'gl-login',
    });

    assert.notEqual(githubUser.id, gitlabUser.id);
  });

  it('getById returns undefined for an unknown id', async () => {
    const repo = new UserRepository();
    const fetched = await repo.getById(randomUUID());
    assert.equal(fetched, undefined);
  });
});

describe('UserRepository.isEnabled()', () => {
  it('reflects DATABASE_URL configuration', () => {
    const repo = new UserRepository();
    assert.equal(repo.isEnabled(), isDatabaseEnabled());
  });
});
