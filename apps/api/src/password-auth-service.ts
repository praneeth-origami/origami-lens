import { randomUUID, createHash, randomBytes } from 'node:crypto';
import type { AuthErrorCode, AuthUser } from '@origami/contracts';
import { hashPassword, verifyPassword } from './password-hash.js';
import { getSessionTtlMs, type AuthSessionRepo, type AuthOrganizationRepo, type LoginResult } from './auth-service.js';
import { EmailNotConfiguredError } from './email-service.js';
import { maybeBootstrapFounder, type FounderBootstrapDeps } from './authorization/founder-bootstrap.js';
import { normalizeEmail } from './shared/normalize-email.js';

export class PasswordAuthError extends Error {
  constructor(message: string, public readonly code: AuthErrorCode) {
    super(message);
    this.name = 'PasswordAuthError';
  }
}

/** Same shape auth-service.ts's AuthUserRepo interfaces, extended with the email/password-specific methods db/user-repository.ts adds. Kept as its own interface (rather than widening AuthUserRepo) so auth-service.ts's existing GitHub/Google DI tests never need to know about password concerns at all. */
export interface PasswordAuthUserRepo {
  findByEmail(email: string): Promise<AuthUser | undefined>;
  findByEmailWithPasswordHash(email: string): Promise<{ user: AuthUser; passwordHash: string | null } | undefined>;
  createEmailUser(input: { id: string; email: string; displayName: string; passwordHash: string }): Promise<AuthUser>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  getById(id: string): Promise<AuthUser | undefined>;
  updateEmailVerified(id: string): Promise<void>;
}

export interface PasswordResetTokenRepo {
  create(input: { id: string; userId: string; tokenHash: string; expiresAt: string }): Promise<void>;
  findValidByTokenHash(tokenHash: string): Promise<{ id: string; userId: string; expiresAt: string } | undefined>;
  markUsed(id: string): Promise<void>;
}

/** Same shape as PasswordResetTokenRepo — a separate interface (rather than reusing it) since these are two different tables/token spaces. */
export type EmailVerificationTokenRepo = PasswordResetTokenRepo;

/**
 * Additive only — see VerifyEmailRequest's doc comment in contracts. A
 * single optional nested dependency (rather than several top-level optional
 * fields) so every existing registerWithEmail test continues to pass
 * unchanged; a real caller (index.ts) always provides it.
 */
export interface EmailVerificationDeps {
  tokenRepo: EmailVerificationTokenRepo;
  sendEmailVerificationEmail(to: string, data: { verificationUrl: string }): Promise<void>;
  webAppBaseUrl: string;
}

export interface PasswordAuthDeps {
  userRepo: PasswordAuthUserRepo;
  sessionRepo: AuthSessionRepo;
  organizationRepo?: AuthOrganizationRepo;
  founderBootstrap?: FounderBootstrapDeps;
  emailVerification?: EmailVerificationDeps;
}

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — longer-lived than a password reset link, since there's no security-sensitive action behind it.

async function sendVerificationEmailBestEffort(userId: string, to: string, deps: EmailVerificationDeps): Promise<void> {
  try {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();
    await deps.tokenRepo.create({ id: randomUUID(), userId, tokenHash, expiresAt });

    const verificationUrl = `${deps.webAppBaseUrl}/verify-email?token=${rawToken}`;
    await deps.sendEmailVerificationEmail(to, { verificationUrl });
  } catch (error) {
    console.error('[password-auth-service] Failed to send verification email:', error instanceof Error ? error.message : error);
  }
}

export interface PasswordResetDeps {
  userRepo: PasswordAuthUserRepo;
  tokenRepo: PasswordResetTokenRepo;
  sendPasswordResetEmail(to: string, resetUrl: string): Promise<void>;
  /** Best-effort confirmation sent once the password is actually changed — same never-throw contract as sendPasswordResetEmail's callers below (see resetPassword). */
  sendPasswordChangedEmail(to: string, data: { changedAt: string; webAppBaseUrl: string }): Promise<void>;
  /** Base URL the reset link is built against — always WEB_APP_BASE_URL from index.ts, injected so this stays unit-testable without importing index.ts. */
  webAppBaseUrl: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Deliberately modest — long enough to block trivially-guessable passwords without demanding a specific character-class mix that mostly just annoys users and pushes them toward "Password1!"-style patterns. */
function validatePassword(password: string): void {
  if (password.length < 8) {
    throw new PasswordAuthError('Password must be at least 8 characters.', 'WEAK_PASSWORD');
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new PasswordAuthError('Password must contain at least one letter and one number.', 'WEAK_PASSWORD');
  }
}

async function createSessionFor(
  user: AuthUser,
  deps: { sessionRepo: AuthSessionRepo; founderBootstrap?: FounderBootstrapDeps },
): Promise<LoginResult> {
  const finalUser = deps.founderBootstrap ? await maybeBootstrapFounder(deps.founderBootstrap, user) : user;
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + getSessionTtlMs()).toISOString();
  await deps.sessionRepo.create({ id: sessionId, userId: finalUser.id, expiresAt });
  return { sessionId, expiresAt, user: finalUser };
}

/** Mirrors auth-service.ts's loginWithGitHub/loginWithGoogle shape exactly — same LoginResult, same "ensure personal organization" step, same session-creation tail. */
export async function registerWithEmail(
  input: { email: string; password: string; displayName: string },
  deps: PasswordAuthDeps,
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) {
    throw new PasswordAuthError('Enter a valid email address.', 'INVALID_CREDENTIALS');
  }
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new PasswordAuthError('Enter your name.', 'INVALID_CREDENTIALS');
  }
  validatePassword(input.password);

  const existing = await deps.userRepo.findByEmail(email);
  if (existing) {
    throw new PasswordAuthError('An account with this email already exists.', 'EMAIL_ALREADY_REGISTERED');
  }

  const passwordHash = await hashPassword(input.password);
  const user = await deps.userRepo.createEmailUser({ id: randomUUID(), email, displayName, passwordHash });

  if (deps.organizationRepo) {
    await deps.organizationRepo.getOrCreatePersonalOrganization(user.id, user.displayName ?? email);
  }

  if (deps.emailVerification) {
    await sendVerificationEmailBestEffort(user.id, email, deps.emailVerification);
  }

  return createSessionFor(user, deps);
}

/**
 * Deliberately throws the SAME error/code for "no account with this email"
 * and "wrong password" — this is the one place account enumeration would
 * otherwise leak (a different message for each case tells an attacker which
 * emails have an account at all).
 */
export async function loginWithEmail(input: { email: string; password: string }, deps: PasswordAuthDeps): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const found = await deps.userRepo.findByEmailWithPasswordHash(email);
  const invalid = () => new PasswordAuthError('Incorrect email or password.', 'INVALID_CREDENTIALS');

  if (!found || !found.passwordHash) throw invalid();
  const valid = await verifyPassword(input.password, found.passwordHash);
  if (!valid) throw invalid();

  return createSessionFor(found.user, deps);
}

/**
 * Always resolves successfully regardless of whether the email exists (the
 * caller/route must not branch on this) — an unknown email is a silent
 * no-op; a real email fails closed only in the sense that the underlying
 * EmailNotConfiguredError is logged, never surfaced to the caller (surfacing
 * it would itself leak "this account exists" for a configured-but-erroring
 * send, and there is no legitimate reason to tell an anonymous requester
 * whether sending succeeded).
 */
export async function requestPasswordReset(email: string, deps: PasswordResetDeps): Promise<void> {
  const normalized = normalizeEmail(email);
  const user = await deps.userRepo.findByEmail(normalized);
  if (!user) return;

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await deps.tokenRepo.create({ id: randomUUID(), userId: user.id, tokenHash, expiresAt });

  const resetUrl = `${deps.webAppBaseUrl}/reset-password?token=${rawToken}`;
  try {
    await deps.sendPasswordResetEmail(normalized, resetUrl);
  } catch (error) {
    if (error instanceof EmailNotConfiguredError) {
      console.error('[password-auth-service] Password reset requested but email sending is not configured:', error.message);
      return;
    }
    console.error('[password-auth-service] Failed to send password reset email:', error instanceof Error ? error.message : error);
  }
}

export async function resetPassword(
  token: string,
  newPassword: string,
  deps: Pick<PasswordResetDeps, 'userRepo' | 'tokenRepo' | 'sendPasswordChangedEmail' | 'webAppBaseUrl'>,
): Promise<void> {
  validatePassword(newPassword);

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const found = await deps.tokenRepo.findValidByTokenHash(tokenHash);
  if (!found) {
    throw new PasswordAuthError('This password reset link is invalid or has expired.', 'RESET_TOKEN_INVALID');
  }

  const passwordHash = await hashPassword(newPassword);
  await deps.userRepo.updatePasswordHash(found.userId, passwordHash);
  await deps.tokenRepo.markUsed(found.id);

  const user = await deps.userRepo.getById(found.userId);
  if (user?.email) {
    try {
      await deps.sendPasswordChangedEmail(user.email, { changedAt: new Date().toISOString(), webAppBaseUrl: deps.webAppBaseUrl });
    } catch (error) {
      console.error('[password-auth-service] Failed to send password-changed confirmation email:', error instanceof Error ? error.message : error);
    }
  }
}

/** Confirms an email-verification link. Additive only — see VerifyEmailRequest's doc comment; nothing else in the app reads emailVerifiedAt to gate anything. */
export async function confirmEmailVerification(
  token: string,
  deps: { userRepo: Pick<PasswordAuthUserRepo, 'updateEmailVerified'>; tokenRepo: EmailVerificationTokenRepo },
): Promise<void> {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const found = await deps.tokenRepo.findValidByTokenHash(tokenHash);
  if (!found) {
    throw new PasswordAuthError('This verification link is invalid or has expired.', 'VERIFICATION_TOKEN_INVALID');
  }

  await deps.userRepo.updateEmailVerified(found.userId);
  await deps.tokenRepo.markUsed(found.id);
}

/**
 * Mirrors requestPasswordReset's shape exactly: always resolves, never
 * reveals whether the email exists or is already verified (an unknown
 * email, or an already-verified account, is a silent no-op) — same
 * non-enumeration reasoning.
 */
export async function resendVerificationEmail(email: string, deps: { userRepo: PasswordAuthUserRepo } & EmailVerificationDeps): Promise<void> {
  const normalized = normalizeEmail(email);
  const user = await deps.userRepo.findByEmail(normalized);
  if (!user || user.emailVerifiedAt) return;

  await sendVerificationEmailBestEffort(user.id, normalized, deps);
}
