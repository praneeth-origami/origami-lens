import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRepositoryProvider } from './repository-provider-resolver.js';
import { RepositoryProviderError } from './repository-provider-client.js';
import { GitHubProviderClient } from './repository-github-provider-client.js';
import { GitLabProviderClient } from './repository-gitlab-provider-client.js';
import { BitbucketProviderClient } from './repository-bitbucket-provider-client.js';

describe('resolveRepositoryProvider', () => {
  it('TEST 1 — GITHUB resolves to a GitHubProviderClient', () => {
    const client = resolveRepositoryProvider('GITHUB');
    assert.ok(client instanceof GitHubProviderClient);
    assert.equal(client.provider, 'GITHUB');
  });

  it('TEST 2 — GITLAB resolves to a GitLabProviderClient', () => {
    const client = resolveRepositoryProvider('GITLAB');
    assert.ok(client instanceof GitLabProviderClient);
    assert.equal(client.provider, 'GITLAB');
  });

  it('TEST 3 — BITBUCKET resolves to a BitbucketProviderClient', () => {
    const client = resolveRepositoryProvider('BITBUCKET');
    assert.ok(client instanceof BitbucketProviderClient);
    assert.equal(client.provider, 'BITBUCKET');
  });

  it('TEST 4 — an unrecognized provider throws an explicit RepositoryProviderError(PROVIDER_UNSUPPORTED), never silently falling back', () => {
    assert.throws(
      () => resolveRepositoryProvider('UNKNOWN_HOST'),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryProviderError);
        assert.equal(error.category, 'PROVIDER_UNSUPPORTED');
        return true;
      },
    );
  });

  it('resolving the same provider twice returns the same (stateless, reusable) instance', () => {
    const a = resolveRepositoryProvider('GITHUB');
    const b = resolveRepositoryProvider('GITHUB');
    assert.equal(a, b);
  });

  it('an empty string is rejected as PROVIDER_UNSUPPORTED', () => {
    assert.throws(() => resolveRepositoryProvider(''), (error: unknown) => error instanceof RepositoryProviderError && error.category === 'PROVIDER_UNSUPPORTED');
  });
});
