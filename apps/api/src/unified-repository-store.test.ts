import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolated, disposable data dir per test run so this never touches the
// developer's real .origami-data — mirrors the pattern already established
// for the component-generation-worker tests. Set before the first import so
// repository-store.ts's own module-level DATA_DIR picks it up. DATABASE_URL
// is also forced off so these tests exercise the always-available legacy
// store deterministically, the same way the existing worker tests do.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-repo-store-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';
const DATA_FILE = path.join(DATA_DIR, 'repositories.json');

const { UnifiedRepositoryStore, DuplicateRepositoryError } = await import('./unified-repository-store.js');

/**
 * Phase 16/B — every repository is created with a real `userId` (the
 * authenticated owner) rather than the legacy client-supplied `ownerId`.
 * `ownerId` still exists on the Repository shape (migration 012 keeps it,
 * untouched, for historical rows) but `.create()` no longer accepts it and
 * no code path here ever populates it — see repository-service.ts's
 * canAccessRepository and migration 012's comments for why.
 */
describe('UnifiedRepositoryStore (Phase 16/B — real user ownership)', () => {
  let store: InstanceType<typeof UnifiedRepositoryStore>;

  // The legacy store reloads whatever is on disk at DATA_FILE on every
  // `new UnifiedRepositoryStore()` — wipe it before each test so state from
  // one test never leaks into the next (DATA_DIR itself is fixed for the
  // whole module, since repository-store.ts reads it once at import time).
  beforeEach(() => {
    if (fs.existsSync(DATA_FILE)) fs.rmSync(DATA_FILE);
    store = new UnifiedRepositoryStore();
  });

  it('TEST 11 — creates a repository with CONNECTED status, timestamps, and the real userId', async () => {
    const userId = randomUUID();
    const repo = await store.create({ id: randomUUID(), userId, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });
    assert.equal(repo.status, 'CONNECTED');
    assert.equal(repo.provider, 'GITHUB');
    assert.equal(repo.branch, 'main');
    assert.equal(repo.userId, userId);
    assert.equal(repo.ownerId, undefined, 'the legacy ownerId field must never be populated by a real, authenticated creation');
    assert.ok(repo.createdAt);
    assert.ok(repo.updatedAt);
  });

  it('TEST 12 — listForUserAsync lists a user\'s repositories, newest first', async () => {
    const userId = randomUUID();
    const first = await store.create({ id: randomUUID(), userId, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.create({ id: randomUUID(), userId, repoUrl: 'https://gitlab.com/gitlab-org/gitlab', provider: 'GITLAB', branch: 'main' });

    const list = await store.listForUserAsync(userId);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, second.id);
    assert.equal(list[1].id, first.id);
  });

  it('TEST 13 — fetches one repository by id (unfiltered lookup)', async () => {
    const created = await store.create({ id: randomUUID(), userId: randomUUID(), repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });
    const fetched = await store.getByIdAsync(created.id);
    assert.deepEqual(fetched, created);
  });

  it('TEST 14 — an unknown repository id returns undefined (route maps this to 404)', async () => {
    const fetched = await store.getByIdAsync(randomUUID());
    assert.equal(fetched, undefined);
  });

  it('TEST 15 — user isolation: listForUserAsync for one user never returns another user\'s repositories', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    await store.create({ id: randomUUID(), userId: userA, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });
    await store.create({ id: randomUUID(), userId: userB, repoUrl: 'https://gitlab.com/gitlab-org/gitlab', provider: 'GITLAB', branch: 'main' });

    const userAList = await store.listForUserAsync(userA);
    assert.equal(userAList.length, 1);
    assert.equal(userAList[0].userId, userA);

    const userBList = await store.listForUserAsync(userB);
    assert.equal(userBList.length, 1);
    assert.equal(userBList[0].userId, userB);
  });

  it('IDOR — getByIdForUserAsync returns the repository for its real owner', async () => {
    const userId = randomUUID();
    const created = await store.create({ id: randomUUID(), userId, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });
    const fetched = await store.getByIdForUserAsync(created.id, userId);
    assert.equal(fetched?.id, created.id);
  });

  it('IDOR — getByIdForUserAsync returns undefined for a real repository UUID when asked by a different user', async () => {
    const ownerUserId = randomUUID();
    const attackerUserId = randomUUID();
    const created = await store.create({ id: randomUUID(), userId: ownerUserId, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });

    const fetchedByAttacker = await store.getByIdForUserAsync(created.id, attackerUserId);
    assert.equal(fetchedByAttacker, undefined, 'a repository must never be reachable by knowing its UUID alone');

    const fetchedByOwner = await store.getByIdForUserAsync(created.id, ownerUserId);
    assert.equal(fetchedByOwner?.id, created.id, 'the real owner must still be able to fetch it');
  });

  it('rejects creating the exact same user+repoUrl+branch twice', async () => {
    const userId = randomUUID();
    await store.create({ id: randomUUID(), userId, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });
    await assert.rejects(
      () => store.create({ id: randomUUID(), userId, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' }),
      DuplicateRepositoryError,
    );
  });

  it('allows the same repoUrl to be connected again on a different branch', async () => {
    const userId = randomUUID();
    await store.create({ id: randomUUID(), userId, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });
    const second = await store.create({ id: randomUUID(), userId, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'develop' });
    assert.equal(second.branch, 'develop');
  });

  it('allows two different users to independently connect the exact same repoUrl+branch (ownership, not the URL, is the unique key)', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const first = await store.create({ id: randomUUID(), userId: userA, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });
    const second = await store.create({ id: randomUUID(), userId: userB, repoUrl: 'https://github.com/facebook/react', provider: 'GITHUB', branch: 'main' });
    assert.notEqual(first.id, second.id);
  });
});
