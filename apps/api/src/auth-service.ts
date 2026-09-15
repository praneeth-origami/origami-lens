import { randomUUID } from 'node:crypto';
import type { AuthErrorCode, AuthUser } from '@origami/contracts';
import type { GitHubProfile } from './auth-github-oauth.js';
import type { SessionWithUser } from './db/session-repository.js';

export class AuthError extends Error {
  constructor(message: string, public readonly code: AuthErrorCode) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthServiceDeps {
  userRepo: {
    upsertByProviderAccount(input: {
      id: string;
      primaryProvider: 'GITHUB';
      primaryProviderAccountId: string;
      primaryProviderLogin: string;
      email?: string;
      displayName?: string;
      avatarUrl?: string;
    }): Promise<AuthUser>;
  };
  sessionRepo: {
    create(input: { id: string; userId: string; expiresAt: string }): Promise<void>;
    getValidByIdAndTouch(sessionId: string): Promise<SessionWithUser | undefined>;
    deleteById(sessionId: string): Promise<void>;
  };
  completeGitHubOAuthLogin(code: string, signal?: AbortSignal): Promise<GitHubProfile>;
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSessionTtlMs(): number {
  const raw = process.env.SESSION_TTL_MS;
  if (!raw) return DEFAULT_SESSION_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TTL_MS;
}

export interface LoginResult {
  sessionId: string;
  expiresAt: string;
  user: AuthUser;
}

/**
 * The one place a GitHub OAuth code becomes an Origami Lens session.
 * Deliberately takes `deps` (not module-level singletons) so this can be
 * unit-tested with zero real network/DB access — matches the existing
 * repository-fix-workflow-service.ts dependency-injection pattern.
 */
export async function loginWithGitHub(code: string, deps: AuthServiceDeps, signal?: AbortSignal): Promise<LoginResult> {
  const profile = await deps.completeGitHubOAuthLogin(code, signal);

  const user = await deps.userRepo.upsertByProviderAccount({
    id: randomUUID(),
    primaryProvider: 'GITHUB',
    primaryProviderAccountId: String(profile.id),
    primaryProviderLogin: profile.login,
    email: profile.email ?? undefined,
    displayName: profile.name ?? undefined,
    avatarUrl: profile.avatarUrl ?? undefined,
  });

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + getSessionTtlMs()).toISOString();
  await deps.sessionRepo.create({ id: sessionId, userId: user.id, expiresAt });

  return { sessionId, expiresAt, user };
}

export async function resolveSessionUser(sessionId: string | undefined, sessionRepo: AuthServiceDeps['sessionRepo']): Promise<AuthUser | undefined> {
  if (!sessionId) return undefined;
  const session = await sessionRepo.getValidByIdAndTouch(sessionId);
  return session?.user;
}

export async function logout(sessionId: string | undefined, sessionRepo: AuthServiceDeps['sessionRepo']): Promise<void> {
  if (!sessionId) return;
  await sessionRepo.deleteById(sessionId);
}
