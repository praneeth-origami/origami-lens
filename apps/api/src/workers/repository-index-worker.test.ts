import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Isolated, disposable data dir + no Postgres/Redis — same pattern as the
 * Phase 2 worker tests. Indexing needs no network at all (unlike cloning),
 * so these tests exercise the real, unmocked worker end to end against a
 * fixture "clone" placed directly at the exact path the real Phase 2 clone
 * worker would have produced (via resolveCloneDir) — no injected
 * dependencies are needed for the common-path tests.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-index-worker-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const { UnifiedRepositoryIndexStore } = await import('../unified-repository-index-store.js');
const { UnifiedRepositoryStore } = await import('../unified-repository-store.js');
const { UnifiedRepositoryCloneStore } = await import('../unified-repository-clone-store.js');
const { resolveCloneDir } = await import('../repository-clone-service.js');
const { processJob, cancelRepositoryIndexJob, enqueueRepositoryIndexJob } = await import('./repository-index-worker.js');

const REAL_ALLOWLISTED_URL = 'https://github.com/octocat/Hello-World';
const SAMPLE_DISCOVERY = {
  fileCount: 1,
  directoryCount: 0,
  totalSizeBytes: 10,
  topLevelDirectories: [],
  topLevelFiles: ['README.md'],
  extensions: { '.md': 1 },
  largestFiles: [],
};

function writeFixture(cloneDir: string, relativePath: string, content: string): void {
  const full = path.join(cloneDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Sets up a repository + a COMPLETED clone job whose clone directory (via resolveCloneDir) actually exists on disk with the given fixture files. */
async function setupCompletedClone(
  repositoryStore: InstanceType<typeof UnifiedRepositoryStore>,
  cloneStore: InstanceType<typeof UnifiedRepositoryCloneStore>,
  files: Record<string, string>,
  commitSha = 'a'.repeat(40),
) {
  const ownerId = `owner-${randomUUID()}`;
  const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
  const cloneJobId = randomUUID();
  await cloneStore.create({ id: cloneJobId, repositoryId: repository.id, ownerId });

  const cloneDir = resolveCloneDir(repository.id, cloneJobId);
  for (const [relativePath, content] of Object.entries(files)) writeFixture(cloneDir, relativePath, content);

  await cloneStore.markRunning(cloneJobId, cloneDir);
  await cloneStore.complete(cloneJobId, { status: 'COMPLETED', commitSha, discovery: SAMPLE_DISCOVERY });
  await repositoryStore.updateStatus(repository.id, 'READY_FOR_INDEXING');

  return { repository, cloneJobId, cloneDir, ownerId, commitSha };
}

describe('repository-index-worker processJob lifecycle', () => {
  it('TEST 32/36/40 — a valid READY_FOR_INDEXING repository is indexed, becomes READY_FOR_SEARCH, and persists the commit sha', async () => {
    const indexStore = new UnifiedRepositoryIndexStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const cloneStore = new UnifiedRepositoryCloneStore();

    const { repository, cloneJobId, commitSha } = await setupCompletedClone(repositoryStore, cloneStore, {
      'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
      'README.md': '# fixture',
    });

    const jobId = randomUUID();
    await indexStore.create({ id: jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId, commitSha });
    await processJob(indexStore, repositoryStore, cloneStore, { jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId });

    const job = await indexStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.equal(job?.commitSha, commitSha);
    assert.equal(job?.filesIndexed, 1); // math.ts (README.md has no wired grammar)
    assert.equal(job?.filesSkipped, 1);
    assert.ok((job?.chunksCreated ?? 0) > 0);

    const repo = await repositoryStore.getByIdAsync(repository.id);
    assert.equal(repo?.status, 'READY_FOR_SEARCH');
  });

  it('TEST 33 — a missing/incomplete clone job is rejected without touching the repository', async () => {
    const indexStore = new UnifiedRepositoryIndexStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const cloneStore = new UnifiedRepositoryCloneStore();

    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_INDEXING');

    const jobId = randomUUID();
    const bogusCloneJobId = randomUUID(); // never created in cloneStore
    await indexStore.create({ id: jobId, repositoryId: repository.id, cloneJobId: bogusCloneJobId, ownerId, commitSha: 'deadbeef' });
    await processJob(indexStore, repositoryStore, cloneStore, { jobId, repositoryId: repository.id, cloneJobId: bogusCloneJobId, ownerId });

    const job = await indexStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.match(job?.error ?? '', /no successful clone/i);

    const repo = await repositoryStore.getByIdAsync(repository.id);
    assert.equal(repo?.status, 'READY_FOR_INDEXING'); // reverted, never claimed FAILED for a precondition rejection of this kind
  });

  it('TEST 37 — a bad file among many good ones does not fail the whole job', async () => {
    const indexStore = new UnifiedRepositoryIndexStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const cloneStore = new UnifiedRepositoryCloneStore();

    const { repository, cloneJobId, commitSha } = await setupCompletedClone(repositoryStore, cloneStore, {
      'src/a.ts': 'export function a() { return 1; }\n',
      'src/b.ts': 'export function b() { return 2; }\n',
      // A file with a binary extension mixed in among otherwise-good TypeScript sources.
      'src/broken.png': 'not really typescript, and not really a png either',
    });

    const jobId = randomUUID();
    await indexStore.create({ id: jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId, commitSha });
    await processJob(indexStore, repositoryStore, cloneStore, { jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId });

    const job = await indexStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.equal(job?.filesIndexed, 2);
    assert.equal(job?.filesSkipped, 1);
  });

  it('TEST 41/42 — repository content is never executed: no eval/Function/child_process/vm anywhere in the indexing pipeline', () => {
    const apiSrcDir = path.join(__dirname, '..');
    const files = [
      path.join(apiSrcDir, 'repository-ast.ts'),
      path.join(apiSrcDir, 'repository-index-service.ts'),
      path.join(apiSrcDir, 'repository-chunker.ts'),
      path.join(apiSrcDir, 'repository-language.ts'),
      path.join(apiSrcDir, 'repository-file-safety.ts'),
      path.join(__dirname, 'repository-index-worker.ts'),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      assert.ok(!/\beval\s*\(/.test(source), `${file} must never call eval`);
      assert.ok(!/new\s+Function\s*\(/.test(source), `${file} must never construct a dynamic Function`);
      assert.ok(!/from\s+['"]node:child_process['"]|require\(['"]node:?child_process['"]\)/.test(source), `${file} (indexing pipeline) must never spawn child processes — only Tree-sitter/fs are used`);
      assert.ok(!/\bvm\.(runIn|createContext|Script)/.test(source), `${file} must never use the vm module to execute arbitrary content`);
    }
  });
});

describe('repository-index-worker cancellation', () => {
  it('TEST 38/39 — cancelling a RUNNING index job stops it, deletes partial rows, marks CANCELLED, and reverts the repository to READY_FOR_INDEXING', async () => {
    const indexStore = new UnifiedRepositoryIndexStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const cloneStore = new UnifiedRepositoryCloneStore();

    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`src/file${i}.ts`] = `export function fn${i}() { return ${i}; }\n`;
    const { repository, cloneJobId, commitSha } = await setupCompletedClone(repositoryStore, cloneStore, files);

    const jobId = randomUUID();
    await indexStore.create({ id: jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId, commitSha });

    // Slow down each file's processing artificially so the test has a real
    // window to request cancellation while the job is genuinely RUNNING.
    const { processRepositoryFile } = await import('../repository-index-service.js');
    const { iterateRepositoryFiles } = await import('../repository-discovery.js');
    const slowProcessFile: typeof processRepositoryFile = async (entry, context, limits) => {
      await new Promise((r) => setTimeout(r, 15));
      return processRepositoryFile(entry, context, limits);
    };

    const jobPromise = processJob(
      indexStore,
      repositoryStore,
      cloneStore,
      { jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId },
      { iterateFiles: iterateRepositoryFiles, processFile: slowProcessFile },
    );

    const pollStart = Date.now();
    let runningJob = await indexStore.getByIdAsync(jobId);
    while (runningJob?.status !== 'RUNNING' && Date.now() - pollStart < 2000) {
      await new Promise((r) => setTimeout(r, 5));
      runningJob = await indexStore.getByIdAsync(jobId);
    }
    assert.equal(runningJob?.status, 'RUNNING');

    const cancelResult = await cancelRepositoryIndexJob(indexStore, repositoryStore, jobId);
    assert.equal(cancelResult?.status, 'CANCELLED');

    await jobPromise;

    const job = await indexStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'CANCELLED');

    const summary = await indexStore.getSummaryAsync(jobId);
    assert.equal(summary.filesIndexed, 0);
    assert.equal(summary.filesSkipped, 0);
    assert.equal(summary.chunksCreated, 0);

    const repo = await repositoryStore.getByIdAsync(repository.id);
    assert.equal(repo?.status, 'READY_FOR_INDEXING');
  });

  it('cancelling an already-terminal job is idempotent', async () => {
    const indexStore = new UnifiedRepositoryIndexStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const cloneStore = new UnifiedRepositoryCloneStore();

    const { repository, cloneJobId, commitSha } = await setupCompletedClone(repositoryStore, cloneStore, { 'a.ts': 'export const a = 1;\n' });
    const jobId = randomUUID();
    await indexStore.create({ id: jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId, commitSha });
    await processJob(indexStore, repositoryStore, cloneStore, { jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId });

    const before = await indexStore.getByIdAsync(jobId);
    assert.equal(before?.status, 'COMPLETED');

    const result = await cancelRepositoryIndexJob(indexStore, repositoryStore, jobId);
    assert.equal(result?.status, 'COMPLETED');
  });

  it('returns undefined when cancelling a job id that does not exist', async () => {
    const indexStore = new UnifiedRepositoryIndexStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const result = await cancelRepositoryIndexJob(indexStore, repositoryStore, randomUUID());
    assert.equal(result, undefined);
  });
});

describe('enqueueRepositoryIndexJob', () => {
  it('drives the job via the no-Redis fallback (setImmediate -> processJob)', async () => {
    const indexStore = new UnifiedRepositoryIndexStore();
    const repositoryStore = new UnifiedRepositoryStore();
    const cloneStore = new UnifiedRepositoryCloneStore();

    const { repository, cloneJobId, commitSha } = await setupCompletedClone(repositoryStore, cloneStore, { 'a.ts': 'export const a = 1;\n' });
    const jobId = randomUUID();
    await indexStore.create({ id: jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId, commitSha });
    enqueueRepositoryIndexJob(indexStore, repositoryStore, cloneStore, { jobId, repositoryId: repository.id, cloneJobId, ownerId: repository.ownerId });

    const start = Date.now();
    let job = await indexStore.getByIdAsync(jobId);
    while (job && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 20));
      job = await indexStore.getByIdAsync(jobId);
    }
    assert.equal(job?.status, 'COMPLETED');
  });
});
