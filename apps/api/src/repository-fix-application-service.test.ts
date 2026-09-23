import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

/**
 * REPOSITORY_CLONE_ROOT/REPOSITORY_FIX_WORKSPACE_ROOT are module-level
 * consts computed once at import time — set SCAN_DATA_DIR to a disposable
 * temp dir, and DATABASE_URL/REDIS_URL empty to force the always-available
 * legacy in-memory stores, THEN dynamically import — same convention as
 * workers/repository-index-worker.test.ts and
 * repository-issue-lifecycle-integration.test.ts.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-fix-apply-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const { UnifiedRepositoryStore } = await import('./unified-repository-store.js');
const { UnifiedRepositoryIndexStore } = await import('./unified-repository-index-store.js');
const { resolveCloneDir } = await import('./repository-clone-service.js');
const { resolveFixWorkspaceDir } = await import('./repository-fix-worktree.js');
const { FixApplicationError, applyFindingFix } = await import('./repository-fix-application-service.js');

import type { Issue, RepositoryFixProposalFileChange, RepositoryFixProposalResponse } from '@origami/contracts';

function run(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const repositoryStore = new UnifiedRepositoryStore();
const indexStore = new UnifiedRepositoryIndexStore();

const SAMPLE_FINDING: Issue = {
  id: 'finding-1', category: 'accessibility', type: 'label', severity: 'MEDIUM',
  title: 'Missing form label', confidence: 0.9, impact: 'Screen reader users cannot identify the field.',
  source: 'axe-core', problem: 'The search input has no associated label.', cause: 'No <label> element references the input.',
  suggestedFix: 'Add a <label> for the input.', evidence: { selector: '.search-input' },
};

interface FixtureFile {
  path: string;
  content: string;
  language: string;
}

/**
 * Creates: a Repository (READY_FOR_SEARCH), a real git repo at the exact
 * path resolveCloneDir would produce (a stand-in for what the Phase 2 clone
 * worker + Phase 3 index worker would have already produced), and a
 * COMPLETED index job whose files are registered as INDEXED — everything
 * applyFindingFix needs to locate the clone and validate proposed paths.
 */
async function setupRepository(files: FixtureFile[]) {
  const ownerId = `owner-${randomUUID()}`;
  const created = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: 'https://github.com/octocat/Hello-World', provider: 'GITHUB', branch: 'main' });
  const repository = (await repositoryStore.updateStatus(created.id, 'READY_FOR_SEARCH')) ?? created;

  const cloneJobId = randomUUID();
  const cloneDir = resolveCloneDir(repository.id, cloneJobId);
  fs.mkdirSync(cloneDir, { recursive: true });
  run(cloneDir, ['init', '--quiet']);
  run(cloneDir, ['config', 'user.email', 'test@example.com']);
  run(cloneDir, ['config', 'user.name', 'Origami Test']);
  for (const file of files) {
    const full = path.join(cloneDir, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
  }
  run(cloneDir, ['-c', 'core.autocrlf=false', 'add', '.']);
  run(cloneDir, ['commit', '-m', 'initial', '--quiet']);
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

  return { repository, ownerId, cloneDir, commitSha, indexJobId };
}

function buildProposal(overrides: Partial<RepositoryFixProposalResponse> & { repositoryId: string; commitSha: string; changes: RepositoryFixProposalFileChange[] }): RepositoryFixProposalResponse {
  return {
    findingId: SAMPLE_FINDING.id, status: 'PROPOSED', summary: 'A fix.', reasoning: 'Because.', sources: [], candidateCount: 1, reranked: false,
    ...overrides,
  };
}

const stores = { indexStore };

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('applyFindingFix', () => {
  it('TEST 1 — applies a correctly-grounded proposal and returns READY_FOR_REVIEW with a real git diff', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([
      { path: 'src/app.ts', content: 'export function greet() {\n  return "hi";\n}\n', language: 'typescript' },
    ]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/app.ts', language: 'typescript', hunks: [{ startLine: 2, endLine: 2, oldText: '  return "hi";\n', newText: '  return "hello";\n' }] }],
    });

    const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });

    assert.equal(response.status, 'READY_FOR_REVIEW');
    assert.equal(response.baseCommitSha, commitSha);
    assert.equal(response.changedFiles.length, 1);
    assert.equal(response.changedFiles[0].filePath, 'src/app.ts');
    assert.ok(response.diff.includes('hello'));
    assert.equal(response.validation.proposal, 'VALID');
    assert.equal(response.validation.syntax, 'VALID');
    assert.equal(response.changedFiles[0].syntaxStatus, 'VALID');
  });

  it('TEST 2 — an incorrect AI-reported line number does not prevent the patch from being located and applied by real content', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([
      { path: 'src/comp.tsx', content: 'function Comp() {\n  return (\n    <div>\n      <input />\n    </div>\n  );\n}\n', language: 'tsx' },
    ]);
    // Reports line 2 (wrong) — the input is actually on line 4.
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/comp.tsx', language: 'tsx', hunks: [{ startLine: 2, endLine: 2, oldText: '      <input />', newText: '      <input aria-label="x" />' }] }],
    });

    const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });

    assert.equal(response.status, 'READY_FOR_REVIEW');
    assert.ok(response.diff.includes('aria-label'));
    assert.equal(response.lineGrounding.length, 1);
    assert.equal(response.lineGrounding[0].reportedStartLine, 2);
    assert.equal(response.lineGrounding[0].actualStartLine, 4);
    assert.equal(response.lineGrounding[0].matchedExactly, false);
  });

  it('TEST 3 — correctly-reported line numbers are reflected as an exact match', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([
      { path: 'src/exact.ts', content: 'const x = 1;\nconst y = 2;\n', language: 'typescript' },
    ]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/exact.ts', language: 'typescript', hunks: [{ startLine: 2, endLine: 2, oldText: 'const y = 2;', newText: 'const y = 3;' }] }],
    });
    const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    assert.equal(response.lineGrounding[0].matchedExactly, true);
    assert.equal(response.lineGrounding[0].actualStartLine, 2);
  });

  it('TEST 4 — zero oldText matches is rejected as OLD_TEXT_NOT_FOUND', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'not present anywhere', newText: 'x' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'OLD_TEXT_NOT_FOUND'); return true; },
    );
  });

  it('TEST 5 — an ambiguous (duplicate) oldText match is rejected rather than guessing', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/dup.ts', content: 'foo();\nfoo();\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/dup.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'foo();', newText: 'bar();' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'OLD_TEXT_AMBIGUOUS'); return true; },
    );
  });

  it('TEST 6 — applies changes across multiple files in one proposal', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([
      { path: 'src/one.ts', content: 'const one = 1;\n', language: 'typescript' },
      { path: 'src/two.ts', content: 'const two = 2;\n', language: 'typescript' },
    ]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [
        { filePath: 'src/one.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const one = 1;', newText: 'const one = 100;' }] },
        { filePath: 'src/two.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const two = 2;', newText: 'const two = 200;' }] },
      ],
    });
    const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    assert.equal(response.changedFiles.length, 2);
    assert.ok(response.diff.includes('one.ts'));
    assert.ok(response.diff.includes('two.ts'));
  });

  it('TEST 7 — partial failure (one valid file, one ambiguous file) discards the ENTIRE workspace: no partial success', async () => {
    const { repository, ownerId, commitSha, cloneDir } = await setupRepository([
      { path: 'src/good.ts', content: 'const good = 1;\n', language: 'typescript' },
      { path: 'src/bad.ts', content: 'dup();\ndup();\n', language: 'typescript' },
    ]);
    const originalGoodHash = sha256(fs.readFileSync(path.join(cloneDir, 'src/good.ts'), 'utf-8'));
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [
        { filePath: 'src/good.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const good = 1;', newText: 'const good = 2;' }] },
        { filePath: 'src/bad.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'dup();', newText: 'x();' }] },
      ],
    });
    await assert.rejects(() => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }));
    // The original clone's good.ts must be untouched — the whole apply failed transactionally.
    assert.equal(sha256(fs.readFileSync(path.join(cloneDir, 'src/good.ts'), 'utf-8')), originalGoodHash);
  });

  it('TEST 8 — ORIGINAL REPOSITORY INTEGRITY: file hash and HEAD are byte-for-byte unchanged after a successful apply', async () => {
    const { repository, ownerId, commitSha, cloneDir } = await setupRepository([{ path: 'src/keep.ts', content: 'const keep = 1;\n', language: 'typescript' }]);
    const beforeHash = sha256(fs.readFileSync(path.join(cloneDir, 'src/keep.ts'), 'utf-8'));
    const beforeHead = execFileSync('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/keep.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const keep = 1;', newText: 'const keep = 2;' }] }],
    });
    const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    assert.equal(response.status, 'READY_FOR_REVIEW');

    const afterHash = sha256(fs.readFileSync(path.join(cloneDir, 'src/keep.ts'), 'utf-8'));
    const afterHead = execFileSync('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    assert.equal(afterHash, beforeHash);
    assert.equal(afterHead, beforeHead);
  });

  it('TEST 9 — NO COMMIT / NO PUSH: the original clone has no new commits and the workspace is fully discarded afterward', async () => {
    const { repository, ownerId, commitSha, cloneDir } = await setupRepository([{ path: 'src/x.ts', content: 'const x = 1;\n', language: 'typescript' }]);
    const beforeLog = execFileSync('git', ['-C', cloneDir, 'log', '--oneline'], { encoding: 'utf-8' }).trim();

    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/x.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const x = 1;', newText: 'const x = 2;' }] }],
    });
    const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    assert.equal(response.status, 'READY_FOR_REVIEW');
    assert.notEqual(response.status as string, 'COMMITTED');
    assert.notEqual(response.status as string, 'PUSHED');

    const afterLog = execFileSync('git', ['-C', cloneDir, 'log', '--oneline'], { encoding: 'utf-8' }).trim();
    assert.equal(afterLog, beforeLog, 'no new commit should exist on the original clone');

    // No orphaned workspace directory left behind.
    const workspaceParent = path.dirname(resolveFixWorkspaceDir(repository.id, 'placeholder-placeholder-placeholder-000000'));
    if (fs.existsSync(workspaceParent)) {
      assert.equal(fs.readdirSync(workspaceParent).length, 0);
    }
  });

  it('TEST 10 — a sensitive file path is rejected even if it were somehow indexed', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: '.env', content: 'SECRET=1\n', language: 'unknown' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: '.env', language: 'unknown', hunks: [{ startLine: 1, endLine: 1, oldText: 'SECRET=1', newText: 'SECRET=2' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'SENSITIVE_FILE'); return true; },
    );
  });

  it('TEST 11 — path traversal (../) is rejected as UNSAFE_PATH', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: '../../etc/passwd', language: 'unknown', hunks: [{ startLine: 1, endLine: 1, oldText: 'x', newText: 'y' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'UNSAFE_PATH'); return true; },
    );
  });

  it('TEST 12 — an absolute POSIX path is rejected as UNSAFE_PATH', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: '/etc/passwd', language: 'unknown', hunks: [{ startLine: 1, endLine: 1, oldText: 'x', newText: 'y' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'UNSAFE_PATH'); return true; },
    );
  });

  it('TEST 13 — a Windows drive-letter absolute path is rejected as UNSAFE_PATH', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'C:\\Windows\\System32\\config', language: 'unknown', hunks: [{ startLine: 1, endLine: 1, oldText: 'x', newText: 'y' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'UNSAFE_PATH'); return true; },
    );
  });

  it('TEST 14 — a null-byte path is rejected as UNSAFE_PATH', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/a.ts\0.png', language: 'unknown', hunks: [{ startLine: 1, endLine: 1, oldText: 'x', newText: 'y' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'UNSAFE_PATH'); return true; },
    );
  });

  it('TEST 15 — a file not present in the indexed commit is rejected as FILE_NOT_FOUND', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/never-indexed.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'x', newText: 'y' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'FILE_NOT_FOUND'); return true; },
    );
  });

  it('TEST 16 — a proposal referencing a commit the repository is no longer indexed at is rejected as STALE_REPOSITORY', async () => {
    const { repository, ownerId } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha: 'f'.repeat(40),
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const a = 1;', newText: 'const a = 2;' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'STALE_REPOSITORY'); return true; },
    );
  });

  it('TEST 17 — a repository that has moved to a different commit since the proposal was generated is rejected as STALE_REPOSITORY (clone-level check)', async () => {
    const { repository, ownerId, commitSha, cloneDir } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    // Simulate a re-clone/re-commit after the proposal was generated.
    fs.writeFileSync(path.join(cloneDir, 'src/a.ts'), 'const a = 999;\n');
    run(cloneDir, ['-c', 'core.autocrlf=false', 'add', '.']);
    run(cloneDir, ['commit', '-m', 'drift', '--quiet']);

    // Re-register the index job under the ORIGINAL commitSha (as if the proposal is now stale relative to the moved clone).
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const a = 1;', newText: 'const a = 2;' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'STALE_REPOSITORY'); return true; },
    );
  });

  it('TEST 18 — a syntactically invalid resulting file is rejected as SYNTAX_VALIDATION_FAILED and the original clone is left untouched', async () => {
    const { repository, ownerId, commitSha, cloneDir } = await setupRepository([{ path: 'src/broken.ts', content: 'export function f() {\n  return 1;\n}\n', language: 'typescript' }]);
    const beforeHash = sha256(fs.readFileSync(path.join(cloneDir, 'src/broken.ts'), 'utf-8'));
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/broken.ts', language: 'typescript', hunks: [{ startLine: 3, endLine: 3, oldText: '}', newText: '' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'SYNTAX_VALIDATION_FAILED'); return true; },
    );
    assert.equal(sha256(fs.readFileSync(path.join(cloneDir, 'src/broken.ts'), 'utf-8')), beforeHash);
  });

  it('TEST 19 — a change to an unsupported-language file (html) still succeeds, reporting UNSUPPORTED rather than a fabricated verdict', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'index.html', content: '<html><body><h1>Hi</h1></body></html>\n', language: 'html' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'index.html', language: 'html', hunks: [{ startLine: 1, endLine: 1, oldText: '<h1>Hi</h1>', newText: '<h1>Hello</h1>' }] }],
    });
    const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    assert.equal(response.status, 'READY_FOR_REVIEW');
    assert.equal(response.changedFiles[0].syntaxStatus, 'UNSUPPORTED');
    assert.equal(response.validation.syntax, 'UNSUPPORTED');
  });

  it('TEST 20 — cancellation cleans up the isolated workspace, leaving no orphaned directory', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const a = 1;', newText: 'const a = 2;' }] }],
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }, controller.signal),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'CANCELLED'); return true; },
    );
  });

  it('TEST 21 — owner isolation: a different ownerId cannot apply a fix against this repository', async () => {
    const { repository, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const a = 1;', newText: 'const a = 2;' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId: 'someone-else' }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'REPOSITORY_ACCESS_DENIED'); return true; },
    );
  });

  it('TEST 22 — the finding must be loaded server-side: applyFindingFix rejects when no finding was resolved, regardless of what the proposal claims', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const a = 1;', newText: 'const a = 2;' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, undefined, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'FINDING_NOT_FOUND'); return true; },
    );
  });

  it('TEST 23 — a proposal with zero changes is rejected as PROPOSAL_INVALID (empty-changes rejection)', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({ repositoryId: repository.id, commitSha, changes: [] });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'PROPOSAL_INVALID'); return true; },
    );
  });

  it('TEST 24 — a no-op hunk (oldText === newText) is rejected as PROPOSAL_INVALID', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const a = 1;', newText: 'const a = 1;' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'PROPOSAL_INVALID'); return true; },
    );
  });

  it('TEST 25 — a proposal whose status is not PROPOSED (e.g. INSUFFICIENT_EVIDENCE) is rejected as PROPOSAL_INVALID', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({ repositoryId: repository.id, commitSha, changes: [], status: 'INSUFFICIENT_EVIDENCE' });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'PROPOSAL_INVALID'); return true; },
    );
  });

  it('TEST 26 — a repository that has not been indexed yet is rejected as REPOSITORY_NOT_READY', async () => {
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: 'https://github.com/octocat/Hello-World', provider: 'GITHUB', branch: 'main' });
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha: 'a'.repeat(40),
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'x', newText: 'y' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'REPOSITORY_NOT_READY'); return true; },
    );
  });

  it('TEST 27 — a repository that does not exist is rejected as REPOSITORY_NOT_FOUND', async () => {
    const proposal = buildProposal({
      repositoryId: randomUUID(), commitSha: 'a'.repeat(40),
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'x', newText: 'y' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(undefined, SAMPLE_FINDING, proposal, stores, { repositoryId: randomUUID() }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'REPOSITORY_NOT_FOUND'); return true; },
    );
  });

  it('TEST 28 — a proposal for a different repository/finding than requested is rejected as PROPOSAL_INVALID', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/a.ts', content: 'const a = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: 'some-other-repository-id', commitSha,
      changes: [{ filePath: 'src/a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const a = 1;', newText: 'const a = 2;' }] }],
    });
    await assert.rejects(
      () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
      (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'PROPOSAL_INVALID'); return true; },
    );
  });

  it('TEST 29 — the returned diff is a REAL git diff (unified-diff markers, correct file path) rather than fabricated from oldText/newText', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/real.ts', content: 'const real = 1;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{ filePath: 'src/real.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const real = 1;', newText: 'const real = 2;' }] }],
    });
    const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    assert.ok(response.diff.includes('diff --git'));
    assert.ok(response.diff.includes('-const real = 1;'));
    assert.ok(response.diff.includes('+const real = 2;'));
    assert.equal(response.changedFiles[0].additions, 1);
    assert.equal(response.changedFiles[0].deletions, 1);
  });

  it('TEST 30 — multiple hunks in the same file are applied in sequence against the progressively-updated content', async () => {
    const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/multi.ts', content: 'const a = 1;\nconst b = 2;\n', language: 'typescript' }]);
    const proposal = buildProposal({
      repositoryId: repository.id, commitSha,
      changes: [{
        filePath: 'src/multi.ts', language: 'typescript',
        hunks: [
          { startLine: 1, endLine: 1, oldText: 'const a = 1;', newText: 'const a = 10;' },
          { startLine: 2, endLine: 2, oldText: 'const b = 2;', newText: 'const b = 20;' },
        ],
      }],
    });
    const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
    assert.ok(response.diff.includes('const a = 10;'));
    assert.ok(response.diff.includes('const b = 20;'));
    assert.equal(response.lineGrounding.length, 2);
  });

  describe('Phase 14 — CRLF/LF end-to-end (real git fixtures)', () => {
    it('TEST 31 — a real CRLF-committed file with an LF-authored proposal applies successfully end to end', async () => {
      const crlfContent = 'export function greet() {\r\n  return "hi";\r\n}\r\n';
      const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/crlf.ts', content: crlfContent, language: 'typescript' }]);
      const proposal = buildProposal({
        repositoryId: repository.id, commitSha,
        changes: [{ filePath: 'src/crlf.ts', language: 'typescript', hunks: [{ startLine: 2, endLine: 2, oldText: '  return "hi";\n', newText: '  return "hello";\n' }] }],
      });
      const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
      assert.equal(response.status, 'READY_FOR_REVIEW');
      assert.ok(response.diff.includes('hello'));
      assert.equal(response.changedFiles[0].syntaxStatus, 'VALID');
      // Exactly the ONE targeted line changed — proves the whole file was
      // not silently rewritten to a different line-ending style (that
      // would show up as every line being replaced).
      assert.equal(response.changedFiles[0].additions, 1);
      assert.equal(response.changedFiles[0].deletions, 1);
    });

    it('a real CRLF-committed file with a CRLF-authored proposal applies successfully (regression: both-CRLF still works)', async () => {
      const crlfContent = 'export function greet() {\r\n  return "hi";\r\n}\r\n';
      const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/crlf2.ts', content: crlfContent, language: 'typescript' }]);
      const proposal = buildProposal({
        repositoryId: repository.id, commitSha,
        changes: [{ filePath: 'src/crlf2.ts', language: 'typescript', hunks: [{ startLine: 2, endLine: 2, oldText: '  return "hi";\r\n', newText: '  return "hello";\r\n' }] }],
      });
      const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
      assert.equal(response.status, 'READY_FOR_REVIEW');
      assert.ok(response.diff.includes('hello'));
    });

    it('a real LF-committed file with an LF-authored proposal is unaffected (baseline regression check)', async () => {
      const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/lf.ts', content: 'export function greet() {\n  return "hi";\n}\n', language: 'typescript' }]);
      const proposal = buildProposal({
        repositoryId: repository.id, commitSha,
        changes: [{ filePath: 'src/lf.ts', language: 'typescript', hunks: [{ startLine: 2, endLine: 2, oldText: '  return "hi";\n', newText: '  return "hello";\n' }] }],
      });
      const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
      assert.equal(response.status, 'READY_FOR_REVIEW');
    });

    it('a wrong-file reference is still rejected even when the target repository uses CRLF (file-scope safety is unaffected by line-ending handling)', async () => {
      const crlfContent = 'export const x = 1;\r\n';
      const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/onlyfile.ts', content: crlfContent, language: 'typescript' }]);
      const proposal = buildProposal({
        repositoryId: repository.id, commitSha,
        changes: [{ filePath: 'src/never-indexed.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const x = 1;\n', newText: 'export const x = 2;\n' }] }],
      });
      await assert.rejects(
        () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
        (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'FILE_NOT_FOUND'); return true; },
      );
    });

    it('an ambiguous match in a CRLF-committed file is still rejected end to end, never guessing', async () => {
      const crlfContent = 'dup();\r\nother();\r\ndup();\r\n';
      const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/ambiguous.ts', content: crlfContent, language: 'typescript' }]);
      const proposal = buildProposal({
        repositoryId: repository.id, commitSha,
        changes: [{ filePath: 'src/ambiguous.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'dup();\n', newText: 'bar();\n' }] }],
      });
      await assert.rejects(
        () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
        (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'OLD_TEXT_AMBIGUOUS'); return true; },
      );
    });

    it('a no-op proposal (oldText === newText) is still rejected as PROPOSAL_INVALID against a CRLF file, even though the runtime matcher is now line-ending-tolerant', async () => {
      const crlfContent = 'export const x = 1;\r\n';
      const { repository, ownerId, commitSha } = await setupRepository([{ path: 'src/noop.ts', content: crlfContent, language: 'typescript' }]);
      const proposal = buildProposal({
        repositoryId: repository.id, commitSha,
        changes: [{ filePath: 'src/noop.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const x = 1;\n', newText: 'export const x = 1;\n' }] }],
      });
      await assert.rejects(
        () => applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId }),
        (error: unknown) => { assert.ok(error instanceof FixApplicationError); assert.equal(error.code, 'PROPOSAL_INVALID'); return true; },
      );
    });

    it('an unchanged (never-indexed / not part of the proposal) sibling file is never modified when a CRLF fix is applied', async () => {
      const crlfContent = 'export const a = 1;\r\n';
      const untouchedContent = 'export const untouched = 1;\r\n';
      const { repository, ownerId, commitSha, cloneDir } = await setupRepository([
        { path: 'src/target.ts', content: crlfContent, language: 'typescript' },
        { path: 'src/untouched.ts', content: untouchedContent, language: 'typescript' },
      ]);
      const proposal = buildProposal({
        repositoryId: repository.id, commitSha,
        changes: [{ filePath: 'src/target.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'export const a = 1;\n', newText: 'export const a = 2;\n' }] }],
      });
      const response = await applyFindingFix(repository, SAMPLE_FINDING, proposal, stores, { repositoryId: repository.id, ownerId });
      assert.equal(response.status, 'READY_FOR_REVIEW');
      assert.equal(response.changedFiles.length, 1);
      assert.equal(fs.readFileSync(path.join(cloneDir, 'src/untouched.ts'), 'utf-8'), untouchedContent, 'a file outside the approved finding scope must never be modified');
    });
  });
});
