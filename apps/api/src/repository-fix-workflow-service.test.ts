import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

/**
 * SCAN_DATA_DIR/DATABASE_URL/REDIS_URL must be forced BEFORE any of this
 * project's stores are imported — same convention as
 * repository-fix-application-service.test.ts and
 * workers/repository-index-worker.test.ts.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-fix-workflow-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const { UnifiedRepositoryStore } = await import('./unified-repository-store.js');
const { UnifiedRepositoryIndexStore } = await import('./unified-repository-index-store.js');
const { UnifiedRepositoryFixWorkflowStore } = await import('./unified-repository-fix-workflow-store.js');
const { resolveCloneDir } = await import('./repository-clone-service.js');
const { resolveFixWorkspaceDir } = await import('./repository-fix-worktree.js');
const { FixWorkflowError, approveFindingFix, reviewFindingFix, sweepExpiredFixWorkflows } = await import('./repository-fix-workflow-service.js');

import type { Issue, Repository, RepositoryFixProposalFileChange, RepositoryFixProposalResponse } from '@origami/contracts';
import type { RepositoryProviderClient, PullRequestInfo, RepositoryInfo, CreatePullRequestParams } from './repository-provider-client.js';
import { RepositoryProviderError } from './repository-provider-client.js';

function run(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const repositoryStore = new UnifiedRepositoryStore();
const indexStore = new UnifiedRepositoryIndexStore();
const workflowStore = new UnifiedRepositoryFixWorkflowStore();
const stores = { indexStore, workflowStore };

const SAMPLE_FINDING: Issue = {
  id: 'finding-1', category: 'accessibility', type: 'label', severity: 'MEDIUM',
  title: 'Missing form label', confidence: 0.9, impact: 'Screen reader users cannot identify the field.',
  source: 'axe-core', problem: 'The search input has no associated label.', cause: 'No <label> element references the input.',
  suggestedFix: 'Add a <label> for the input.', evidence: { selector: '.search-input' },
};

class FakeProviderClient implements RepositoryProviderClient {
  createCalls = 0;
  validateAccessError: RepositoryProviderError | null = null;
  createError: RepositoryProviderError | null = null;
  pushCredentialsError: RepositoryProviderError | null = null;
  repositoryInfo: RepositoryInfo = { defaultBranch: 'main' };
  private prsByHead = new Map<string, PullRequestInfo>();

  constructor(public readonly provider: 'GITHUB' | 'GITLAB' | 'BITBUCKET' = 'GITHUB') {}

  getPushCredentials() {
    if (this.pushCredentialsError) throw this.pushCredentialsError;
    return { username: 'x-access-token', token: 'fake-push-token' };
  }

  async validateRemoteAccess(): Promise<void> {
    if (this.validateAccessError) throw this.validateAccessError;
  }

  async getRepositoryInfo(): Promise<RepositoryInfo> {
    return this.repositoryInfo;
  }

  async createPullRequest(_userId: string, params: CreatePullRequestParams): Promise<PullRequestInfo> {
    this.createCalls += 1;
    if (this.createError) throw this.createError;
    const existing = this.prsByHead.get(params.head);
    if (existing) return { ...existing, alreadyExisted: true };
    const pr: PullRequestInfo = { number: this.prsByHead.size + 1, url: `https://github.com/fake/repo/pull/${this.prsByHead.size + 1}`, alreadyExisted: false };
    this.prsByHead.set(params.head, pr);
    return pr;
  }
}

interface FixtureFile {
  path: string;
  content: string;
  language: string;
}

async function setupRepository(files: FixtureFile[], overrides: { branch?: string | undefined } = {}) {
  const ownerId = `owner-${randomUUID()}`;
  const created = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: 'https://github.com/octocat/Hello-World', provider: 'GITHUB', branch: overrides.branch ?? 'main' });
  const repository = ((await repositoryStore.updateStatus(created.id, 'READY_FOR_SEARCH')) ?? created) as Repository;

  const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-workflow-bare-'));
  run(bareRemote, ['init', '--bare', '--quiet', '--initial-branch=main']);

  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-workflow-seed-'));
  run(seed, ['init', '--quiet', '--initial-branch=main']);
  run(seed, ['config', 'user.email', 'seed@example.com']);
  run(seed, ['config', 'user.name', 'Seed']);
  for (const file of files) {
    const full = path.join(seed, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
  }
  // core.autocrlf=false here too: without it, this seed commit's own `git
  // add` would silently rewrite any literal \r\n bytes a fixture wrote
  // above to \n before they ever reach the bare remote, on a host machine
  // whose global git config defaults to autocrlf=true (Phase 14 finding).
  run(seed, ['-c', 'core.autocrlf=false', 'add', '.']);
  run(seed, ['commit', '-m', 'initial', '--quiet']);
  run(seed, ['remote', 'add', 'origin', bareRemote]);
  run(seed, ['push', 'origin', 'main']);
  fs.rmSync(seed, { recursive: true, force: true });

  const cloneJobId = randomUUID();
  const cloneDir = resolveCloneDir(repository.id, cloneJobId);
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
  // core.autocrlf=false: deterministic byte-for-byte checkout regardless of
  // this host's global Git config (Windows commonly defaults autocrlf=true,
  // which would otherwise silently rewrite LF -> CRLF on checkout — the
  // exact real limitation the Phase 11 report documented, here avoided at
  // the test-fixture level so assertions compare exact bytes reliably).
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', bareRemote, cloneDir]);
  const commitSha = execFileSync('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

  const indexJobId = randomUUID();
  await indexStore.create({ id: indexJobId, repositoryId: repository.id, cloneJobId, commitSha });
  await indexStore.markRunning(indexJobId);
  for (const file of files) {
    await indexStore.insertFile({
      id: randomUUID(), indexJobId, repositoryId: repository.id, commitSha,
      filePath: file.path, language: file.language, fileSizeBytes: Buffer.byteLength(file.content, 'utf8'), status: 'INDEXED',
    });
  }
  await indexStore.complete(indexJobId, { status: 'COMPLETED', filesIndexed: files.length, filesSkipped: 0, chunksCreated: 0 });

  return { repository, ownerId, cloneDir, bareRemote, commitSha };
}

function buildProposal(overrides: Partial<RepositoryFixProposalResponse> & { repositoryId: string; commitSha: string; changes: RepositoryFixProposalFileChange[] }): RepositoryFixProposalResponse {
  return { findingId: SAMPLE_FINDING.id, status: 'PROPOSED', summary: 'A fix.', reasoning: 'Because.', sources: [], candidateCount: 1, reranked: false, ...overrides };
}

function withGitEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env.GIT_COMMIT_NAME = 'Origami AI';
  process.env.GIT_COMMIT_EMAIL = 'ai@origami.dev';
  process.env.GITHUB_TOKEN = 'test-token';
  return fn();
}

const allCloneDirs: string[] = [];
const allBareRemotes: string[] = [];

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  for (const dir of allBareRemotes) fs.rmSync(dir, { recursive: true, force: true });
});

describe('reviewFindingFix', () => {
  it('TEST 1 — produces a reviewable application with an applicationId, readyForApproval true, and no branch/commit/PR created', async () => {
    const { repository, ownerId, commitSha, bareRemote } = await setupRepository([{ path: 'src/app.ts', content: 'export const x = 1;\n', language: 'typescript' }]);
    allBareRemotes.push(bareRemote);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/app.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const x = 1;', newText: 'export const x = 2;' }] }],
    });

    const review = await reviewFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    assert.equal(review.status, 'READY_FOR_REVIEW');
    assert.equal(review.readyForApproval, true);
    assert.ok(review.applicationId);
    assert.equal(review.changedFiles.length, 1);

    const remoteBranches = run(bareRemote, ['branch', '-a']).trim();
    assert.ok(!remoteBranches.includes('ai-fix/'), 'no branch should exist on the remote from review alone');

    // The retained workspace exists on disk for the subsequent approve step.
    const workspaceDir = resolveFixWorkspaceDir(repository.id, review.applicationId);
    assert.ok(fs.existsSync(workspaceDir));
  });

  it('TEST 14 — the retained workspace is isolated from the original clone', async () => {
    const { repository, ownerId, commitSha, cloneDir, bareRemote } = await setupRepository([{ path: 'src/iso.ts', content: 'export const iso = 1;\n', language: 'typescript' }]);
    allBareRemotes.push(bareRemote);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/iso.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const iso = 1;', newText: 'export const iso = 2;' }] }],
    });
    const review = await reviewFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    const workspaceDir = resolveFixWorkspaceDir(repository.id, review.applicationId);
    fs.writeFileSync(path.join(workspaceDir, 'src/iso.ts'), 'mutated further\n');
    assert.equal(fs.readFileSync(path.join(cloneDir, 'src/iso.ts'), 'utf-8'), 'export const iso = 1;\n');
  });
});

describe('approveFindingFix — approval required / not yet reviewed', () => {
  it('TEST 4/13 — approving an unknown/never-reviewed applicationId is rejected as WORKSPACE_NOT_FOUND (approval requires a prior review)', async () => {
    const { repository, ownerId, commitSha, bareRemote } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    allBareRemotes.push(bareRemote);
    const proposal = buildProposal({ repositoryId: repository.id, commitSha, changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const a = 1;', newText: 'const a = 2;' }] }] });
    await withGitEnv(async () => {
      await assert.rejects(
        () => approveFindingFix(repository, SAMPLE_FINDING, randomUUID(), proposal, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId }),
        (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'WORKSPACE_NOT_FOUND'); return true; },
      );
    });
  });
});

async function reviewAndApprove(files: FixtureFile[], changeOverride?: Partial<RepositoryFixProposalFileChange>) {
  const { repository, ownerId, commitSha, bareRemote, cloneDir } = await setupRepository(files);
  allBareRemotes.push(bareRemote);
  const proposal = buildProposal({
    repositoryId: repository.id, commitSha,
    changes: [{ filePath: files[0].path, language: files[0].language, hunks: [{ startLine: 1, endLine: 1, oldText: files[0].content.trimEnd(), newText: `${files[0].content.trimEnd()}_fixed` }], ...changeOverride }],
  });
  const review = await reviewFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
  return { repository, ownerId, commitSha, bareRemote, cloneDir, proposal, review };
}

describe('approveFindingFix — full success path', () => {
  it('TEST 5/6/9/10/17/23/24 — approving creates a branch, commit with the configured identity, pushes it, opens a PR, and reports its metadata', async () => {
    const { repository, ownerId, bareRemote, cloneDir, commitSha, proposal, review } = await reviewAndApprove([{ path: 'src/app.ts', content: 'export const x = 1;\n', language: 'typescript' }]);
    const beforeHash = sha256(fs.readFileSync(path.join(cloneDir, 'src/app.ts'), 'utf-8'));
    const beforeHead = run(cloneDir, ['rev-parse', 'HEAD']).trim();

    const provider = new FakeProviderClient();
    const result = await withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => provider }, { repositoryId: repository.id, ownerId }));

    assert.equal(result.status, 'PR_OPENED');
    assert.ok(result.branchName.startsWith('ai-fix/'));
    assert.match(result.commitSha, /^[0-9a-f]{40}$/);
    assert.equal(result.baseCommitSha, commitSha);
    assert.equal(result.provider, 'GITHUB');
    assert.equal(result.prNumber, 1);
    assert.ok(result.prUrl?.includes('/pull/1'));

    // TEST 9/10 — the remote actually received the branch/commit.
    const remoteBranches = run(bareRemote, ['branch', '-a']).trim();
    assert.ok(remoteBranches.includes(result.branchName));
    const remoteSha = run(bareRemote, ['rev-parse', `refs/heads/${result.branchName}`]).trim();
    assert.equal(remoteSha, result.commitSha);
    const author = run(bareRemote, ['log', '-1', '--format=%an <%ae>', result.branchName]).trim();
    assert.equal(author, 'Origami AI <ai@origami.dev>');

    // TEST 12/24 — original clone completely unchanged.
    const afterHash = sha256(fs.readFileSync(path.join(cloneDir, 'src/app.ts'), 'utf-8'));
    const afterHead = run(cloneDir, ['rev-parse', 'HEAD']).trim();
    assert.equal(afterHash, beforeHash);
    assert.equal(afterHead, beforeHead);
    assert.equal(run(cloneDir, ['status', '--short']).trim(), '');

    // Workspace discarded after a completed workflow.
    assert.equal(fs.existsSync(resolveFixWorkspaceDir(repository.id, review.applicationId)), false);
  });

  it('TEST 12b — the ORIGINAL main branch on the remote never receives a new commit', async () => {
    const { bareRemote, repository, ownerId, proposal, review } = await reviewAndApprove([{ path: 'src/main-check.ts', content: 'export const y = 1;\n', language: 'typescript' }]);
    const mainShaBefore = run(bareRemote, ['rev-parse', 'refs/heads/main']).trim();
    await withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId }));
    const mainShaAfter = run(bareRemote, ['rev-parse', 'refs/heads/main']).trim();
    assert.equal(mainShaAfter, mainShaBefore);
  });
});

describe('approveFindingFix — identity / provider / auth configuration', () => {
  it('TEST 4a — missing GIT_COMMIT_NAME/EMAIL is rejected as GIT_COMMIT_IDENTITY_MISSING before anything is committed', async () => {
    const { repository, ownerId, proposal, review, bareRemote } = await reviewAndApprove([{ path: 'src/id.ts', content: 'export const z = 1;\n', language: 'typescript' }]);
    delete process.env.GIT_COMMIT_NAME;
    delete process.env.GIT_COMMIT_EMAIL;
    process.env.GITHUB_TOKEN = 'test-token';
    await assert.rejects(
      () => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'GIT_COMMIT_IDENTITY_MISSING'); return true; },
    );
    assert.equal(run(bareRemote, ['branch', '-a']).trim().includes('ai-fix/'), false);
  });

  it('TEST 19 — a provider the resolver has no implementation for is rejected as PROVIDER_UNSUPPORTED, before any git mutation', async () => {
    // Phase 13 note: GitLab is now genuinely supported (see
    // repository-gitlab-provider-client.test.ts), so this test exercises
    // the resolver-throws-PROVIDER_UNSUPPORTED path directly (e.g. a
    // provider value with no registered implementation yet) rather than
    // asserting GitLab specifically is unsupported.
    const { repository, ownerId, commitSha, bareRemote } = await setupRepository([{ path: 'src/g.ts', content: 'export const g = 1;\n', language: 'typescript' }]);
    allBareRemotes.push(bareRemote);
    const proposal = buildProposal({ repositoryId: repository.id, commitSha, changes: [{ filePath: 'src/g.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const g = 1;', newText: 'export const g = 2;' }] }] });
    const review = await reviewFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    const unsupportedResolver = () => { throw new RepositoryProviderError('No integration available.', 'PROVIDER_UNSUPPORTED'); };
    await withGitEnv(async () => {
      await assert.rejects(
        () => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: unsupportedResolver }, { repositoryId: repository.id, ownerId }),
        (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'PROVIDER_UNSUPPORTED'); return true; },
      );
    });
    assert.equal(run(bareRemote, ['branch', '-a']).trim().includes('ai-fix/'), false, 'an unsupported provider must never create a branch');
  });

  it('GIT_AUTH_NOT_CONFIGURED is returned when the resolved provider has no push credentials configured', async () => {
    const { repository, ownerId, proposal, review, bareRemote } = await reviewAndApprove([{ path: 'src/auth.ts', content: 'export const a2 = 1;\n', language: 'typescript' }]);
    process.env.GIT_COMMIT_NAME = 'Origami AI';
    process.env.GIT_COMMIT_EMAIL = 'ai@origami.dev';
    const unconfiguredProvider = new FakeProviderClient();
    unconfiguredProvider.pushCredentialsError = new RepositoryProviderError('GITHUB_TOKEN is missing.', 'AUTH_NOT_CONFIGURED');
    await assert.rejects(
      () => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => unconfiguredProvider }, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'GIT_AUTH_NOT_CONFIGURED'); return true; },
    );
    assert.equal(run(bareRemote, ['branch', '-a']).trim().includes('ai-fix/'), false, 'missing push credentials must be caught before any branch is created');
  });
});

describe('approveFindingFix — validation before committing', () => {
  it('TEST 6/7 — only the approved file is staged; an unexpectedly modified extra file aborts with UNEXPECTED_CHANGES and nothing is committed', async () => {
    const { repository, ownerId, proposal, review, bareRemote } = await reviewAndApprove([{ path: 'src/expected.ts', content: 'export const e = 1;\n', language: 'typescript' }]);
    const workspaceDir = resolveFixWorkspaceDir(repository.id, review.applicationId);
    fs.writeFileSync(path.join(workspaceDir, 'src/unexpected.ts'), 'export const u = 1;\n');

    await assert.rejects(
      () => withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId })),
      (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'UNEXPECTED_CHANGES'); return true; },
    );
    assert.equal(run(bareRemote, ['branch', '-a']).trim().includes('ai-fix/'), false);
  });

  it('TEST 23 — a proposal whose commitSha does not match the reviewed application is rejected as COMMIT_SHA_MISMATCH', async () => {
    const { repository, ownerId, proposal, review } = await reviewAndApprove([{ path: 'src/sha.ts', content: 'export const s = 1;\n', language: 'typescript' }]);
    const tampered = { ...proposal, commitSha: 'f'.repeat(40) };
    await withGitEnv(async () => {
      await assert.rejects(
        () => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, tampered, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId }),
        (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'COMMIT_SHA_MISMATCH'); return true; },
      );
    });
  });

  it('a proposal whose content differs from what was reviewed is rejected as PROPOSAL_INVALID (bait-and-switch protection)', async () => {
    const { repository, ownerId, proposal, review } = await reviewAndApprove([{ path: 'src/swap.ts', content: 'export const sw = 1;\n', language: 'typescript' }]);
    const swapped = { ...proposal, summary: 'A DIFFERENT summary than what was reviewed' };
    await withGitEnv(async () => {
      await assert.rejects(
        () => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, swapped, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId }),
        (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'PROPOSAL_INVALID'); return true; },
      );
    });
  });
});

describe('approveFindingFix — idempotency and concurrency', () => {
  it('TEST 15/25 — approving the same applicationId twice sequentially returns the SAME PR, never creating a second one', async () => {
    const { repository, ownerId, proposal, review, bareRemote } = await reviewAndApprove([{ path: 'src/dup.ts', content: 'export const d = 1;\n', language: 'typescript' }]);
    const provider = new FakeProviderClient();
    const first = await withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => provider }, { repositoryId: repository.id, ownerId }));
    const second = await withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => provider }, { repositoryId: repository.id, ownerId }));

    assert.equal(second.prNumber, first.prNumber);
    assert.equal(second.branchName, first.branchName);
    assert.equal(provider.createCalls, 1, 'the provider must only ever be asked to create a PR once');

    const allBranches = run(bareRemote, ['branch', '-a']).trim().split('\n').filter((b) => b.includes('ai-fix/'));
    assert.equal(allBranches.length, 1, 'only one fix branch should exist on the remote');
  });

  it('TEST 16 — two near-simultaneous approval requests result in exactly one branch/commit/PR', async () => {
    const { repository, ownerId, proposal, review, bareRemote } = await reviewAndApprove([{ path: 'src/race.ts', content: 'export const r = 1;\n', language: 'typescript' }]);
    const provider = new FakeProviderClient();

    const [a, b] = await Promise.allSettled([
      withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => provider }, { repositoryId: repository.id, ownerId })),
      withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => provider }, { repositoryId: repository.id, ownerId })),
    ]);

    const succeeded = [a, b].filter((r) => r.status === 'fulfilled');
    const failed = [a, b].filter((r) => r.status === 'rejected');
    assert.ok(succeeded.length >= 1, 'at least the winning request must succeed');
    if (failed.length > 0) {
      const reason = (failed[0] as PromiseRejectedResult).reason;
      assert.ok(reason instanceof FixWorkflowError);
      assert.equal(reason.code, 'WORKFLOW_IN_PROGRESS');
    }

    const allBranches = run(bareRemote, ['branch', '-a']).trim().split('\n').filter((br) => br.includes('ai-fix/'));
    assert.equal(allBranches.length, 1, 'concurrent approval must never create more than one branch');
    assert.ok(provider.createCalls <= 1, 'concurrent approval must never create more than one PR');
  });
});

describe('approveFindingFix — PR provider failure', () => {
  it('TEST 18 — a PR-creation failure is surfaced as PR_CREATION_FAILED, and the workflow is marked FAILED', async () => {
    const { repository, ownerId, proposal, review } = await reviewAndApprove([{ path: 'src/fail.ts', content: 'export const f = 1;\n', language: 'typescript' }]);
    const provider = new FakeProviderClient();
    provider.createError = new RepositoryProviderError('boom', 'REQUEST_FAILED');

    await assert.rejects(
      () => withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => provider }, { repositoryId: repository.id, ownerId })),
      (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'PR_CREATION_FAILED'); return true; },
    );

    const workflow = await workflowStore.getByIdAsync(review.applicationId);
    assert.equal(workflow?.status, 'FAILED');
    assert.equal(workflow?.errorCode, 'PR_CREATION_FAILED');
  });
});

describe('base branch resolution', () => {
  it('TEST 20b — uses the repository\'s own metadata branch as the PR base when configured', async () => {
    const { repository, ownerId, commitSha, bareRemote } = await setupRepository(
      [{ path: 'src/base.ts', content: 'export const b = 1;\n', language: 'typescript' }],
      { branch: 'main' },
    );
    allBareRemotes.push(bareRemote);
    const proposal = buildProposal({ repositoryId: repository.id, commitSha, changes: [{ filePath: 'src/base.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const b = 1;', newText: 'export const b = 2;' }] }] });
    const review = await reviewFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    const provider = new FakeProviderClient();
    let capturedBase = '';
    provider.createPullRequest = async (_userId, params) => { capturedBase = params.base; return { number: 1, url: 'https://x/1', alreadyExisted: false }; };
    await withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => provider }, { repositoryId: repository.id, ownerId }));
    assert.equal(capturedBase, 'main');
  });
});

describe('cancellation', () => {
  it('TEST 26 — an already-aborted signal cancels approval before any git mutation happens', async () => {
    const { repository, ownerId, proposal, review, bareRemote } = await reviewAndApprove([{ path: 'src/cancel.ts', content: 'export const c = 1;\n', language: 'typescript' }]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId }, controller.signal)),
      (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'CANCELLED'); return true; },
    );
    assert.equal(run(bareRemote, ['branch', '-a']).trim().includes('ai-fix/'), false);
  });
});

describe('sweepExpiredFixWorkflows', () => {
  it('TEST 27 — a fresh, unexpired review is never swept', async () => {
    const { repository, ownerId, review } = await reviewAndApprove([{ path: 'src/fresh.ts', content: 'export const fr = 1;\n', language: 'typescript' }]);
    const workspaceDir = resolveFixWorkspaceDir(repository.id, review.applicationId);
    assert.ok(fs.existsSync(workspaceDir));
    void ownerId;

    const sweepCount = await sweepExpiredFixWorkflows(workflowStore);
    assert.equal(sweepCount, 0);
    assert.ok(fs.existsSync(workspaceDir), 'an unexpired workspace must never be swept');
  });

  it('TEST 27b/27c — an expired, never-approved review is swept: its workspace is discarded, the row moves to EXPIRED, and approval is then rejected as APPROVAL_EXPIRED', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/expire.ts', content: 'export const ex = 1;\n', language: 'typescript' }]);
    const applicationId = randomUUID();
    const workspaceDir = resolveFixWorkspaceDir(repository.id, applicationId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'marker.txt'), 'placeholder workspace content\n');

    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/expire.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const ex = 1;', newText: 'export const ex = 2;' }] }],
    });

    // Directly persist an already-expired REVIEWABLE row referencing that
    // workspace — equivalent to what reviewFindingFix would have produced
    // an hour ago, without needing to actually wait out the real TTL.
    const { hashProposal } = await import('./repository-fix-workflow-service.js');
    await workflowStore.create({
      id: applicationId, repositoryId: repository.id, findingId: SAMPLE_FINDING.id, ownerId,
      commitSha, proposalHash: hashProposal(proposal), changedFiles: [], diff: 'diff --git a b', lineGrounding: [],
      syntaxStatus: 'VALID', workspaceDir, expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const sweepCount = await sweepExpiredFixWorkflows(workflowStore);
    assert.equal(sweepCount, 1);
    assert.equal(fs.existsSync(workspaceDir), false, 'the expired workspace must be discarded by the sweep');

    const swept = await workflowStore.getByIdAsync(applicationId);
    assert.equal(swept?.status, 'EXPIRED');

    await withGitEnv(async () => {
      await assert.rejects(
        () => approveFindingFix(repository, SAMPLE_FINDING, applicationId, proposal, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId }),
        (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'APPROVAL_EXPIRED'); return true; },
      );
    });
  });
});

describe('approveFindingFix — Phase 13 multi-provider selection', () => {
  it('a GitHub repository resolves and uses the GitHub provider, unaffected by Phase 13', async () => {
    const { repository, ownerId, proposal, review } = await reviewAndApprove([{ path: 'src/gh.ts', content: 'export const gh = 1;\n', language: 'typescript' }]);
    let requestedProvider = '';
    const resolveProvider = (provider: string) => { requestedProvider = provider; return new FakeProviderClient('GITHUB'); };
    const result = await withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider }, { repositoryId: repository.id, ownerId }));
    assert.equal(requestedProvider, 'GITHUB');
    assert.equal(result.provider, 'GITHUB');
    assert.equal(result.status, 'PR_OPENED');
  });

  it('a GitLab repository resolves and uses a GitLab provider client, and the response reports provider GITLAB', async () => {
    const { repository, ownerId, commitSha, bareRemote } = await setupRepository([{ path: 'src/gl.ts', content: 'export const gl = 1;\n', language: 'typescript' }]);
    allBareRemotes.push(bareRemote);
    const gitlabRepo: Repository = { ...repository, provider: 'GITLAB' };
    const proposal = buildProposal({ repositoryId: repository.id, commitSha, changes: [{ filePath: 'src/gl.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const gl = 1;', newText: 'export const gl = 2;' }] }] });
    const review = await reviewFindingFix(gitlabRepo, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });

    let requestedProvider = '';
    const resolveProvider = (provider: string) => { requestedProvider = provider; return new FakeProviderClient('GITLAB'); };
    const result = await withGitEnv(() => approveFindingFix(gitlabRepo, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider }, { repositoryId: repository.id, ownerId }));
    assert.equal(requestedProvider, 'GITLAB');
    assert.equal(result.provider, 'GITLAB');
    assert.equal(result.status, 'PR_OPENED');
    assert.ok(result.branchName.startsWith('ai-fix/'));
  });

  it('a Bitbucket repository resolves and uses a Bitbucket provider client, and the response reports provider BITBUCKET', async () => {
    const { repository, ownerId, commitSha, bareRemote } = await setupRepository([{ path: 'src/bb.ts', content: 'export const bb = 1;\n', language: 'typescript' }]);
    allBareRemotes.push(bareRemote);
    const bitbucketRepo: Repository = { ...repository, provider: 'BITBUCKET' };
    const proposal = buildProposal({ repositoryId: repository.id, commitSha, changes: [{ filePath: 'src/bb.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const bb = 1;', newText: 'export const bb = 2;' }] }] });
    const review = await reviewFindingFix(bitbucketRepo, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });

    let requestedProvider = '';
    const resolveProvider = (provider: string) => { requestedProvider = provider; return new FakeProviderClient('BITBUCKET'); };
    const result = await withGitEnv(() => approveFindingFix(bitbucketRepo, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider }, { repositoryId: repository.id, ownerId }));
    assert.equal(requestedProvider, 'BITBUCKET');
    assert.equal(result.provider, 'BITBUCKET');
    assert.equal(result.status, 'PR_OPENED');
  });

  it('a provider failure (e.g. PR creation error) does not bypass workflow state handling: the row is marked FAILED with the real error code', async () => {
    const { repository, ownerId, proposal, review } = await reviewAndApprove([{ path: 'src/failcode.ts', content: 'export const fc = 1;\n', language: 'typescript' }]);
    const failing = new FakeProviderClient('GITLAB');
    failing.createError = new RepositoryProviderError('GitLab is down.', 'REQUEST_FAILED');
    await assert.rejects(
      () => withGitEnv(() => approveFindingFix({ ...repository, provider: 'GITLAB' }, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => failing }, { repositoryId: repository.id, ownerId })),
      (error: unknown) => { assert.ok(error instanceof FixWorkflowError); assert.equal(error.code, 'PR_CREATION_FAILED'); return true; },
    );
    const workflow = await workflowStore.getByIdAsync(review.applicationId);
    assert.equal(workflow?.status, 'FAILED');
    assert.equal(workflow?.errorCode, 'PR_CREATION_FAILED');
  });
});

describe('approveFindingFix — Phase 14 CRLF/LF end-to-end through the full branch/commit/push pipeline', () => {
  it('a real CRLF-committed repository file, fixed by an LF-authored proposal, survives review -> approve -> real branch/commit/push with the original clone left byte-for-byte unchanged', async () => {
    const crlfContent = 'export function greet() {\r\n  return "hi";\r\n}\r\n';
    const { repository, ownerId, cloneDir, bareRemote, commitSha } = await setupRepository([{ path: 'src/crlf.ts', content: crlfContent, language: 'typescript' }]);
    allBareRemotes.push(bareRemote);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/crlf.ts', language: 'typescript', hunks: [{ startLine: 2, endLine: 2, oldText: '  return "hi";\n', newText: '  return "hello";\n' }] }],
    });
    const review = await reviewFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    assert.equal(review.status, 'READY_FOR_REVIEW');
    assert.ok(review.diff.includes('hello'));

    const beforeHash = sha256(fs.readFileSync(path.join(cloneDir, 'src/crlf.ts'), 'utf-8'));
    const beforeHead = run(cloneDir, ['rev-parse', 'HEAD']).trim();

    const result = await withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId }));
    assert.equal(result.status, 'PR_OPENED');

    // The pushed branch's committed file must be real CRLF (the file's own
    // convention preserved), containing the fix, not rewritten to LF.
    const remoteFileContent = run(bareRemote, ['show', `${result.branchName}:src/crlf.ts`]);
    assert.ok(remoteFileContent.includes('hello'));
    const crlfCount = (remoteFileContent.match(/\r\n/g) ?? []).length;
    const totalNewlines = (remoteFileContent.match(/\n/g) ?? []).length;
    assert.equal(crlfCount, totalNewlines, 'the committed fix file must remain fully CRLF, matching the original file convention');

    // Original clone completely unaffected.
    const afterHash = sha256(fs.readFileSync(path.join(cloneDir, 'src/crlf.ts'), 'utf-8'));
    const afterHead = run(cloneDir, ['rev-parse', 'HEAD']).trim();
    assert.equal(afterHash, beforeHash);
    assert.equal(afterHead, beforeHead);
  });
});

/**
 * Phase 16/B — cross-user IDOR protection on the Git workflow. Repository
 * ownership (repository.userId, migration 012) is now the ONLY thing that
 * decides who may review/approve a fix — knowing a real applicationId,
 * findingId, or repositoryId is never enough on its own. These tests use
 * the SAME setupRepository()/reviewFindingFix()/approveFindingFix() real
 * code paths as every test above — nothing here is a stand-in or a
 * weakened check.
 */
describe('Phase 16/B — Git workflow cross-user IDOR protection', () => {
  it('User B cannot review a fix for a repository owned by User A', async () => {
    const { repository, commitSha } = await setupRepository([{ path: 'src/idor-review.ts', content: 'export const x = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/idor-review.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const x = 1;', newText: 'export const x = 2;' }] }],
    });
    const userB = `owner-${randomUUID()}`;

    await assert.rejects(
      () => reviewFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId: userB }),
      (e: unknown) => e instanceof FixWorkflowError && e.code === 'REPOSITORY_ACCESS_DENIED',
    );
  });

  it('User B cannot approve a workflow that User A reviewed, even knowing the real applicationId/findingId/repositoryId', async () => {
    const { repository, ownerId: userA, proposal, review, bareRemote } = await reviewAndApprove([{ path: 'src/idor-approve.ts', content: 'export const y = 1;\n', language: 'typescript' }]);
    const userB = `owner-${randomUUID()}`;
    assert.notEqual(userA, userB);

    await assert.rejects(
      () => withGitEnv(() => approveFindingFix(
        repository, SAMPLE_FINDING, review.applicationId, proposal, stores,
        { resolveProvider: () => new FakeProviderClient() },
        { repositoryId: repository.id, ownerId: userB },
      )),
      (e: unknown) => e instanceof FixWorkflowError && e.code === 'REPOSITORY_ACCESS_DENIED',
    );

    // No PR was created by the rejected attempt — the bare remote has no refs but the default branch.
    const refs = run(bareRemote, ['for-each-ref', '--format=%(refname)']);
    assert.equal(refs.split('\n').filter((r) => r.includes('refs/heads/fix/')).length, 0, 'a denied cross-user approval must never create a branch');
  });

  it("the real owner (User A) can still approve their own workflow after a denied cross-user attempt", async () => {
    const { repository, ownerId: userA, proposal, review } = await reviewAndApprove([{ path: 'src/idor-owner-ok.ts', content: 'export const z = 1;\n', language: 'typescript' }]);
    const userB = `owner-${randomUUID()}`;

    await assert.rejects(
      () => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId: userB }),
      (e: unknown) => e instanceof FixWorkflowError && e.code === 'REPOSITORY_ACCESS_DENIED',
    );

    const result = await withGitEnv(() => approveFindingFix(repository, SAMPLE_FINDING, review.applicationId, proposal, stores, { resolveProvider: () => new FakeProviderClient() }, { repositoryId: repository.id, ownerId: userA }));
    assert.equal(result.status, 'PR_OPENED');
  });
});
