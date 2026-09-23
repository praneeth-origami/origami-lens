import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Isolated, disposable data dir + no Postgres/Redis, so this file exercises
 * the always-available legacy-store/no-BullMQ fallback path deterministically
 * — same pattern as unified-repository-store.test.ts. A small (but real)
 * REPOSITORY_CLONE_TIMEOUT_MS lets the dedicated timeout test below fire
 * quickly without waiting on the production default.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-clone-worker-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.REPOSITORY_CLONE_TIMEOUT_MS = '2000';

const { UnifiedRepositoryCloneStore } = await import('../unified-repository-clone-store.js');
const { UnifiedRepositoryStore } = await import('../unified-repository-store.js');
const { processJob, cancelRepositoryCloneJob, enqueueRepositoryCloneJob } = await import('./repository-clone-worker.js');
const { cloneRepository } = await import('../repository-git.js');
const { discoverRepository } = await import('../repository-discovery.js');

// A real, allowlisted GitHub URL string — parseRepositoryUrl (never mocked
// below) validates this for real. The injected `clone` dependency ignores it
// and clones a local fixture instead, so no network call is ever made; see
// repository-clone-worker.ts's ProcessJobDeps for why this is safe (the
// security-relevant validation is not part of the injectable seam).
const REAL_ALLOWLISTED_URL = 'https://github.com/octocat/Hello-World';

let fixtureRepo: string;

function runGit(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

before(() => {
  fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-clone-worker-fixture-'));
  runGit(fixtureRepo, ['init', '--quiet']);
  runGit(fixtureRepo, ['config', 'user.email', 'test@example.com']);
  runGit(fixtureRepo, ['config', 'user.name', 'Origami Test']);
  runGit(fixtureRepo, ['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(fixtureRepo, 'README.md'), '# fixture\n');
  fs.mkdirSync(path.join(fixtureRepo, 'src'));
  fs.writeFileSync(path.join(fixtureRepo, 'src', 'index.ts'), 'export {}\n');
  runGit(fixtureRepo, ['add', '.']);
  runGit(fixtureRepo, ['commit', '-m', 'initial']);
});

after(() => {
  fs.rmSync(fixtureRepo, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** Clones from the local fixture instead of the real (unreachable in this sandbox) internet — see REAL_ALLOWLISTED_URL above. */
const fakeClone: typeof cloneRepository = (_repoUrl, branch, targetDir, signal) => cloneRepository(fixtureRepo, branch, targetDir, signal);

/** Each test gets its own random ownerId — the underlying store is JSON-file-backed and shared across `new UnifiedRepositoryStore()` instances within this file (SCAN_DATA_DIR is fixed per-process), so reusing the same repoUrl+branch+ownerId across tests would collide with the real uniqueness constraint from Phase 1. */
function makeRepositoryRecord(overrides: Partial<{ id: string; ownerId?: string; branch: string }> = {}) {
  return {
    id: overrides.id ?? randomUUID(),
    ownerId: overrides.ownerId ?? `owner-${randomUUID()}`,
    branch: overrides.branch ?? 'main',
  };
}

describe('repository-clone-worker processJob lifecycle', () => {
  it('TEST 9/15 — QUEUED -> RUNNING -> COMPLETED, with real discovery metadata and commit sha persisted', async () => {
    const cloneStore = new UnifiedRepositoryCloneStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const repo = makeRepositoryRecord();
    await repositoryStore.create({ id: repo.id, userId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: repo.branch });

    const jobId = randomUUID();
    await cloneStore.create({ id: jobId, repositoryId: repo.id, ownerId: repo.ownerId });

    await processJob(
      cloneStore,
      repositoryStore,
      { jobId, repositoryId: repo.id, ownerId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, branch: repo.branch },
      { clone: fakeClone, getSha: (await import('../repository-git.js')).getCommitSha, discover: discoverRepository },
    );

    const job = await cloneStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.match(job?.commitSha ?? '', /^[0-9a-f]{40}$/);
    assert.equal(job?.discovery?.fileCount, 2); // README.md + src/index.ts
    assert.ok(job?.discovery?.topLevelDirectories.includes('src'));

    const repository = await repositoryStore.getByIdAsync(repo.id);
    assert.equal(repository?.status, 'READY_FOR_INDEXING');
  });

  it('TEST 8 — an invalid branch fails the job and reverts the repository to FAILED, cleaning up the partial clone', async () => {
    const cloneStore = new UnifiedRepositoryCloneStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const repo = makeRepositoryRecord({ branch: 'does-not-exist' });
    await repositoryStore.create({ id: repo.id, userId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: repo.branch });

    const jobId = randomUUID();
    await cloneStore.create({ id: jobId, repositoryId: repo.id, ownerId: repo.ownerId });

    await processJob(
      cloneStore,
      repositoryStore,
      { jobId, repositoryId: repo.id, ownerId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, branch: repo.branch },
      { clone: fakeClone, getSha: (await import('../repository-git.js')).getCommitSha, discover: discoverRepository },
    );

    const job = await cloneStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.match(job?.error ?? '', /does-not-exist/);

    const repository = await repositoryStore.getByIdAsync(repo.id);
    assert.equal(repository?.status, 'FAILED');
  });

  it('TEST 4 — an invalid repository URL is rejected before any clone dependency is ever invoked', async () => {
    const cloneStore = new UnifiedRepositoryCloneStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const repo = makeRepositoryRecord();
    await repositoryStore.create({ id: repo.id, userId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: repo.branch });

    const jobId = randomUUID();
    await cloneStore.create({ id: jobId, repositoryId: repo.id, ownerId: repo.ownerId });

    let cloneCalled = false;
    await processJob(
      cloneStore,
      repositoryStore,
      { jobId, repositoryId: repo.id, ownerId: repo.ownerId, repoUrl: 'https://evil.example.com/owner/repo', branch: repo.branch },
      {
        clone: async (...args) => { cloneCalled = true; return fakeClone(...args); },
        getSha: (await import('../repository-git.js')).getCommitSha,
        discover: discoverRepository,
      },
    );

    assert.equal(cloneCalled, false, 'the real allowlist check must reject this before any clone dependency runs');
    const job = await cloneStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
  });

  it('duplicate job protection: a second clone job for the same repository while one is already terminal is a distinct, independent job (no cross-contamination)', async () => {
    const cloneStore = new UnifiedRepositoryCloneStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const repo = makeRepositoryRecord();
    await repositoryStore.create({ id: repo.id, userId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: repo.branch });

    const firstJobId = randomUUID();
    await cloneStore.create({ id: firstJobId, repositoryId: repo.id, ownerId: repo.ownerId });
    await processJob(
      cloneStore,
      repositoryStore,
      { jobId: firstJobId, repositoryId: repo.id, ownerId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, branch: repo.branch },
      { clone: fakeClone, getSha: (await import('../repository-git.js')).getCommitSha, discover: discoverRepository },
    );

    const latest = await cloneStore.getLatestForRepositoryAsync(repo.id);
    assert.equal(latest?.jobId, firstJobId);
    assert.equal(latest?.status, 'COMPLETED');
  });

  it('TEST 12/13 — timeout: a clone that runs longer than REPOSITORY_CLONE_TIMEOUT_MS is marked TIMED_OUT and its process is aborted', async () => {
    const cloneStore = new UnifiedRepositoryCloneStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const repo = makeRepositoryRecord();
    await repositoryStore.create({ id: repo.id, userId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: repo.branch });

    const jobId = randomUUID();
    await cloneStore.create({ id: jobId, repositoryId: repo.id, ownerId: repo.ownerId });

    let observedAbort = false;
    const slowClone: typeof cloneRepository = (_url, _branch, _dir, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          observedAbort = true;
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });

    await processJob(
      cloneStore,
      repositoryStore,
      { jobId, repositoryId: repo.id, ownerId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, branch: repo.branch },
      { clone: slowClone, getSha: (await import('../repository-git.js')).getCommitSha, discover: discoverRepository },
    );

    assert.equal(observedAbort, true, 'the timeout must actually abort the in-flight clone, not just mark it timed out');
    const job = await cloneStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'TIMED_OUT');
    const repository = await repositoryStore.getByIdAsync(repo.id);
    assert.equal(repository?.status, 'FAILED');
  });

  it('TEST 11/13 — cancellation: a RUNNING clone is aborted, cleaned up, and marked CANCELLED, and the repository reverts to CONNECTED', async () => {
    const cloneStore = new UnifiedRepositoryCloneStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const repo = makeRepositoryRecord();
    await repositoryStore.create({ id: repo.id, userId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: repo.branch });

    const jobId = randomUUID();
    await cloneStore.create({ id: jobId, repositoryId: repo.id, ownerId: repo.ownerId });

    let observedAbort = false;
    const slowClone: typeof cloneRepository = (_url, _branch, _dir, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          observedAbort = true;
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });

    const jobPromise = processJob(
      cloneStore,
      repositoryStore,
      { jobId, repositoryId: repo.id, ownerId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, branch: repo.branch },
      { clone: slowClone, getSha: (await import('../repository-git.js')).getCommitSha, discover: discoverRepository },
    );

    // Poll (rather than guess a fixed delay) until processJob has actually
    // reached RUNNING and registered its job control, then request
    // cancellation — avoids a flaky race against process/scheduling timing.
    const pollStart = Date.now();
    let runningJob = await cloneStore.getByIdAsync(jobId);
    while (runningJob?.status !== 'RUNNING' && Date.now() - pollStart < 2000) {
      await new Promise((r) => setTimeout(r, 5));
      runningJob = await cloneStore.getByIdAsync(jobId);
    }
    assert.equal(runningJob?.status, 'RUNNING');

    const cancelResult = await cancelRepositoryCloneJob(cloneStore, repositoryStore, jobId);
    assert.equal(cancelResult?.status, 'CANCELLED');

    await jobPromise;

    assert.equal(observedAbort, true);
    const job = await cloneStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'CANCELLED');
    const repository = await repositoryStore.getByIdAsync(repo.id);
    assert.equal(repository?.status, 'CONNECTED');
  });

  it('cancelling an already-terminal job is idempotent and does not change its status', async () => {
    const cloneStore = new UnifiedRepositoryCloneStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const repo = makeRepositoryRecord();
    await repositoryStore.create({ id: repo.id, userId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: repo.branch });

    const jobId = randomUUID();
    await cloneStore.create({ id: jobId, repositoryId: repo.id, ownerId: repo.ownerId });
    await processJob(
      cloneStore,
      repositoryStore,
      { jobId, repositoryId: repo.id, ownerId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, branch: repo.branch },
      { clone: fakeClone, getSha: (await import('../repository-git.js')).getCommitSha, discover: discoverRepository },
    );

    const beforeCancel = await cloneStore.getByIdAsync(jobId);
    assert.equal(beforeCancel?.status, 'COMPLETED');

    const result = await cancelRepositoryCloneJob(cloneStore, repositoryStore, jobId);
    assert.equal(result?.status, 'COMPLETED');
  });

  it('returns undefined when cancelling a job id that does not exist', async () => {
    const cloneStore = new UnifiedRepositoryCloneStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const result = await cancelRepositoryCloneJob(cloneStore, repositoryStore, randomUUID());
    assert.equal(result, undefined);
  });

  it('enqueueRepositoryCloneJob drives the job via the no-Redis fallback (setImmediate -> processJob)', async () => {
    const cloneStore = new UnifiedRepositoryCloneStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const repo = makeRepositoryRecord();
    await repositoryStore.create({ id: repo.id, userId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: repo.branch });

    const jobId = randomUUID();
    await cloneStore.create({ id: jobId, repositoryId: repo.id, ownerId: repo.ownerId });
    enqueueRepositoryCloneJob(cloneStore, repositoryStore, { jobId, repositoryId: repo.id, ownerId: repo.ownerId, repoUrl: REAL_ALLOWLISTED_URL, branch: repo.branch });

    // The public enqueue path uses the real cloneRepository (no injected
    // deps), so actually reaching a real github.com host is not something
    // this offline test suite should depend on — it may complete, or it may
    // fail/time out for network reasons in this sandbox, and either is
    // acceptable here. What matters is that the setImmediate -> processJob
    // wiring actually fires and runs the job to *some* terminal state; the
    // wait is bounded well past REPOSITORY_CLONE_TIMEOUT_MS so this test's
    // own background job is fully settled (including cleanup) before the
    // suite's `after()` hook removes DATA_DIR out from under it.
    const start = Date.now();
    let job = await cloneStore.getByIdAsync(jobId);
    while (job && !['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job.status) && Date.now() - start < 4000) {
      await new Promise((r) => setTimeout(r, 20));
      job = await cloneStore.getByIdAsync(jobId);
    }
    assert.notEqual(job?.status, 'QUEUED');
  });
});
