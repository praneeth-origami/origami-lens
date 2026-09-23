import type { RepositoryProvider } from '@origami/contracts';
import { getPool } from './pool.js';

export interface ProviderConnection {
  id: string;
  userId: string;
  provider: RepositoryProvider;
  externalAccountLogin: string;
  installationId?: number;
  /** Phase 16/D — GitLab (and future Bitbucket) OAuth. Encrypted via credential-encryption.ts; NEVER exposed by any route — index.ts's /providers/connections handler explicitly picks only id/provider/externalAccountLogin/status/createdAt. */
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  tokenExpiresAt?: string;
  status: 'ACTIVE' | 'REVOKED';
  createdAt: string;
  updatedAt: string;
}

export interface UpsertGitHubInstallationInput {
  id: string;
  userId: string;
  installationId: number;
  externalAccountLogin: string;
}

export interface UpsertGitLabConnectionInput {
  id: string;
  userId: string;
  externalAccountLogin: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: string;
}

export interface UpsertBitbucketConnectionInput {
  id: string;
  userId: string;
  externalAccountLogin: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: string;
}

function rowToConnection(row: Record<string, unknown>): ProviderConnection {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    provider: row.provider as RepositoryProvider,
    externalAccountLogin: row.external_account_login as string,
    installationId: row.installation_id === null ? undefined : Number(row.installation_id),
    encryptedAccessToken: (row.encrypted_access_token as string) ?? undefined,
    encryptedRefreshToken: (row.encrypted_refresh_token as string) ?? undefined,
    tokenExpiresAt: row.token_expires_at ? (row.token_expires_at as Date).toISOString() : undefined,
    status: row.status as 'ACTIVE' | 'REVOKED',
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Postgres-only (migration 013) — same rationale as UserRepository/
 * SessionRepository: this table is the sole place any provider-credential-
 * adjacent data lives, so it must be backed by a real, atomic store or
 * simply be disabled, never silently degrade to a JSON-file fallback.
 */
export class ProviderConnectionRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  /**
   * The install-callback entry point — re-installing/reconnecting the same
   * GitHub App installation (identified by its real, GitHub-issued
   * installation_id) updates which user it belongs to rather than
   * duplicating a row, so a stale connection can never linger pointing at
   * the wrong user after a legitimate re-install.
   */
  async upsertGitHubInstallation(input: UpsertGitHubInstallationInput): Promise<ProviderConnection> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const result = await pool.query(
      `INSERT INTO provider_connections (id, user_id, provider, external_account_login, installation_id, status)
       VALUES ($1, $2, 'GITHUB', $3, $4, 'ACTIVE')
       ON CONFLICT (provider, installation_id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         external_account_login = EXCLUDED.external_account_login,
         status = 'ACTIVE',
         updated_at = NOW()
       RETURNING *`,
      [input.id, input.userId, input.externalAccountLogin, input.installationId],
    );
    return rowToConnection(result.rows[0]);
  }

  /** The one lookup approveFindingFix's credential resolution performs — must return a row ONLY when this exact installation is both ACTIVE and owned by this exact user (see provider-connection-service.ts's resolveGitHubPushCredentials, the sole caller). */
  async findActiveForUserAndInstallation(userId: string, installationId: number): Promise<ProviderConnection | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT * FROM provider_connections WHERE user_id = $1 AND provider = 'GITHUB' AND installation_id = $2 AND status = 'ACTIVE'`,
      [userId, installationId],
    );
    return result.rows[0] ? rowToConnection(result.rows[0]) : undefined;
  }

  /** Redacted by construction — the row itself never carries a secret for GitHub installations, but this is still the only read path the /providers/connections route uses, so nothing beyond ProviderConnection's fields can ever reach a response body. */
  async listForUser(userId: string): Promise<ProviderConnection[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM provider_connections WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    return result.rows.map(rowToConnection);
  }

  /** Scoped to userId so a caller can only ever look up their own connection — never pass an unchecked id straight from a route param. Used by the disconnect route to know the provider/installationId BEFORE deciding whether a real GitHub-side uninstall call is needed, without changing revokeForUser's existing behavior/signature. */
  async findByIdForUser(userId: string, connectionId: string): Promise<ProviderConnection | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM provider_connections WHERE id = $1 AND user_id = $2`, [connectionId, userId]);
    return result.rows[0] ? rowToConnection(result.rows[0]) : undefined;
  }

  /** Scoped to userId so a caller can only ever revoke their own connection — never pass an unchecked id straight from a route param. */
  async revokeForUser(userId: string, connectionId: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;
    const result = await pool.query(
      `UPDATE provider_connections SET status = 'REVOKED', updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [connectionId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * The OAuth-callback entry point for GitLab. Unlike GitHub (deduped by
   * the provider's own installation_id via a real DB unique constraint),
   * GitLab has no installation concept — "one active GitLab connection per
   * user" is enforced here at the application layer: find this user's
   * existing ACTIVE GitLab row and update its tokens in place, or insert a
   * new one if none exists. No new migration/constraint required (see the
   * Phase 16/D audit) — reconnecting is not a high-concurrency path.
   */
  async upsertGitLabConnection(input: UpsertGitLabConnectionInput): Promise<ProviderConnection> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const existing = await pool.query(
      `SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'GITLAB' AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1`,
      [input.userId],
    );

    if (existing.rows[0]) {
      const result = await pool.query(
        `UPDATE provider_connections SET
           external_account_login = $2, encrypted_access_token = $3, encrypted_refresh_token = $4, token_expires_at = $5, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existing.rows[0].id, input.externalAccountLogin, input.encryptedAccessToken, input.encryptedRefreshToken, input.tokenExpiresAt],
      );
      return rowToConnection(result.rows[0]);
    }

    const result = await pool.query(
      `INSERT INTO provider_connections (id, user_id, provider, external_account_login, encrypted_access_token, encrypted_refresh_token, token_expires_at, status)
       VALUES ($1, $2, 'GITLAB', $3, $4, $5, $6, 'ACTIVE')
       RETURNING *`,
      [input.id, input.userId, input.externalAccountLogin, input.encryptedAccessToken, input.encryptedRefreshToken, input.tokenExpiresAt],
    );
    return rowToConnection(result.rows[0]);
  }

  /** The one lookup GitLab credential resolution performs — always this exact user's own ACTIVE GitLab connection, never another user's. */
  async findActiveGitLabConnectionForUser(userId: string): Promise<ProviderConnection | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT * FROM provider_connections WHERE user_id = $1 AND provider = 'GITLAB' AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? rowToConnection(result.rows[0]) : undefined;
  }

  /** Persists a rotated access/refresh token pair after a real GitLab token refresh — GitLab issues a NEW refresh token on every use, so the old one must be overwritten, never reused. Scoped to the connection id, not user-supplied, since the caller already resolved this row for the correct user. */
  async updateGitLabTokens(connectionId: string, encryptedAccessToken: string, encryptedRefreshToken: string, tokenExpiresAt: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `UPDATE provider_connections SET encrypted_access_token = $2, encrypted_refresh_token = $3, token_expires_at = $4, updated_at = NOW() WHERE id = $1`,
      [connectionId, encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt],
    );
  }

  /**
   * The OAuth-callback entry point for Bitbucket — same "one active
   * connection per user, enforced at the application layer" pattern as
   * GitLab (Bitbucket OAuth consumers have no installation concept
   * either). No new migration/constraint required.
   */
  async upsertBitbucketConnection(input: UpsertBitbucketConnectionInput): Promise<ProviderConnection> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const existing = await pool.query(
      `SELECT id FROM provider_connections WHERE user_id = $1 AND provider = 'BITBUCKET' AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1`,
      [input.userId],
    );

    if (existing.rows[0]) {
      const result = await pool.query(
        `UPDATE provider_connections SET
           external_account_login = $2, encrypted_access_token = $3, encrypted_refresh_token = $4, token_expires_at = $5, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existing.rows[0].id, input.externalAccountLogin, input.encryptedAccessToken, input.encryptedRefreshToken, input.tokenExpiresAt],
      );
      return rowToConnection(result.rows[0]);
    }

    const result = await pool.query(
      `INSERT INTO provider_connections (id, user_id, provider, external_account_login, encrypted_access_token, encrypted_refresh_token, token_expires_at, status)
       VALUES ($1, $2, 'BITBUCKET', $3, $4, $5, $6, 'ACTIVE')
       RETURNING *`,
      [input.id, input.userId, input.externalAccountLogin, input.encryptedAccessToken, input.encryptedRefreshToken, input.tokenExpiresAt],
    );
    return rowToConnection(result.rows[0]);
  }

  /** The one lookup Bitbucket credential resolution performs — always this exact user's own ACTIVE Bitbucket connection, never another user's. */
  async findActiveBitbucketConnectionForUser(userId: string): Promise<ProviderConnection | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT * FROM provider_connections WHERE user_id = $1 AND provider = 'BITBUCKET' AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? rowToConnection(result.rows[0]) : undefined;
  }

  /** Persists a refreshed access token (and, only when Bitbucket actually rotated it, a new refresh token) — see bitbucket-oauth.ts's refreshBitbucketToken for why the refresh token is conditional here, unlike GitLab's mandatory rotation. */
  async updateBitbucketTokens(connectionId: string, encryptedAccessToken: string, encryptedRefreshToken: string, tokenExpiresAt: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `UPDATE provider_connections SET encrypted_access_token = $2, encrypted_refresh_token = $3, token_expires_at = $4, updated_at = NOW() WHERE id = $1`,
      [connectionId, encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt],
    );
  }
}
