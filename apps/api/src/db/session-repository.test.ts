import '../load-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool, isDatabaseEnabled } from './pool.js';
import { UserRepository } from './user-repository.js';
import { SessionRepository } from './session-repository.js';

const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

async function createFixtureUser(): Promise<string> {
  const userRepo = new UserRepository();
  const user = await userRepo.upsertByProviderAccount({
    id: randomUUID(),
    primaryProvider: 'GITHUB',
    primaryProviderAccountId: randomUUID(),
    primaryProviderLogin: 'octocat',
  });
  return user.id;
}

describeIfDb('SessionRepository (migration 011, real Postgres)', () => {
  it('creates a session and resolves it back with its user via getValidByIdAndTouch', async () => {
    const userId = await createFixtureUser();
    const sessionRepo = new SessionRepository();
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await sessionRepo.create({ id: sessionId, userId, expiresAt });

    const resolved = await sessionRepo.getValidByIdAndTouch(sessionId);
    assert.equal(resolved?.sessionId, sessionId);
    assert.equal(resolved?.user.id, userId);
  });

  it('returns undefined for an expired session (never treats it as valid)', async () => {
    const userId = await createFixtureUser();
    const sessionRepo = new SessionRepository();
    const sessionId = randomUUID();
    const alreadyExpired = new Date(Date.now() - 60_000).toISOString();

    await sessionRepo.create({ id: sessionId, userId, expiresAt: alreadyExpired });

    const resolved = await sessionRepo.getValidByIdAndTouch(sessionId);
    assert.equal(resolved, undefined);
  });

  it('returns undefined for an unknown session id', async () => {
    const sessionRepo = new SessionRepository();
    const resolved = await sessionRepo.getValidByIdAndTouch(randomUUID());
    assert.equal(resolved, undefined);
  });

  it('deleteById removes the session — a subsequent lookup finds nothing (real logout/revocation)', async () => {
    const userId = await createFixtureUser();
    const sessionRepo = new SessionRepository();
    const sessionId = randomUUID();
    await sessionRepo.create({ id: sessionId, userId, expiresAt: new Date(Date.now() + 60_000).toISOString() });

    await sessionRepo.deleteById(sessionId);

    const resolved = await sessionRepo.getValidByIdAndTouch(sessionId);
    assert.equal(resolved, undefined);
  });

  it('deleting a user cascades to delete their sessions', async () => {
    const userId = await createFixtureUser();
    const sessionRepo = new SessionRepository();
    const sessionId = randomUUID();
    await sessionRepo.create({ id: sessionId, userId, expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const pool = getPool()!;
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    const resolved = await sessionRepo.getValidByIdAndTouch(sessionId);
    assert.equal(resolved, undefined);
  });

  it('deleteExpired removes only expired rows and reports how many were removed', async () => {
    const userId = await createFixtureUser();
    const sessionRepo = new SessionRepository();
    const expiredId = randomUUID();
    const validId = randomUUID();
    await sessionRepo.create({ id: expiredId, userId, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await sessionRepo.create({ id: validId, userId, expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const removed = await sessionRepo.deleteExpired();
    assert.ok(removed >= 1);

    assert.equal(await sessionRepo.getValidByIdAndTouch(expiredId), undefined);
    assert.ok(await sessionRepo.getValidByIdAndTouch(validId));
  });
});

describe('SessionRepository.isEnabled()', () => {
  it('reflects DATABASE_URL configuration', () => {
    const repo = new SessionRepository();
    assert.equal(repo.isEnabled(), isDatabaseEnabled());
  });
});
