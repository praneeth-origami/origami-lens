import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorkflowError,
  branchExistsOnRemote,
  cloneRepository,
  commitStaged,
  createBranch,
  getHeadCommitSha,
  getRemoteDefaultBranch,
  getStatusShort,
  pushBranch,
  scrubGitCredentials,
  stageFiles,
} from './repository-git.js';

/**
 * Exercises the new Phase 12 Git primitives end to end against a real local
 * bare repository acting as `origin` — no network dependency, same
 * "deterministic fixture over a real host" discipline as repository-git.test.ts.
 */

let bareRemote: string;
let workDir: string;

function run(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function countChar(text: string, ch: string): number {
  let count = 0;
  for (const c of text) if (c === ch) count += 1;
  return count;
}

/**
 * Step 13A regression harness: simulates "this host's global Git config has
 * core.autocrlf=<value>" via GIT_CONFIG_GLOBAL (Git 2.32+), completely
 * independent of whatever the real CI/dev machine's actual global config
 * says — the whole point of these tests is that cloneRepository's behavior
 * must NOT depend on that. Restores the real value (or absence) afterward so
 * no other test in this process is affected.
 */
async function withSimulatedGlobalAutocrlf<T>(value: 'true' | 'false' | 'input', fn: () => Promise<T>): Promise<T> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-fake-global-git-config-'));
  const configPath = path.join(configDir, 'gitconfig');
  fs.writeFileSync(configPath, `[core]\n  autocrlf = ${value}\n`);
  const original = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = original;
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

before(() => {
  bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-workflow-remote-'));
  run(bareRemote, ['init', '--bare', '--quiet', '--initial-branch=main']);

  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-workflow-seed-'));
  run(seed, ['init', '--quiet', '--initial-branch=main']);
  run(seed, ['config', 'user.email', 'seed@example.com']);
  run(seed, ['config', 'user.name', 'Seed']);
  fs.writeFileSync(path.join(seed, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(seed, 'app.ts'), 'export const x = 1;\n');
  run(seed, ['add', '.']);
  run(seed, ['commit', '-m', 'initial', '--quiet']);
  run(seed, ['remote', 'add', 'origin', bareRemote]);
  run(seed, ['push', 'origin', 'main']);
  fs.rmSync(seed, { recursive: true, force: true });

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-workflow-work-'));
  execFileSync('git', ['clone', '--quiet', bareRemote, workDir]);
});

after(() => {
  for (const dir of [bareRemote, workDir]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('getRemoteDefaultBranch', () => {
  it('TEST 1 — resolves the remote HEAD symref to the real default branch', async () => {
    const branch = await getRemoteDefaultBranch(workDir);
    assert.equal(branch, 'main');
  });
});

describe('createBranch / branchExistsOnRemote', () => {
  it('TEST 2 — a brand new branch does not yet exist on the remote', async () => {
    assert.equal(await branchExistsOnRemote(workDir, 'ai-fix/does-not-exist-yet'), false);
  });

  it('TEST 3 — creates and checks out a new local branch', async () => {
    await createBranch(workDir, 'ai-fix/test-branch-1');
    const current = run(workDir, ['branch', '--show-current']).trim();
    assert.equal(current, 'ai-fix/test-branch-1');
  });

  it('TEST 4 — creating a branch that already exists locally is rejected as branch_exists', async () => {
    await assert.rejects(
      () => createBranch(workDir, 'ai-fix/test-branch-1'),
      (error: unknown) => {
        assert.ok(error instanceof GitWorkflowError);
        assert.equal(error.cause, 'branch_exists');
        return true;
      },
    );
    run(workDir, ['checkout', 'main', '--quiet']);
    run(workDir, ['branch', '-D', 'ai-fix/test-branch-1']);
  });
});

describe('stageFiles / commitStaged / getStatusShort / pushBranch', () => {
  it('TEST 5/6/9/10/11 — stages only approved files, commits with the given identity, pushes, and the remote receives exactly that commit', async () => {
    await createBranch(workDir, 'ai-fix/full-flow');
    fs.writeFileSync(path.join(workDir, 'app.ts'), 'export const x = 2;\n');
    fs.writeFileSync(path.join(workDir, 'unrelated.ts'), 'export const y = 1;\n');

    const statusBefore = await getStatusShort(workDir);
    const paths = statusBefore.map((s) => s.filePath).sort();
    assert.deepEqual(paths, ['app.ts', 'unrelated.ts']);

    // Only stage the approved file (app.ts), never the unrelated one — proves "never git add ." / never blind staging.
    await stageFiles(workDir, ['app.ts']);
    const cachedFiles = run(workDir, ['diff', '--cached', '--name-only']).trim().split('\n');
    assert.deepEqual(cachedFiles, ['app.ts']);

    await commitStaged(workDir, 'fix: resolve health score calculation issue', 'Origami AI', 'ai@origami.dev');

    const author = run(workDir, ['log', '-1', '--format=%an <%ae>']).trim();
    assert.equal(author, 'Origami AI <ai@origami.dev>');

    const sha = await getHeadCommitSha(workDir);
    assert.match(sha, /^[0-9a-f]{40}$/);

    // unrelated.ts must still be untracked/unstaged — never swept into the commit.
    const statusAfterCommit = await getStatusShort(workDir);
    assert.deepEqual(statusAfterCommit.map((s) => s.filePath), ['unrelated.ts']);

    await pushBranch(workDir, 'ai-fix/full-flow', 'unused-for-local-file-remote');
    assert.equal(await branchExistsOnRemote(workDir, 'ai-fix/full-flow'), true);

    // Verify the remote actually received exactly this commit.
    const remoteSha = run(bareRemote, ['rev-parse', 'refs/heads/ai-fix/full-flow']).trim();
    assert.equal(remoteSha, sha);
    const remoteFiles = run(bareRemote, ['show', '--name-only', '--format=', `${sha}`]).trim().split('\n').filter(Boolean);
    assert.deepEqual(remoteFiles, ['app.ts']);
  });

  it('Phase 13 — pushBranch accepts a provider-specific username (e.g. a Bitbucket account username) instead of defaulting to x-access-token', async () => {
    await createBranch(workDir, 'ai-fix/custom-username');
    fs.writeFileSync(path.join(workDir, 'app.ts'), 'export const x = 3;\n');
    await stageFiles(workDir, ['app.ts']);
    await commitStaged(workDir, 'fix: custom username push', 'Origami AI', 'ai@origami.dev');
    const sha = await getHeadCommitSha(workDir);

    await pushBranch(workDir, 'ai-fix/custom-username', 'unused-for-local-file-remote', undefined, 'origami-bot');

    const remoteSha = run(bareRemote, ['rev-parse', 'refs/heads/ai-fix/custom-username']).trim();
    assert.equal(remoteSha, sha);
  });

  it('TEST 12 — the original main branch on the remote is completely unaffected by the fix branch push', async () => {
    const mainSha = run(bareRemote, ['rev-parse', 'refs/heads/main']).trim();
    const seedFileContent = run(bareRemote, ['show', `${mainSha}:app.ts`]);
    assert.equal(seedFileContent, 'export const x = 1;\n');
  });
});

describe('Step 13A — CRLF/LF commit determinism (cloneRepository must not inherit the host\'s core.autocrlf)', () => {
  function createBareOriginWithFile(fileContent: string): { bareRemote: string } {
    const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-crlf-origin-'));
    run(bareRemote, ['init', '--bare', '--quiet', '--initial-branch=main']);

    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-crlf-seed-'));
    run(seed, ['init', '--quiet', '--initial-branch=main']);
    run(seed, ['config', 'user.email', 'seed@example.com']);
    run(seed, ['config', 'user.name', 'Seed']);
    fs.writeFileSync(path.join(seed, 'app.tsx'), fileContent);
    // core.autocrlf=false at seed time so the fixture's line endings are
    // committed byte-for-byte exactly as written — the seed commit's blob
    // encoding (LF or CRLF) is the "ground truth" each test asserts against.
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.'], { cwd: seed });
    execFileSync('git', ['-c', 'core.autocrlf=false', 'commit', '-m', 'initial', '--quiet'], { cwd: seed });
    run(seed, ['remote', 'add', 'origin', bareRemote]);
    run(seed, ['push', '--quiet', 'origin', 'main']);
    fs.rmSync(seed, { recursive: true, force: true });

    return { bareRemote };
  }

  async function cloneEditStageCommit(
    bareRemote: string,
    simulatedHostAutocrlf: 'true' | 'false' | 'input',
    editFn: (content: string) => string,
  ) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-crlf-work-'));
    await withSimulatedGlobalAutocrlf(simulatedHostAutocrlf, () =>
      cloneRepository(bareRemote, 'main', workDir, new AbortController().signal),
    );

    const filePath = path.join(workDir, 'app.tsx');
    const checkedOutContent = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(filePath, editFn(checkedOutContent), 'utf-8');

    await createBranch(workDir, `ai-fix/crlf-${Math.random().toString(36).slice(2)}`);
    await stageFiles(workDir, ['app.tsx']);
    await commitStaged(workDir, 'fix: one-line insertion', 'Origami AI', 'ai@origami.dev');

    const numstat = run(workDir, ['diff', 'HEAD~1', 'HEAD', '--numstat']).trim();
    const [additions, deletions] = numstat.split('\t').map(Number);
    const committedBlob = run(workDir, ['show', 'HEAD:app.tsx']);

    return { workDir, checkedOutContent, additions, deletions, committedBlob };
  }

  it('Test 1 — LF parent blob, simulated core.autocrlf=true host: clone stays LF, and the commit is a clean +1/-0 with an LF blob', async () => {
    const { bareRemote } = createBareOriginWithFile('line1\nline2\nline3\nline4\nline5\n');

    const workDirLf = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-crlf-checkclone-'));
    await withSimulatedGlobalAutocrlf('true', () => cloneRepository(bareRemote, 'main', workDirLf, new AbortController().signal));
    const checkedOut = fs.readFileSync(path.join(workDirLf, 'app.tsx'), 'utf-8');
    assert.equal(countChar(checkedOut, '\r'), 0, 'even with a simulated core.autocrlf=true host, the clone must check out the real LF blob unchanged');

    const { additions, deletions, committedBlob } = await cloneEditStageCommit(bareRemote, 'true', (content) =>
      content.replace('line2\n', 'line2\nNEWLINE\n'),
    );
    assert.equal(additions, 1, `expected a clean 1-line insertion, got +${additions}/-${deletions}`);
    assert.equal(deletions, 0, `expected zero deletions (no full-file rewrite), got +${additions}/-${deletions}`);
    assert.equal(countChar(committedBlob, '\r'), 0, 'the committed blob must remain pure LF, matching the parent');
  });

  it('Test 2 — CRLF parent blob, CRLF-preserving edit: clean +1/-0, blob stays CRLF', async () => {
    const { bareRemote } = createBareOriginWithFile('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n');

    const { additions, deletions, committedBlob, checkedOutContent } = await cloneEditStageCommit(bareRemote, 'true', (content) =>
      content.replace('line2\r\n', 'line2\r\nNEWLINE\r\n'),
    );
    assert.equal(countChar(checkedOutContent, '\r'), 5, 'the clone must faithfully check out the real CRLF blob, not silently convert it to LF');
    assert.equal(additions, 1, `expected a clean 1-line insertion, got +${additions}/-${deletions}`);
    assert.equal(deletions, 0, `expected zero deletions (no full-file rewrite), got +${additions}/-${deletions}`);
    const lfCount = countChar(committedBlob, '\n');
    const crCount = countChar(committedBlob, '\r');
    assert.equal(crCount, lfCount, 'every line ending in the committed blob must be a full CRLF pair, matching the parent\'s convention');
    assert.equal(crCount, 6, 'six lines (five original + one inserted), all CRLF');
  });

  it('Test 3 — LF parent blob, normal (non-CRLF) host: clean +1/-0', async () => {
    const { bareRemote } = createBareOriginWithFile('line1\nline2\nline3\nline4\nline5\n');

    const { additions, deletions, committedBlob } = await cloneEditStageCommit(bareRemote, 'false', (content) =>
      content.replace('line2\n', 'line2\nNEWLINE\n'),
    );
    assert.equal(additions, 1);
    assert.equal(deletions, 0);
    assert.equal(countChar(committedBlob, '\r'), 0);
  });

  it('Test 4 — a host-dependent line-ending conversion never manifests as unrelated diff lines, whichever direction it would have gone', async () => {
    // Same LF-parent fixture as Test 1, but this time simulate core.autocrlf=input
    // (converts on checkin only) as a third distinct host configuration —
    // the resulting diff must still be exactly the one semantic line, proving
    // the guarantee holds across true/false/input, not just true.
    const { bareRemote } = createBareOriginWithFile('alpha\nbeta\ngamma\ndelta\nepsilon\n');

    const { additions, deletions } = await cloneEditStageCommit(bareRemote, 'input', (content) =>
      content.replace('beta\n', 'beta\nNEWLINE\n'),
    );
    assert.equal(additions, 1, 'no unrelated line-ending-only lines may appear in the diff');
    assert.equal(deletions, 0, 'no unrelated line-ending-only lines may appear in the diff');
  });

  it('Test 5 — TopNav-style multi-line JSX fixture: one aria-label-style insertion produces +1/-0, never a full-file rewrite', async () => {
    const jsx = [
      'export function ThemeSwitcher({ mode, onSelect }) {',
      '  return (',
      '    <div className="theme-switcher" role="group" aria-label="Theme selector">',
      '      {THEME_OPTIONS.map((option) => (',
      '        <button',
      '          key={option}',
      '          type="button"',
      "          className={`theme-option ${mode === option ? 'active' : ''}`}",
      '          onClick={() => onSelect(option)}',
      '          aria-pressed={mode === option}',
      "          title={option === 'system' ? 'System theme' : option === 'light' ? 'Light mode' : 'Dark mode'}",
      '        >',
      '          <ThemeIcon mode={option} />',
      '        </button>',
      '      ))}',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n');
    const { bareRemote } = createBareOriginWithFile(jsx);

    const { additions, deletions, committedBlob } = await cloneEditStageCommit(bareRemote, 'true', (content) =>
      content.replace(
        '          aria-pressed={mode === option}\n',
        "          aria-pressed={mode === option}\n          aria-label={option === 'system' ? 'System theme' : option === 'light' ? 'Light mode' : 'Dark mode'}\n",
      ),
    );
    assert.equal(additions, 1, `expected exactly the one aria-label insertion, got +${additions}/-${deletions}`);
    assert.equal(deletions, 0, `expected no full-file rewrite, got +${additions}/-${deletions}`);
    assert.ok(committedBlob.includes("aria-label={option === 'system'"), 'the intended semantic change must actually be present');
    assert.equal(countChar(committedBlob, '\r'), 0, 'blob must remain pure LF, matching the parent');
  });
});

describe('scrubGitCredentials', () => {
  it('TEST 22 — redacts an AUTHORIZATION header value', () => {
    const scrubbed = scrubGitCredentials('remote: AUTHORIZATION: basic eF9hY2Nlc3MtdG9rZW46c2VjcmV0');
    assert.ok(!scrubbed.includes('eF9hY2Nlc3MtdG9rZW46c2VjcmV0'));
  });

  it('redacts a bare Bearer/Basic token', () => {
    assert.ok(!scrubGitCredentials('failed: Bearer ghp_abcdef1234567890').includes('ghp_abcdef1234567890'));
  });

  it('redacts a known literal secret passed in explicitly', () => {
    const scrubbed = scrubGitCredentials('some error mentioning ghp_supersecrettoken directly', ['ghp_supersecrettoken']);
    assert.ok(!scrubbed.includes('ghp_supersecrettoken'));
  });

  it('redacts an http.extraheader config fragment', () => {
    const scrubbed = scrubGitCredentials("fatal: unable to access 'x' -c http.extraheader=AUTHORIZATION:basic abc123 failed");
    assert.ok(!scrubbed.includes('abc123'));
  });
});
