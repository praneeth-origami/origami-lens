import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixBranchName, isValidBranchName, sanitizeBranchName } from './repository-fix-branch.js';

describe('buildFixBranchName', () => {
  it('TEST 1 — builds a deterministic ai-fix/<short-id>-<slug> branch name', () => {
    const branch = buildFixBranchName('b7af3480-299f-484e-af27-5c5e3de1ef4b', 'Health Score Calculation Is Wrong');
    assert.equal(branch, 'ai-fix/b7af3480-health-score-calculation-is-wrong');
    assert.ok(isValidBranchName(branch));
  });

  it('TEST 2 — is deterministic: same inputs always produce the same branch name', () => {
    const a = buildFixBranchName('finding-1', 'Missing form label');
    const b = buildFixBranchName('finding-1', 'Missing form label');
    assert.equal(a, b);
  });

  it('TEST 3 — never uses the raw client-provided title directly: shell/ref metacharacters are stripped', () => {
    const branch = buildFixBranchName('finding-1', '; rm -rf / #evil~^:?*[\\ title');
    assert.ok(isValidBranchName(branch));
    assert.ok(!branch.includes(';'));
    assert.ok(!branch.includes('~'));
    assert.ok(!branch.includes('^'));
    assert.ok(!branch.includes(':'));
    assert.ok(!branch.includes('?'));
    assert.ok(!branch.includes('*'));
    assert.ok(!branch.includes('['));
    assert.ok(!branch.includes('\\'));
  });

  it('TEST 4 — path traversal sequences in the title never survive into the branch name', () => {
    const branch = buildFixBranchName('finding-1', '../../etc/passwd');
    assert.ok(!branch.includes('..'));
    assert.ok(isValidBranchName(branch));
  });

  it('TEST 5 — branch length is bounded even for a very long title', () => {
    const branch = buildFixBranchName('finding-1', 'word '.repeat(200));
    assert.ok(branch.length <= 100);
    assert.ok(isValidBranchName(branch));
  });

  it('TEST 6 — a collision suffix is appended deterministically and stays valid', () => {
    const first = buildFixBranchName('finding-1', 'Missing label', 1);
    const second = buildFixBranchName('finding-1', 'Missing label', 2);
    assert.notEqual(first, second);
    assert.equal(second, `${first}-2`);
    assert.ok(isValidBranchName(second));
  });

  it('an empty/unusable title still produces a valid, non-empty branch name', () => {
    const branch = buildFixBranchName('finding-1', '!!!###   ');
    assert.ok(isValidBranchName(branch));
    assert.ok(branch.startsWith('ai-fix/'));
  });
});

describe('sanitizeBranchName / isValidBranchName', () => {
  it('TEST 7 — rejects a name beginning with "-" (parsed as a CLI flag by some Git subcommands)', () => {
    assert.equal(isValidBranchName('-evil-branch'), false);
  });

  it('rejects names with ".." or "//" segments', () => {
    assert.equal(isValidBranchName('ai-fix/../escape'), false);
    assert.equal(isValidBranchName('ai-fix//double-slash'), false);
  });

  it('rejects a name ending in ".lock"', () => {
    assert.equal(isValidBranchName('ai-fix/foo.lock'), false);
  });

  it('rejects an empty name and an overlong name', () => {
    assert.equal(isValidBranchName(''), false);
    assert.equal(isValidBranchName('a'.repeat(200)), false);
  });

  it('sanitizeBranchName never returns a name starting with "-" even for pathological input', () => {
    const sanitized = sanitizeBranchName('---evil');
    assert.ok(!sanitized.startsWith('-'));
  });

  it('accepts a normal, already-safe branch name', () => {
    assert.equal(isValidBranchName('ai-fix/b7af3480-missing-label'), true);
  });
});
