import type { AuthUser, RepositoryProvider } from '@origami/contracts';
import { getPool } from './pool.js';

export interface UpsertUserInput {
  id: string;
  primaryProvider: RepositoryProvider;
  primaryProviderAccountId: string;
  primaryProviderLogin: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

function rowToUser(row: Record<string, unknown>): AuthUser {
  return {
    id: row.id as string,
    primaryProvider: row.primary_provider as RepositoryProvider,
    primaryProviderLogin: row.primary_provider_login as string,
    email: (row.email as string) ?? undefined,
    displayName: (row.display_name as string) ?? undefined,
    avatarUrl: (row.avatar_url as string) ?? undefined,
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
}
