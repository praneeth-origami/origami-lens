/**
 * Founder bootstrap — the ONLY path that can ever grant FOUNDER outside the
 * admin API (which is itself FOUNDER-only, so it can't bootstrap the very
 * first one). No public endpoint, no hardcoded email in application logic —
 * follows this codebase's existing convention of env-var-gated
 * server-side-only configuration (same shape as STRIPE_SECRET_KEY,
 * GITHUB_OAUTH_CLIENT_ID, etc.). Set FOUNDER_BOOTSTRAP_EMAILS in .env to a
 * comma-separated list of email addresses; the FIRST login/registration
 * from a matching, still-default-'USER' account is promoted to FOUNDER and
 * audit-logged. Never re-checked after that — so revoking FOUNDER later via
 * the admin UI sticks permanently even if the email stays in the env var.
 */
import type { AuthUser, PlatformRole } from '@origami/contracts';
import type { RecordAuditEventInput } from '../db/audit-log-repository.js';

export interface FounderBootstrapUserRepo {
  updatePlatformRole(id: string, platformRole: PlatformRole): Promise<AuthUser>;
}

export interface FounderBootstrapDeps {
  userRepo: FounderBootstrapUserRepo;
  auditLog: { record(input: RecordAuditEventInput): Promise<void> };
}

function bootstrapEmails(): Set<string> {
  return new Set(
    (process.env.FOUNDER_BOOTSTRAP_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function maybeBootstrapFounder(deps: FounderBootstrapDeps, user: AuthUser): Promise<AuthUser> {
  if (user.platformRole !== 'USER') return user;

  const email = user.email?.trim().toLowerCase();
  if (!email || !bootstrapEmails().has(email)) return user;

  const promoted = await deps.userRepo.updatePlatformRole(user.id, 'FOUNDER');
  await deps.auditLog
    .record({
      actorUserId: user.id,
      eventType: 'platform.founder.bootstrapped',
      targetType: 'user',
      targetId: user.id,
      metadata: { email },
    })
    .catch(() => {});
  return promoted;
}
