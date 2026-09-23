import { randomUUID } from 'node:crypto';
import { RepositoryProviderError } from './repository-provider-client.js';
import type { PushCredentials } from './repository-provider-client.js';
import {
  GitHubAppError,
  findInstallationForRepo,
  getInstallation,
  isGitHubAppConfigured,
  mintInstallationAccessToken,
} from './github-app-auth.js';
import {
  GitLabOAuthError,
  exchangeGitLabCode,
  fetchGitLabProfile,
  isGitLabOAuthConfigured,
  refreshGitLabToken,
} from './gitlab-oauth.js';
import {
  BitbucketOAuthError,
  exchangeBitbucketCode,
  fetchBitbucketProfile,
  isBitbucketOAuthConfigured,
  refreshBitbucketToken,
} from './bitbucket-oauth.js';
import { decryptCredential, encryptCredential } from './credential-encryption.js';
import type { ProviderConnectionRepository } from './db/provider-connection-repository.js';

export interface ProviderConnectionDeps {
  connectionRepo: Pick<ProviderConnectionRepository, 'findActiveForUserAndInstallation' | 'upsertGitHubInstallation'>;
}

export interface GitLabConnectionDeps {
  connectionRepo: Pick<ProviderConnectionRepository, 'findActiveGitLabConnectionForUser' | 'upsertGitLabConnection' | 'updateGitLabTokens'>;
}

export interface BitbucketConnectionDeps {
  connectionRepo: Pick<ProviderConnectionRepository, 'findActiveBitbucketConnectionForUser' | 'upsertBitbucketConnection' | 'updateBitbucketTokens'>;
}

/**
 * The real per-user credential resolution for GitHub (Phase 16/C) —
 * replaces the old global-GITHUB_TOKEN getPushCredentials() path.
 * Resolution chain: which installation covers this exact repo (GitHub's own
 * authority, not something Origami Lens tracks) -> does THIS user actually
 * own that installation (provider_connections) -> mint a fresh, short-lived
 * token. Any failure at any step throws the same RepositoryProviderError
 * categories the rest of the Git workflow already handles — this function
 * introduces no new error-handling surface in repository-fix-workflow-service.ts.
 */
export async function resolveGitHubPushCredentials(
  userId: string,
  owner: string,
  repo: string,
  deps: ProviderConnectionDeps,
  signal?: AbortSignal,
): Promise<PushCredentials> {
  if (!isGitHubAppConfigured()) {
    throw new RepositoryProviderError('GitHub App is not configured (GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY missing).', 'AUTH_NOT_CONFIGURED');
  }

  let installationId: number;
  try {
    installationId = await findInstallationForRepo(owner, repo, signal);
  } catch (error) {
    if (error instanceof GitHubAppError && error.code === 'INSTALLATION_NOT_FOUND') {
      throw new RepositoryProviderError('The GitHub App is not installed on this repository. Connect it from the Origami Lens settings first.', 'AUTH_NOT_CONFIGURED');
    }
    throw new RepositoryProviderError('Failed to resolve the GitHub App installation for this repository.', 'REQUEST_FAILED');
  }

  const connection = await deps.connectionRepo.findActiveForUserAndInstallation(userId, installationId);
  if (!connection) {
    // Deliberately the SAME message/category as "not configured" — never
    // reveal that a DIFFERENT user owns this installation (that would leak
    // information about another user's account to this caller).
    throw new RepositoryProviderError('GitHub App authorization is not configured for this repository.', 'AUTH_NOT_CONFIGURED');
  }

  try {
    const { token } = await mintInstallationAccessToken(installationId, signal);
    return { username: 'x-access-token', token };
  } catch {
    throw new RepositoryProviderError('Failed to obtain a GitHub App installation access token.', 'AUTH_FAILED');
  }
}

/**
 * Completes the "Connect GitHub" flow: after the user installs the App and
 * GitHub redirects back with a real installation_id, this records which
 * Origami Lens user that installation belongs to. Never trusts a
 * client-supplied user — `userId` here is always request.user.id from the
 * authenticated session, matching every other Phase 16 write path.
 */
export async function connectGitHubInstallation(
  userId: string,
  installationId: number,
  deps: ProviderConnectionDeps & { fetchInstallation?: typeof getInstallation },
  signal?: AbortSignal,
): Promise<void> {
  const fetchInstallation = deps.fetchInstallation ?? getInstallation;
  const installation = await fetchInstallation(installationId, signal);
  await deps.connectionRepo.upsertGitHubInstallation({
    id: randomUUID(),
    userId,
    installationId: installation.id,
    externalAccountLogin: installation.accountLogin,
  });
}

/**
 * Completes the "Connect GitLab" OAuth flow: exchanges the real
 * authorization code for a real access/refresh token pair, encrypts both
 * before persisting, and records the connection against `userId` — always
 * request.user.id from the authenticated callback request, never a
 * client-supplied value (see index.ts's /providers/gitlab/callback).
 */
export async function connectGitLabAccount(
  userId: string,
  code: string,
  deps: GitLabConnectionDeps & { exchangeCode?: typeof exchangeGitLabCode; fetchProfile?: typeof fetchGitLabProfile },
  signal?: AbortSignal,
): Promise<void> {
  const exchangeCode = deps.exchangeCode ?? exchangeGitLabCode;
  const fetchProfile = deps.fetchProfile ?? fetchGitLabProfile;

  const tokens = await exchangeCode(code);
  const profile = await fetchProfile(tokens.accessToken, signal);

  await deps.connectionRepo.upsertGitLabConnection({
    id: randomUUID(),
    userId,
    externalAccountLogin: profile.username,
    encryptedAccessToken: encryptCredential(tokens.accessToken),
    encryptedRefreshToken: encryptCredential(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
  });
}

/** A small safety margin before the token's real expiry, so a request never starts with a token that could expire mid-flight. */
const GITLAB_TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

/**
 * The real per-user credential resolution for GitLab (Phase 16/D) —
 * replaces the global-GITLAB_TOKEN getPushCredentials() path. Resolves
 * THIS user's own GitLab OAuth connection (never another user's),
 * transparently refreshing an expired access token (persisting GitLab's
 * newly-rotated refresh token immediately — GitLab invalidates the old one
 * the instant a refresh succeeds). Returns the raw decrypted access token;
 * the caller (repository-gitlab-provider-client.ts) decides how to use it
 * (Bearer header for the API, oauth2/token pair for git push) and must
 * never log or persist it itself.
 */
export async function resolveGitLabAccessToken(
  userId: string,
  deps: GitLabConnectionDeps & { refreshToken?: typeof refreshGitLabToken },
  _signal?: AbortSignal,
): Promise<string> {
  if (!isGitLabOAuthConfigured()) {
    throw new RepositoryProviderError('GitLab OAuth is not configured (GITLAB_OAUTH_CLIENT_ID/GITLAB_OAUTH_CLIENT_SECRET/GITLAB_OAUTH_REDIRECT_URI missing).', 'AUTH_NOT_CONFIGURED');
  }

  const connection = await deps.connectionRepo.findActiveGitLabConnectionForUser(userId);
  if (!connection || !connection.encryptedAccessToken || !connection.encryptedRefreshToken || !connection.tokenExpiresAt) {
    throw new RepositoryProviderError('GitLab authorization is not configured for this user. Connect GitLab from Origami Lens settings first.', 'AUTH_NOT_CONFIGURED');
  }

  const expiresAtMs = new Date(connection.tokenExpiresAt).getTime();
  if (Date.now() < expiresAtMs - GITLAB_TOKEN_EXPIRY_SAFETY_MARGIN_MS) {
    return decryptCredential(connection.encryptedAccessToken);
  }

  // Expired (or expiring imminently) — refresh, using the SAME code path
  // real usage would (never silently falling back to a stale token).
  const refresh = deps.refreshToken ?? refreshGitLabToken;
  try {
    const refreshed = await refresh(decryptCredential(connection.encryptedRefreshToken));
    await deps.connectionRepo.updateGitLabTokens(
      connection.id,
      encryptCredential(refreshed.accessToken),
      encryptCredential(refreshed.refreshToken),
      refreshed.expiresAt,
    );
    return refreshed.accessToken;
  } catch (error) {
    if (error instanceof GitLabOAuthError) {
      throw new RepositoryProviderError('GitLab authorization has expired and could not be refreshed. Reconnect GitLab from Origami Lens settings.', 'AUTH_NOT_CONFIGURED');
    }
    throw new RepositoryProviderError('Failed to refresh the GitLab authorization.', 'AUTH_FAILED');
  }
}

/**
 * Completes the "Connect Bitbucket" OAuth flow — same shape as
 * connectGitLabAccount, adapted to Bitbucket's own OAuth consumer
 * protocol (see bitbucket-oauth.ts).
 */
export async function connectBitbucketAccount(
  userId: string,
  code: string,
  deps: BitbucketConnectionDeps & { exchangeCode?: typeof exchangeBitbucketCode; fetchProfile?: typeof fetchBitbucketProfile },
  signal?: AbortSignal,
): Promise<void> {
  const exchangeCode = deps.exchangeCode ?? exchangeBitbucketCode;
  const fetchProfile = deps.fetchProfile ?? fetchBitbucketProfile;

  const tokens = await exchangeCode(code);
  const profile = await fetchProfile(tokens.accessToken, signal);

  await deps.connectionRepo.upsertBitbucketConnection({
    id: randomUUID(),
    userId,
    externalAccountLogin: profile.username,
    encryptedAccessToken: encryptCredential(tokens.accessToken),
    encryptedRefreshToken: encryptCredential(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
  });
}

const BITBUCKET_TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

/**
 * The real per-user credential resolution for Bitbucket (Phase 16/E) —
 * replaces the global-BITBUCKET_USERNAME/BITBUCKET_TOKEN path. Resolves
 * THIS user's own Bitbucket OAuth connection (never another user's),
 * transparently refreshing an expired access token. Unlike GitLab,
 * Bitbucket does not guarantee a new refresh_token on every refresh — the
 * existing (still-encrypted) refresh token is kept unless Bitbucket
 * actually issued a new one, per its documented, non-mandatory rotation.
 * Returns the raw decrypted access token; the caller
 * (repository-bitbucket-provider-client.ts) must never log or persist it
 * itself.
 */
export async function resolveBitbucketAccessToken(
  userId: string,
  deps: BitbucketConnectionDeps & { refreshToken?: typeof refreshBitbucketToken },
  _signal?: AbortSignal,
): Promise<string> {
  if (!isBitbucketOAuthConfigured()) {
    throw new RepositoryProviderError('Bitbucket OAuth is not configured (BITBUCKET_OAUTH_CLIENT_ID/BITBUCKET_OAUTH_CLIENT_SECRET/BITBUCKET_OAUTH_REDIRECT_URI missing).', 'AUTH_NOT_CONFIGURED');
  }

  const connection = await deps.connectionRepo.findActiveBitbucketConnectionForUser(userId);
  if (!connection || !connection.encryptedAccessToken || !connection.encryptedRefreshToken || !connection.tokenExpiresAt) {
    throw new RepositoryProviderError('Bitbucket authorization is not configured for this user. Connect Bitbucket from Origami Lens settings first.', 'AUTH_NOT_CONFIGURED');
  }

  const expiresAtMs = new Date(connection.tokenExpiresAt).getTime();
  if (Date.now() < expiresAtMs - BITBUCKET_TOKEN_EXPIRY_SAFETY_MARGIN_MS) {
    return decryptCredential(connection.encryptedAccessToken);
  }

  const refresh = deps.refreshToken ?? refreshBitbucketToken;
  try {
    const currentRefreshToken = decryptCredential(connection.encryptedRefreshToken);
    const refreshed = await refresh(currentRefreshToken);
    // Bitbucket may or may not issue a new refresh token — adopt it only
    // when present, otherwise keep re-encrypting the SAME still-valid one
    // (never silently drop it, since that would strand the connection).
    const nextRefreshToken = refreshed.refreshToken ?? currentRefreshToken;
    await deps.connectionRepo.updateBitbucketTokens(
      connection.id,
      encryptCredential(refreshed.accessToken),
      encryptCredential(nextRefreshToken),
      refreshed.expiresAt,
    );
    return refreshed.accessToken;
  } catch (error) {
    if (error instanceof BitbucketOAuthError) {
      throw new RepositoryProviderError('Bitbucket authorization has expired and could not be refreshed. Reconnect Bitbucket from Origami Lens settings.', 'AUTH_NOT_CONFIGURED');
    }
    throw new RepositoryProviderError('Failed to refresh the Bitbucket authorization.', 'AUTH_FAILED');
  }
}
