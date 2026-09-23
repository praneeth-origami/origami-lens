import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Repository } from '@origami/contracts';
import {
  FindingRepositoryMismatchError,
  assertFindingRepositoryMatches,
  resolveRepositoryForIssue,
} from './repository-finding-resolution-service.js';

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: overrides.id ?? 'repo-1',
    organizationId: 'org-1',
    repoUrl: 'https://github.com/acme/repo',
    provider: 'GITHUB',
    branch: 'main',
    status: 'EMBEDDINGS_READY',
    role: 'FULL_STACK',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveRepositoryForIssue', () => {
  it('TEST 1 — no connected repository at all resolves to none', () => {
    const result = resolveRepositoryForIssue({}, []);
    assert.deepEqual(result, { status: 'none' });
  });

  it('TEST 2 — a single connected repository resolves automatically, single-full-stack-repo case', () => {
    const repo = makeRepo({ id: 'repo-full-stack' });
    const result = resolveRepositoryForIssue({}, [repo]);
    assert.deepEqual(result, { status: 'resolved', repository: repo });
  });

  it('TEST 3 — a single connected repository resolves automatically even when only one of FRONTEND/BACKEND has been connected so far', () => {
    const frontend = makeRepo({ id: 'repo-frontend', role: 'FRONTEND' });
    const result = resolveRepositoryForIssue({}, [frontend]);
    assert.deepEqual(result, { status: 'resolved', repository: frontend });
  });

  it('TEST 4 — two connected repositories with no persisted choice is unresolved, never guessed', () => {
    const frontend = makeRepo({ id: 'repo-frontend', role: 'FRONTEND' });
    const backend = makeRepo({ id: 'repo-backend', role: 'BACKEND' });
    const result = resolveRepositoryForIssue({}, [frontend, backend]);
    assert.equal(result.status, 'unresolved');
    if (result.status === 'unresolved') {
      assert.deepEqual(new Set(result.candidates.map((r) => r.id)), new Set(['repo-frontend', 'repo-backend']));
    }
  });

  it('TEST 5 — a finding with an already-persisted repositoryId resolves to that exact repository, even with multiple candidates connected', () => {
    const frontend = makeRepo({ id: 'repo-frontend', role: 'FRONTEND' });
    const backend = makeRepo({ id: 'repo-backend', role: 'BACKEND' });
    const result = resolveRepositoryForIssue({ repositoryId: 'repo-backend' }, [frontend, backend]);
    assert.deepEqual(result, { status: 'resolved', repository: backend });
  });

  it('TEST 6 — a persisted repositoryId that no longer belongs to the caller (deleted, or another org) falls back to normal resolution instead of trusting it', () => {
    const frontend = makeRepo({ id: 'repo-frontend', role: 'FRONTEND' });
    const result = resolveRepositoryForIssue({ repositoryId: 'repo-deleted' }, [frontend]);
    assert.deepEqual(result, { status: 'resolved', repository: frontend });
  });

  it('TEST 7 — a not-yet-indexed repository is not counted as a usable candidate', () => {
    const notReady = makeRepo({ id: 'repo-cloning', status: 'CLONING' });
    const ready = makeRepo({ id: 'repo-ready', status: 'EMBEDDINGS_READY' });
    const result = resolveRepositoryForIssue({}, [notReady, ready]);
    assert.deepEqual(result, { status: 'resolved', repository: ready });
  });

  it('TEST 8 — every candidate not yet indexed resolves to none, not a false single-match', () => {
    const notReady = makeRepo({ id: 'repo-cloning', status: 'CLONING' });
    const result = resolveRepositoryForIssue({}, [notReady]);
    assert.deepEqual(result, { status: 'none' });
  });
});

describe('assertFindingRepositoryMatches', () => {
  it('TEST 9 — a finding with no repositoryId yet never throws (first generation for this finding)', () => {
    assert.doesNotThrow(() => assertFindingRepositoryMatches({}, 'repo-a'));
  });

  it('TEST 10 — a finding whose persisted repositoryId matches the requested one never throws (repeating the same choice)', () => {
    assert.doesNotThrow(() => assertFindingRepositoryMatches({ repositoryId: 'repo-a' }, 'repo-a'));
  });

  it('TEST 11 — a finding whose persisted repositoryId differs from the requested one throws FindingRepositoryMismatchError', () => {
    assert.throws(() => assertFindingRepositoryMatches({ repositoryId: 'repo-a' }, 'repo-b'), FindingRepositoryMismatchError);
  });
});
