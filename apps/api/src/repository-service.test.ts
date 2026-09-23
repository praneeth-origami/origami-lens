import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canAccessRepository, DEFAULT_BRANCH, parseRepositoryUrl, validateBranch } from './repository-service.js';

describe('parseRepositoryUrl', () => {
  it('TEST 1 — accepts a valid GitHub URL', () => {
    const result = parseRepositoryUrl('https://github.com/facebook/react');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.provider, 'GITHUB');
      assert.equal(result.value.normalizedUrl, 'https://github.com/facebook/react');
      assert.equal(result.value.owner, 'facebook');
      assert.equal(result.value.name, 'react');
    }
  });

  it('TEST 2 — accepts a valid GitLab URL', () => {
    const result = parseRepositoryUrl('https://gitlab.com/gitlab-org/gitlab');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.provider, 'GITLAB');
  });

  it('TEST 3 — accepts a valid Bitbucket URL', () => {
    const result = parseRepositoryUrl('https://bitbucket.org/atlassian/python-bitbucket');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.provider, 'BITBUCKET');
  });

  it('TEST 4 — a .git suffix normalizes to the exact same URL as without it', () => {
    const withGit = parseRepositoryUrl('https://github.com/facebook/react.git');
    const withoutGit = parseRepositoryUrl('https://github.com/facebook/react');
    assert.equal(withGit.ok, true);
    assert.equal(withoutGit.ok, true);
    if (withGit.ok && withoutGit.ok) {
      assert.equal(withGit.value.normalizedUrl, withoutGit.value.normalizedUrl);
    }
  });

  it('TEST 5 — rejects a plain HTTP (non-HTTPS) URL', () => {
    const result = parseRepositoryUrl('http://github.com/facebook/react');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /https/i);
  });

  it('TEST 6 — rejects an SSH URL', () => {
    const result = parseRepositoryUrl('ssh://git@github.com/facebook/react.git');
    assert.equal(result.ok, false);
  });

  it('rejects a git:// URL', () => {
    const result = parseRepositoryUrl('git://github.com/facebook/react.git');
    assert.equal(result.ok, false);
  });

  it('rejects a file:// URL', () => {
    const result = parseRepositoryUrl('file:///etc/passwd');
    assert.equal(result.ok, false);
  });

  it('TEST 7 — rejects an arbitrary (unsupported host) URL', () => {
    const result = parseRepositoryUrl('https://example.com/facebook/react');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /github\.com|gitlab\.com|bitbucket\.org/);
  });

  it('rejects a localhost URL (SSRF)', () => {
    const result = parseRepositoryUrl('https://localhost/owner/repo');
    assert.equal(result.ok, false);
  });

  it('rejects a 127.0.0.1 URL (SSRF)', () => {
    const result = parseRepositoryUrl('https://127.0.0.1/owner/repo');
    assert.equal(result.ok, false);
  });

  it('rejects a private-IP URL (SSRF)', () => {
    const result = parseRepositoryUrl('https://192.168.1.1/owner/repo');
    assert.equal(result.ok, false);
  });

  it('rejects a lookalike domain (github.com.attacker.com)', () => {
    const result = parseRepositoryUrl('https://github.com.attacker.com/owner/repo');
    assert.equal(result.ok, false);
  });

  it('TEST 8 — rejects a URL containing embedded credentials', () => {
    const result = parseRepositoryUrl('https://user:password@github.com/facebook/react');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /credential/i);
  });

  it('TEST 9 — rejects a missing repoUrl', () => {
    const result = parseRepositoryUrl('');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /required/i);
  });

  it('rejects a repoUrl with a custom port', () => {
    const result = parseRepositoryUrl('https://github.com:8443/facebook/react');
    assert.equal(result.ok, false);
  });

  it('rejects a URL missing the repo name (owner only)', () => {
    const result = parseRepositoryUrl('https://github.com/facebook');
    assert.equal(result.ok, false);
  });

  it('rejects a URL with extra path segments beyond owner/repo', () => {
    const result = parseRepositoryUrl('https://github.com/facebook/react/tree/main');
    assert.equal(result.ok, false);
  });

  it('strips query string and hash from the normalized URL', () => {
    const result = parseRepositoryUrl('https://github.com/facebook/react?tab=readme#start');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.normalizedUrl, 'https://github.com/facebook/react');
  });
});

describe('validateBranch', () => {
  it('TEST 10 — defaults to "main" when branch is missing', () => {
    const result = validateBranch(undefined);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, DEFAULT_BRANCH);
  });

  it('defaults to "main" when branch is an empty string', () => {
    const result = validateBranch('   ');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, DEFAULT_BRANCH);
  });

  it('accepts a normal branch name', () => {
    const result = validateBranch('develop');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 'develop');
  });

  it('accepts a hierarchical branch name', () => {
    const result = validateBranch('feature/repository-phase-1');
    assert.equal(result.ok, true);
  });

  it('rejects a branch name with unsafe characters', () => {
    const result = validateBranch('main; rm -rf /');
    assert.equal(result.ok, false);
  });

  it('rejects an excessively long branch name', () => {
    const result = validateBranch('a'.repeat(300));
    assert.equal(result.ok, false);
  });
});

describe('canAccessRepository (Phase 16/B — real, strict ownership)', () => {
  it('allows access when the authenticated user id matches the repository owner', () => {
    assert.equal(canAccessRepository('user-a', 'user-a'), true);
  });

  it('denies access when the authenticated user id differs from the repository owner (IDOR)', () => {
    assert.equal(canAccessRepository('user-a', 'user-b'), false);
  });

  it('denies access when the repository has no owner recorded (legacy pre-Phase-16 row) — no longer fails open', () => {
    assert.equal(canAccessRepository(undefined, 'user-b'), false);
  });

  it('denies access when the caller has no authenticated user id — no longer fails open', () => {
    assert.equal(canAccessRepository('user-a', undefined), false);
  });

  it('denies access when neither side has an owner', () => {
    assert.equal(canAccessRepository(undefined, undefined), false);
  });
});
