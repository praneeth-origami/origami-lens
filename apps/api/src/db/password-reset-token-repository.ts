import { getPool } from './pool.js';

export interface CreatePasswordResetTokenInput {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  expiresAt: string;
}

/**
 * Postgres-backed store for `password_reset_tokens` (migration 021). Same
 * "fail closed, no in-memory fallback" rule as SessionRepository/UserRepository
 * — a reset token is an authentication boundary, not best-effort feature data.
 */
export class PasswordResetTokenRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreatePasswordResetTokenInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [input.id, input.userId, input.tokenHash, input.expiresAt],
    );
  }

  /** Returns undefined for "doesn't exist", "expired", and "already used" identically — resetPassword's caller never needs to distinguish them, it's always just RESET_TOKEN_INVALID. */
  async findValidByTokenHash(tokenHash: string): Promise<PasswordResetToken | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT id, user_id, expires_at FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { id: row.id as string, userId: row.user_id as string, expiresAt: (row.expires_at as Date).toISOString() };
  }

  async markUsed(id: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [id]);
  }
}
