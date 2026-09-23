import type { AuthProvider, AuthUser, Persona, PlatformRole } from '@origami/contracts';
import { getPool } from './pool.js';

export interface UpsertUserInput {
  id: string;
  primaryProvider: AuthProvider;
  primaryProviderAccountId: string;
  primaryProviderLogin: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface CreateEmailUserInput {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
}

/** Returned only to password-auth-service.ts's login/reset verification — passwordHash is deliberately kept OUT of AuthUser's own shape (see rowToUser below, which never selects it) so nothing else in the codebase can accidentally serialize it into a response. */
export interface AuthWithPasswordHash {
  user: AuthUser;
  passwordHash: string | null;
}

function rowToUser(row: Record<string, unknown>): AuthUser {
  return {
    id: row.id as string,
    primaryProvider: row.primary_provider as AuthProvider,
    primaryProviderLogin: row.primary_provider_login as string,
    email: (row.email as string) ?? undefined,
    displayName: (row.display_name as string) ?? undefined,
    avatarUrl: (row.avatar_url as string) ?? undefined,
    persona: (row.persona as Persona) ?? undefined,
    platformRole: row.platform_role as PlatformRole,
    createdAt: (row.created_at as Date).toISOString(),
    activeOrganizationId: (row.active_organization_id as string) ?? undefined,
    emailVerifiedAt: row.email_verified_at ? (row.email_verified_at as Date).toISOString() : undefined,
  };
}

/**
 * Postgres-backed store for `users` (migration 011). Requires a real
 * database — unlike most other repository-feature stores, there is
 * deliberately no in-memory/JSON-file fallback here (see the Phase 16
 * design report): authentication is a security boundary, not best-effort
 * feature data, so it must not silently degrade to a less durable, less
 * atomic store when DATABASE_URL is unset. `isEnabled()` gates every route
 * that needs a real user identity, exactly like `isDatabaseEnabled()`
 * already gates the pgvector-only repository-search features.
 */
export class UserRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  /**
   * The single entry point for "log in via provider OAuth" — creates the
   * user on first login, or updates display fields (email/name/avatar can
   * change upstream) on every subsequent login. Never changes
   * primary_provider/primary_provider_account_id once created — those are
   * the immutable identity key (see the unique constraint in 011).
   */
  async upsertByProviderAccount(input: UpsertUserInput): Promise<AuthUser> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(
      `INSERT INTO users (id, primary_provider, primary_provider_account_id, primary_provider_login, email, display_name, avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (primary_provider, primary_provider_account_id) DO UPDATE SET
         primary_provider_login = EXCLUDED.primary_provider_login,
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url,
         updated_at = NOW()
       RETURNING *`,
      [
        input.id, input.primaryProvider, input.primaryProviderAccountId, input.primaryProviderLogin,
        input.email ?? null, input.displayName ?? null, input.avatarUrl ?? null,
      ],
    );
    return rowToUser(result.rows[0]);
  }

  async getById(id: string): Promise<AuthUser | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
    return result.rows[0] ? rowToUser(result.rows[0]) : undefined;
  }

  /** Phase 16/H — registration entry point for email/password (mirrors upsertByProviderAccount's shape). primary_provider_account_id is the email itself for this provider, since there's no external account id to key on; the partial unique index on users.email (migration 020) is the real duplicate-registration guard, enforced at the DB layer, not just checked in application code. */
  async createEmailUser(input: CreateEmailUserInput): Promise<AuthUser> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(
      `INSERT INTO users (id, primary_provider, primary_provider_account_id, primary_provider_login, email, display_name, password_hash)
       VALUES ($1, 'EMAIL', $2, $3, $2, $3, $4)
       RETURNING *`,
      [input.id, input.email, input.displayName, input.passwordHash],
    );
    return rowToUser(result.rows[0]);
  }

  /** The one lookup password-auth-service.ts's loginWithEmail/requestPasswordReset perform — returns the password hash ALONGSIDE (never inside) AuthUser, see AuthWithPasswordHash's doc comment. Undefined for "no such email" — callers must not distinguish that from "wrong password" in what they tell the caller. */
  async findByEmailWithPasswordHash(email: string): Promise<AuthWithPasswordHash | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    if (result.rows.length === 0) return undefined;
    return { user: rowToUser(result.rows[0]), passwordHash: (result.rows[0].password_hash as string) ?? null };
  }

  /** Registration's duplicate-email pre-check — the actual guarantee is the partial unique index (migration 020); this is just for a friendlier error before hitting a DB constraint violation. */
  async findByEmail(email: string): Promise<AuthUser | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    return result.rows[0] ? rowToUser(result.rows[0]) : undefined;
  }

  /** Phase 16/H — reset-password's terminal step. Deliberately does not touch any other column (display name, avatar, etc.) — a password reset changes only the password. */
  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [userId, passwordHash]);
  }

  /** Phase 3 — the one-time onboarding answer. Always overwrites (a user can revisit and change their answer); there is no "locked after first answer" rule. Throws if the user doesn't exist, since this is only ever called for a just-authenticated request.user.id. */
  async updatePersona(id: string, persona: Persona): Promise<AuthUser> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const result = await pool.query(`UPDATE users SET persona = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, persona]);
    if (result.rows.length === 0) throw new Error('User not found');
    return rowToUser(result.rows[0]);
  }

  /** Phase 18 — the one write path for platform_role: Founder bootstrap (auth-service.ts/password-auth-service.ts, self-promotion from FOUNDER_BOOTSTRAP_EMAILS), the admin API (PATCH /admin/users/:id/platform-role, FOUNDER-only), and scripts/set-platform-role.ts. Never exposed as a generic field on any user-editable profile endpoint. */
  async updatePlatformRole(id: string, platformRole: PlatformRole): Promise<AuthUser> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const result = await pool.query(`UPDATE users SET platform_role = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, platformRole]);
    if (result.rows.length === 0) throw new Error('User not found');
    return rowToUser(result.rows[0]);
  }

  /** How many accounts currently hold a given platform role — used only to block demoting the last remaining FOUNDER (see admin-service.ts). */
  async countByPlatformRole(platformRole: PlatformRole): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE platform_role = $1`, [platformRole]);
    return (result.rows[0]?.count as number) ?? 0;
  }

  /** Phase 18 — GET /admin/users. Bounded/paged listing is unnecessary at this project's scale; if that ever changes, add limit/cursor params here rather than at the call site. */
  async listAll(): Promise<AuthUser[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM users ORDER BY created_at ASC`);
    return result.rows.map(rowToUser);
  }

  /** Phase 19 — the Overview tab's "new users today/this week" counts. */
  async countCreatedSince(sinceIso: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE created_at > $1`, [sinceIso]);
    return (result.rows[0]?.count as number) ?? 0;
  }

  async countAll(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM users`);
    return (result.rows[0]?.count as number) ?? 0;
  }

  /** Phase 20 — which workspace resolveOrganizationIdForAuthenticatedRequest (index.ts) prefers, set on explicit workspace-switch and automatically on accepting a workspace invitation (workspace-invitation-repository.ts). Falls back to the user's first organization whenever this is null or no longer a real membership. */
  async updateActiveOrganizationId(id: string, organizationId: string): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(`UPDATE users SET active_organization_id = $2, updated_at = NOW() WHERE id = $1`, [id, organizationId]);
  }

  /** Email-verification's terminal step (migration 033) — confirmEmailVerification's only write to `users`. Additive only: nothing reads this to gate access; see AuthUser.emailVerifiedAt's doc comment. */
  async updateEmailVerified(id: string): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(`UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
  }
}
