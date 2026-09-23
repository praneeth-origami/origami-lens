import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * REPOSITORY_CLONE_ROOT/REPOSITORY_FIX_WORKSPACE_ROOT are module-level
 * consts computed once at import time — set SCAN_DATA_DIR to a disposable
 * temp dir and only THEN dynamically import, exactly like
 * workers/repository-index-worker.test.ts does for the same reason.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-fix-worktree-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;

const { resolveCloneDir } = await import('./repository-clone-service.js');
const { createFixWorkspace, discardFixWorkspace, resolveFixWorkspaceDir, REPOSITORY_FIX_WORKSPACE_ROOT, StaleRepositoryError } = await import(
  './repository-fix-worktree.js'
);

function run(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeFixtureClone(): { repositoryId: string; cloneJobId: string; cloneDir: string; commitSha: string } {
  const repositoryId = randomUUID();
  const cloneJobId = randomUUID();
  const cloneDir = resolveCloneDir(repositoryId, cloneJobId);
  fs.mkdirSync(cloneDir, { recursive: true });
  run(cloneDir, ['init', '--quiet']);
  run(cloneDir, ['config', 'user.email', 'test@example.com']);
  run(cloneDir, ['config', 'user.name', 'Origami Test']);
  fs.writeFileSync(path.join(cloneDir, 'README.md'), '# fixture\n');
  run(cloneDir, ['add', '.']);
  run(cloneDir, ['commit', '-m', 'initial', '--quiet']);
  const commitSha = execFileSync('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  return { repositoryId, cloneJobId, cloneDir, commitSha };
}

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('resolveFixWorkspaceDir', () => {
  it('builds a path nested under the configured workspace root, distinct from the clone root', () => {
    const repositoryId = randomUUID();
    const applicationId = randomUUID();
    const dir = resolveFixWorkspaceDir(repositoryId, applicationId);
    assert.ok(dir.startsWith(REPOSITORY_FIX_WORKSPACE_ROOT));
    assert.ok(dir.includes(repositoryId));
    assert.ok(dir.includes(applicationId));
  });

  it('TEST 13 — rejects an id that is not a plausible internal identifier (path traversal attempt via id)', () => {
    assert.throws(() => resolveFixWorkspaceDir('../../etc', randomUUID()));
    assert.throws(() => resolveFixWorkspaceDir(randomUUID(), '../../etc/passwd'));
  });
});

describe('createFixWorkspace / discardFixWorkspace', () => {
  it('TEST 14 — copies the clone into an isolated workspace directory that actually exists on disk, independent of the clone', async () => {
    const fixture = makeFixtureClone();
    const applicationId = randomUUID();
    const workspace = await createFixWorkspace({
      repositoryId: fixture.repositoryId,
      applicationId,
      cloneDir: fixture.cloneDir,
      expectedCommitSha: fixture.commitSha,
    });

    assert.ok(fs.existsSync(workspace.workspaceDir));
    assert.ok(fs.existsSync(path.join(workspace.workspaceDir, 'README.md')));
    assert.ok(fs.existsSync(path.join(workspace.workspaceDir, '.git')));

    // Mutating the workspace copy must never touch the original clone.
    fs.writeFileSync(path.join(workspace.workspaceDir, 'README.md'), 'mutated\n');
    assert.equal(fs.readFileSync(path.join(fixture.cloneDir, 'README.md'), 'utf-8'), '# fixture\n');

    discardFixWorkspace(workspace.workspaceDir);
    assert.equal(fs.existsSync(workspace.workspaceDir), false);
  });

  it('TEST 15 — a clone that has moved to a different commit than expected is rejected as stale, never applied against the wrong revision', async () => {
    const fixture = makeFixtureClone();
    await assert.rejects(
      () =>
        createFixWorkspace({
          repositoryId: fixture.repositoryId,
          applicationId: randomUUID(),
          cloneDir: fixture.cloneDir,
          expectedCommitSha: 'f'.repeat(40),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StaleRepositoryError);
        return true;
      },
    );
  });

  it('discardFixWorkspace on a nonexistent directory never throws (best-effort cleanup)', () => {
    assert.doesNotThrow(() => discardFixWorkspace(path.join(REPOSITORY_FIX_WORKSPACE_ROOT, 'does-not-exist', randomUUID())));
  });
});
