import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitCloneError, cloneRepository, getCommitSha, sanitizeGitError } from './repository-git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * These tests exercise real `git` process invocation end to end against a
 * local, deterministic fixture repository instead of a real GitHub/GitLab/
 * Bitbucket host, per the Phase 2 spec's "prefer deterministic fixtures ...
 * rather than making the test suite dependent on GitHub availability."
 * `cloneRepository`/`getCommitSha` are themselves host-agnostic — they only
 * ever see the already-normalized, already-host-allowlisted URL that
 * repository-service.ts's parseRepositoryUrl produced, so exercising them
 * against a local repo validates the exact same code path a real
 * github.com/gitlab.com/bitbucket.org clone would take.
 */

let fixtureRepo: string;
let workDir: string;
const cloneTargets: string[] = [];

function run(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

before(() => {
  fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-git-fixture-'));
  run(fixtureRepo, ['init', '--quiet']);
  run(fixtureRepo, ['config', 'user.email', 'test@example.com']);
  run(fixtureRepo, ['config', 'user.name', 'Origami Test']);
  run(fixtureRepo, ['checkout', '-b', 'main']);
  fs.writeFileSync(path.join(fixtureRepo, 'README.md'), '# fixture\n');
  run(fixtureRepo, ['add', '.']);
  run(fixtureRepo, ['commit', '-m', 'initial']);
  run(fixtureRepo, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(fixtureRepo, 'feature.txt'), 'feature branch file\n');
  run(fixtureRepo, ['add', '.']);
  run(fixtureRepo, ['commit', '-m', 'feature commit']);
  run(fixtureRepo, ['checkout', 'main']);

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-git-clone-target-'));
});

after(() => {
  for (const dir of [fixtureRepo, workDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function targetDir(name: string): string {
  const dir = path.join(workDir, name);
  cloneTargets.push(dir);
  return dir;
}

describe('cloneRepository', () => {
  it('TEST 1/2/3 — clones the requested branch (host-agnostic mechanics shared by every allowlisted provider)', async () => {
    const dir = targetDir('main-clone');
    await cloneRepository(fixtureRepo, 'main', dir, new AbortController().signal);
    assert.ok(fs.existsSync(path.join(dir, 'README.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'feature.txt')));
  });

  it('checks out the exact branch requested, never a different one', async () => {
    const dir = targetDir('feature-clone');
    await cloneRepository(fixtureRepo, 'feature', dir, new AbortController().signal);
    assert.ok(fs.existsSync(path.join(dir, 'feature.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'README.md')));
  });

  it('TEST 8 — an invalid/nonexistent branch is rejected, not silently substituted', async () => {
    const dir = targetDir('bad-branch-clone');
    await assert.rejects(
      () => cloneRepository(fixtureRepo, 'does-not-exist', dir, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof GitCloneError);
        assert.equal(error.cause, 'branch_not_found');
        return true;
      },
    );
    assert.ok(!fs.existsSync(path.join(dir, 'README.md')), 'a failed clone must not leave usable content behind');
  });

  it('TEST 14 — an already-aborted signal cancels the clone instead of proceeding', async () => {
    const dir = targetDir('aborted-clone');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => cloneRepository(fixtureRepo, 'main', dir, controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof GitCloneError);
        assert.equal(error.cause, 'aborted');
        return true;
      },
    );
  });

  it('never invokes a shell and never interpolates the url/branch into a command string (structural regression guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'repository-git.ts'), 'utf-8');
    assert.ok(!/shell\s*:\s*true/.test(source), 'must never set shell: true');
    assert.ok(!/\bexec\(/.test(source), 'must use execFile, never exec (which runs through a shell)');
    assert.ok(source.includes('execFile('), 'must invoke git via execFile with an argv array');
  });

  it('Phase 14 — the whole module never stages the entire working tree ("git add .") and never places a token directly in a remote URL (structural regression guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'repository-git.ts'), 'utf-8');
    assert.ok(!/['"]add['"]\s*,\s*['"]\.['"]/.test(source), 'must never `git add .` — only exact approved file paths');
    assert.ok(!/['"]add['"]\s*,\s*['"]-A['"]/.test(source), 'must never `git add -A` either');
    assert.ok(!/https?:\/\/\$\{/.test(source), 'must never build a remote URL with an interpolated credential');
    assert.ok(source.includes('http.extraheader'), 'push authentication must go through http.extraheader, not the URL');
  });
});

describe('getCommitSha', () => {
  it('TEST 15 — returns the actual checked-out commit SHA, matching the source repo', async () => {
    const dir = targetDir('sha-clone');
    await cloneRepository(fixtureRepo, 'main', dir, new AbortController().signal);
    const sha = await getCommitSha(dir);
    const expected = execFileSync('git', ['-C', fixtureRepo, 'rev-parse', 'main'], { encoding: 'utf-8' }).trim();
    assert.equal(sha, expected);
    assert.match(sha, /^[0-9a-f]{40}$/);
  });
});

describe('sanitizeGitError', () => {
  it('strips embedded credentials from a URL that leaked into stderr', () => {
    const sanitized = sanitizeGitError("fatal: could not read Username for 'https://user:pass@github.com/owner/repo'");
    assert.ok(!sanitized.includes('user:pass'));
    assert.ok(sanitized.includes('github.com/owner/repo'));
  });

  it('collapses whitespace and truncates very long messages', () => {
    const sanitized = sanitizeGitError('a'.repeat(1000));
    assert.ok(sanitized.length <= 501);
  });
});
