import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RepositoryDiscoveryMetadata } from '@origami/contracts';

// Isolated, disposable data dir + no Postgres — exercises the always-
// available legacy store deterministically, same pattern as
// unified-repository-store.test.ts.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-clone-store-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';
const DATA_FILE = path.join(DATA_DIR, 'repository-clone-jobs.json');

const { UnifiedRepositoryCloneStore } = await import('./unified-repository-clone-store.js');

const SAMPLE_DISCOVERY: RepositoryDiscoveryMetadata = {
  fileCount: 42,
  directoryCount: 7,
  totalSizeBytes: 123456,
  topLevelDirectories: ['src', 'test'],
  topLevelFiles: ['package.json'],
  extensions: { '.ts': 40, '.json': 2 },
  largestFiles: [{ path: 'src/big.ts', sizeBytes: 5000 }],
};

describe('UnifiedRepositoryCloneStore', () => {
  let store: InstanceType<typeof UnifiedRepositoryCloneStore>;

  beforeEach(() => {
    if (fs.existsSync(DATA_FILE)) fs.rmSync(DATA_FILE);
    store = new UnifiedRepositoryCloneStore();
  });

  it('persists a newly created job as QUEUED', async () => {
    const repositoryId = randomUUID();
    const jobId = randomUUID();
    const job = await store.create({ id: jobId, repositoryId, ownerId: 'owner-a' });
    assert.equal(job.status, 'QUEUED');
    assert.equal(job.repositoryId, repositoryId);
    assert.ok(job.createdAt);

    const fetched = await store.getByIdAsync(jobId);
    assert.deepEqual(fetched, job);
  });

  it('the job/repository relationship is preserved through the full status lifecycle', async () => {
    const repositoryId = randomUUID();
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId, ownerId: 'owner-a' });

    await store.markRunning(jobId, '/tmp/fake/clone/dir');
    let job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'RUNNING');
    assert.equal(job?.repositoryId, repositoryId);
    assert.ok(job?.startedAt);

    await store.complete(jobId, { status: 'COMPLETED', commitSha: 'a'.repeat(40), discovery: SAMPLE_DISCOVERY });
    job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.equal(job?.repositoryId, repositoryId);
    assert.ok(job?.completedAt);
  });

  it('persists discovery metadata exactly as provided', async () => {
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId: randomUUID(), ownerId: 'owner-a' });
    await store.markRunning(jobId, '/tmp/fake');
    await store.complete(jobId, { status: 'COMPLETED', commitSha: 'b'.repeat(40), discovery: SAMPLE_DISCOVERY });

    const job = await store.getByIdAsync(jobId);
    assert.deepEqual(job?.discovery, SAMPLE_DISCOVERY);
    assert.equal(job?.commitSha, 'b'.repeat(40));
  });

  it('persists a failure error message without discovery/commitSha', async () => {
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId: randomUUID(), ownerId: 'owner-a' });
    await store.markRunning(jobId, '/tmp/fake');
    await store.complete(jobId, { status: 'FAILED', error: "Branch 'x' does not exist on this repository." });

    const job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.equal(job?.error, "Branch 'x' does not exist on this repository.");
    assert.equal(job?.discovery, undefined);
    assert.equal(job?.commitSha, undefined);
  });

  it('getLatestForRepositoryAsync returns the most recently created job for that repository, newest first', async () => {
    const repositoryId = randomUUID();
    const first = await store.create({ id: randomUUID(), repositoryId, ownerId: 'owner-a' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.create({ id: randomUUID(), repositoryId, ownerId: 'owner-a' });

    const latest = await store.getLatestForRepositoryAsync(repositoryId);
    assert.equal(latest?.jobId, second.jobId);
    assert.notEqual(latest?.jobId, first.jobId);
  });

  it('getLatestForRepositoryAsync never returns a job belonging to a different repository', async () => {
    const repoA = randomUUID();
    const repoB = randomUUID();
    const jobA = await store.create({ id: randomUUID(), repositoryId: repoA, ownerId: 'owner-a' });
    await store.create({ id: randomUUID(), repositoryId: repoB, ownerId: 'owner-a' });

    const latestForA = await store.getLatestForRepositoryAsync(repoA);
    assert.equal(latestForA?.jobId, jobA.jobId);
  });

  it('owner isolation: two different owners cloning the same repository id keep independent job records', async () => {
    const repositoryId = randomUUID();
    const jobOwnerA = await store.create({ id: randomUUID(), repositoryId, ownerId: 'owner-a' });
    const jobOwnerB = await store.create({ id: randomUUID(), repositoryId, ownerId: 'owner-b' });

    const fetchedA = await store.getByIdAsync(jobOwnerA.jobId);
    const fetchedB = await store.getByIdAsync(jobOwnerB.jobId);
    assert.equal(fetchedA?.ownerId, 'owner-a');
    assert.equal(fetchedB?.ownerId, 'owner-b');
  });

  it('returns undefined for an unknown job id', async () => {
    const job = await store.getByIdAsync(randomUUID());
    assert.equal(job, undefined);
  });

  it('returns undefined from getLatestForRepositoryAsync when no job exists for that repository', async () => {
    const job = await store.getLatestForRepositoryAsync(randomUUID());
    assert.equal(job, undefined);
  });

  it('supports the CANCELLED terminal status with its own error message', async () => {
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId: randomUUID(), ownerId: 'owner-a' });
    await store.markRunning(jobId, '/tmp/fake');
    await store.complete(jobId, { status: 'CANCELLED', error: 'Clone cancelled by user.' });

    const job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'CANCELLED');
    assert.equal(job?.error, 'Clone cancelled by user.');
  });

  it('supports the TIMED_OUT terminal status', async () => {
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId: randomUUID(), ownerId: 'owner-a' });
    await store.markRunning(jobId, '/tmp/fake');
    await store.complete(jobId, { status: 'TIMED_OUT', error: 'Clone timed out after 120s.' });

    const job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'TIMED_OUT');
  });
});
