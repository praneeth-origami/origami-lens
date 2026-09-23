import { getPool } from './pool.js';

export interface CreateEmailVerificationTokenInput {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
}

export interface EmailVerificationToken {
  id: string;
  userId: string;
  expiresAt: string;
}

/** Migration 033 — mirrors password-reset-token-repository.ts exactly: only the token's hash is ever stored, `used_at` marks a token permanently spent. */
export class EmailVerificationTokenRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateEmailVerificationTokenInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [input.id, input.userId, input.tokenHash, input.expiresAt],
    );
  }

  async findValidByTokenHash(tokenHash: string): Promise<EmailVerificationToken | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT id, user_id, expires_at FROM email_verification_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { id: row.id as string, userId: row.user_id as string, expiresAt: (row.expires_at as Date).toISOString() };
  }

  async markUsed(id: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`, [id]);
  }
}
