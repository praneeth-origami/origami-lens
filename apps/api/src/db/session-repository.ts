import type { AuthProvider, AuthUser, Persona, PlatformRole } from '@origami/contracts';
import { getPool } from './pool.js';

export interface CreateSessionInput {
  id: string;
  userId: string;
  expiresAt: string;
}

export interface SessionWithUser {
  sessionId: string;
  expiresAt: string;
  user: AuthUser;
}

function rowToSessionWithUser(row: Record<string, unknown>): SessionWithUser {
  return {
    sessionId: row.session_id as string,
    expiresAt: (row.expires_at as Date).toISOString(),
    user: {
      id: row.user_id as string,
      primaryProvider: row.primary_provider as AuthProvider,
      primaryProviderLogin: row.primary_provider_login as string,
      email: (row.email as string) ?? undefined,
      displayName: (row.display_name as string) ?? undefined,
      avatarUrl: (row.avatar_url as string) ?? undefined,
      persona: (row.persona as Persona) ?? undefined,
      platformRole: row.platform_role as PlatformRole,
      createdAt: (row.created_at as Date).toISOString(),
      activeOrganizationId: (row.active_organization_id as string) ?? undefined,
    },
  };
}

/**
 * Postgres-backed store for `sessions` (migration 011). No in-memory/JSON
 * fallback — same rationale as UserRepository: a session is the entire
 * authentication boundary, so it must be backed by a real, atomic,
 * durable store or not exist at all (fail closed via isEnabled(), never
 * fail open to an unauthenticated pass-through).
 */
export class SessionRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateSessionInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
      [input.id, input.userId, input.expiresAt],
    );
  }

  /**
   * The one lookup the auth middleware performs on every authenticated
   * request — joins straight to `users` so a single query yields everything
   * needed to populate request.user. Returns undefined for a missing OR
   * expired session; the caller never needs to distinguish the two (both
   * mean "not authenticated").
   */
  async getValidByIdAndTouch(sessionId: string): Promise<SessionWithUser | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(
      `UPDATE sessions SET last_used_at = NOW()
       WHERE id = $1 AND expires_at > NOW()
       RETURNING id AS session_id, expires_at, user_id`,
      [sessionId],
    );
    const sessionRow = result.rows[0];
    if (!sessionRow) return undefined;

    const userResult = await pool.query(`SELECT * FROM users WHERE id = $1`, [sessionRow.user_id]);
    const userRow = userResult.rows[0];
    if (!userRow) return undefined;

    return rowToSessionWithUser({ ...sessionRow, ...userRow });
  }

  async deleteById(sessionId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  }

  /** Used by a periodic cleanup sweep, matching the existing repository_fix_workflows TTL-sweep pattern. */
  async deleteExpired(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(`DELETE FROM sessions WHERE expires_at <= NOW()`);
    return result.rowCount ?? 0;
  }

  /** Phase 19 — the admin user-detail drawer's "last active" field. `last_used_at` (touched by getValidByIdAndTouch on every authenticated request) is the only per-request-refreshed timestamp in the system — see authorization's own doc comments on this same fact. */
  async getLastActiveAt(userId: string): Promise<string | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT MAX(last_used_at) AS last_used_at FROM sessions WHERE user_id = $1`, [userId]);
    const value = result.rows[0]?.last_used_at as Date | null;
    return value ? value.toISOString() : undefined;
  }

  /** Phase 19 — the Overview tab's "Active Users" count: distinct users with a non-expired session touched within the window. */
  async countActiveSince(windowMinutes: number): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS count FROM sessions WHERE last_used_at > NOW() - ($1 || ' minutes')::interval AND expires_at > NOW()`,
      [windowMinutes],
    );
    return (result.rows[0]?.count as number) ?? 0;
  }
}
