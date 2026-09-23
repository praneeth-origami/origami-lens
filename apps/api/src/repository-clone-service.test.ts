import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPathInside, resolveCloneDir } from './repository-clone-service.js';

describe('resolveCloneDir', () => {
  const repoId = '11111111-1111-1111-1111-111111111111';
  const jobId = '22222222-2222-2222-2222-222222222222';

  it('builds a path nested under the configured clone root using only the trusted ids', () => {
    const dir = resolveCloneDir(repoId, jobId);
    assert.ok(dir.includes(repoId));
    assert.ok(dir.includes(jobId));
  });

  it('TEST 19 — rejects an id that is not a plausible internal identifier (path traversal attempt via id)', () => {
    assert.throws(() => resolveCloneDir('../../etc', jobId));
    assert.throws(() => resolveCloneDir(repoId, '../../etc/passwd'));
    assert.throws(() => resolveCloneDir('..', jobId));
  });

  it('never derives the clone path from repository name, branch, or URL — only ever from the two id arguments', () => {
    const dir = resolveCloneDir(repoId, jobId);
    assert.ok(!dir.includes('github.com'));
    assert.ok(!dir.includes('facebook'));
  });
});

describe('isPathInside', () => {
  it('accepts the root itself', () => {
    assert.equal(isPathInside('/repo/root', '/repo/root'), true);
  });

  it('accepts a normal nested path', () => {
    assert.equal(isPathInside('/repo/root', '/repo/root/src/index.ts'), true);
  });

  it('TEST 20 — rejects a path that escapes the root via ..', () => {
    assert.equal(isPathInside('/repo/root', '/repo/root/../../etc/passwd'), false);
  });

  it('rejects a sibling directory that merely shares a string prefix', () => {
    // A naive `startsWith` check would incorrectly accept this.
    assert.equal(isPathInside('/repo/root', '/repo/root-evil/secret'), false);
  });

  it('rejects a completely unrelated absolute path', () => {
    assert.equal(isPathInside('/repo/root', '/etc/passwd'), false);
  });
});
