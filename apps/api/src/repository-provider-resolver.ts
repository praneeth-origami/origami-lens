import type { RepositoryFixPrProvider } from '@origami/contracts';
import { RepositoryProviderError, type RepositoryProviderClient } from './repository-provider-client.js';
import { GitHubProviderClient } from './repository-github-provider-client.js';
import { GitLabProviderClient } from './repository-gitlab-provider-client.js';
import { BitbucketProviderClient } from './repository-bitbucket-provider-client.js';

/**
 * The ONLY place in this codebase that maps a repository's `provider` value
 * onto a concrete RepositoryProviderClient implementation. Every consumer —
 * repository-fix-workflow-service.ts included — depends on this function's
 * return type (the RepositoryProviderClient interface), never on
 * GitHubProviderClient/GitLabProviderClient/BitbucketProviderClient
 * directly. Adding a fourth provider later means adding one case here, not
 * touching the workflow service at all.
 *
 * Each client is stateless (every credential/config read happens fresh,
 * per call, from process.env — see each provider file) so a single
 * module-level instance per provider is safe to reuse across every request.
 */
const providers: Record<RepositoryFixPrProvider, RepositoryProviderClient> = {
  GITHUB: new GitHubProviderClient(),
  GITLAB: new GitLabProviderClient(),
  BITBUCKET: new BitbucketProviderClient(),
};

export function resolveRepositoryProvider(provider: string): RepositoryProviderClient {
  const client = (providers as Record<string, RepositoryProviderClient>)[provider];
  if (!client) {
    throw new RepositoryProviderError(`No Git hosting provider integration is available for "${provider}".`, 'PROVIDER_UNSUPPORTED');
  }
  return client;
}
