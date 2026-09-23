import { randomUUID } from 'node:crypto';
import type { AuthErrorCode, AuthProvider, AuthUser } from '@origami/contracts';
import type { GitHubProfile } from './auth-github-oauth.js';
import type { GoogleProfile } from './auth-google-oauth.js';
import type { SessionWithUser } from './db/session-repository.js';
import { maybeBootstrapFounder, type FounderBootstrapDeps } from './authorization/founder-bootstrap.js';

export class AuthError extends Error {
  constructor(message: string, public readonly code: AuthErrorCode) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Shared shape both loginWithGitHub and loginWithGoogle write through — one user store, one session store, regardless of which provider authenticated the human. */
export interface AuthUserRepo {
  upsertByProviderAccount(input: {
    id: string;
    primaryProvider: AuthProvider;
    primaryProviderAccountId: string;
    primaryProviderLogin: string;
    email?: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<AuthUser>;
}

export interface AuthSessionRepo {
  create(input: { id: string; userId: string; expiresAt: string }): Promise<void>;
  getValidByIdAndTouch(sessionId: string): Promise<SessionWithUser | undefined>;
  deleteById(sessionId: string): Promise<void>;
}

/**
 * Phase 2 — every login ensures the user has a personal organization
 * (idempotent: a no-op for a returning user who already has one). Optional
 * so the many existing unit tests that only care about session/user
 * creation don't all need a mock for a concern they're not testing; every
 * real caller (index.ts) always provides the real OrganizationRepository.
 */
export interface AuthOrganizationRepo {
  getOrCreatePersonalOrganization(userId: string, displayName: string): Promise<{ id: string }>;
}

export interface AuthServiceDeps {
  userRepo: AuthUserRepo;
  sessionRepo: AuthSessionRepo;
  organizationRepo?: AuthOrganizationRepo;
  /** Optional for the same reason organizationRepo is — most existing unit tests aren't testing Founder bootstrap and shouldn't need to know about it. */
  founderBootstrap?: FounderBootstrapDeps;
  completeGitHubOAuthLogin(code: string, signal?: AbortSignal): Promise<GitHubProfile>;
}

export interface GoogleAuthServiceDeps {
  userRepo: AuthUserRepo;
  sessionRepo: AuthSessionRepo;
  organizationRepo?: AuthOrganizationRepo;
  founderBootstrap?: FounderBootstrapDeps;
  completeGoogleOAuthLogin(code: string, signal?: AbortSignal): Promise<GoogleProfile>;
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getSessionTtlMs(): number {
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

  if (deps.organizationRepo) {
    await deps.organizationRepo.getOrCreatePersonalOrganization(user.id, user.displayName ?? user.primaryProviderLogin);
  }

  const finalUser = deps.founderBootstrap ? await maybeBootstrapFounder(deps.founderBootstrap, user) : user;

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + getSessionTtlMs()).toISOString();
  await deps.sessionRepo.create({ id: sessionId, userId: finalUser.id, expiresAt });

  return { sessionId, expiresAt, user: finalUser };
}

/**
 * The Google equivalent of loginWithGitHub — same session-creation contract,
 * same dependency-injection shape, different profile source. Google's OIDC
 * userinfo has no "login"/username concept (unlike GitHub), so
 * primaryProviderLogin falls back from real name -> email -> the opaque
 * account id, in that order, purely for what gets displayed in the UI; it is
 * never used as an authorization key regardless of provider (see AuthUser's
 * own doc comment in packages/contracts).
 */
export async function loginWithGoogle(code: string, deps: GoogleAuthServiceDeps, signal?: AbortSignal): Promise<LoginResult> {
  const profile = await deps.completeGoogleOAuthLogin(code, signal);

  const user = await deps.userRepo.upsertByProviderAccount({
    id: randomUUID(),
    primaryProvider: 'GOOGLE',
    primaryProviderAccountId: profile.id,
    primaryProviderLogin: profile.name ?? profile.email ?? profile.id,
    email: profile.email ?? undefined,
    displayName: profile.name ?? undefined,
    avatarUrl: profile.avatarUrl ?? undefined,
  });

  if (deps.organizationRepo) {
    await deps.organizationRepo.getOrCreatePersonalOrganization(user.id, user.displayName ?? user.primaryProviderLogin);
  }

  const finalUser = deps.founderBootstrap ? await maybeBootstrapFounder(deps.founderBootstrap, user) : user;

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + getSessionTtlMs()).toISOString();
  await deps.sessionRepo.create({ id: sessionId, userId: finalUser.id, expiresAt });

  return { sessionId, expiresAt, user: finalUser };
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
