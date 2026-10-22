import { getPool } from './pool.js';

export interface CreateReportShareLinkInput {
  id: string;
  scanId: string;
  tokenHash: string;
  createdBy?: string;
  /** Agency plan (V4) client share links — the one genuinely missing piece in this otherwise-reusable mechanism (migration 042). Undefined/null preserves every existing link's "valid until revoked" behavior exactly. */
  expiresAt?: string;
}

export interface ReportShareLink {
  id: string;
  scanId: string;
  createdAt: string;
  revokedAt?: string;
  expiresAt?: string;
}

/** Mirrors password-reset-token-repository.ts / email-verification-token-repository.ts exactly: only the token's hash is ever stored. See migration 035's doc comment for why POST /report/share rotates instead of trying to redisplay an old link. */
export class ReportShareLinkRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateReportShareLinkInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `INSERT INTO report_share_links (id, scan_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [input.id, input.scanId, input.tokenHash, input.createdBy ?? null, input.expiresAt ?? null],
    );
  }

  /** Never revealed to a caller (no raw token here) — only used to answer "is a link active for this scan right now" for the Share modal's status display. An expired-but-not-yet-revoked link is correctly reported as inactive. */
  async findActiveByScanId(scanId: string): Promise<ReportShareLink | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT id, scan_id, created_at, revoked_at, expires_at FROM report_share_links
       WHERE scan_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC LIMIT 1`,
      [scanId],
    );
    return result.rows[0] ? this.rowToLink(result.rows[0]) : undefined;
  }

  async findValidByTokenHash(tokenHash: string): Promise<ReportShareLink | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT id, scan_id, created_at, revoked_at, expires_at FROM report_share_links
       WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
      [tokenHash],
    );
    return result.rows[0] ? this.rowToLink(result.rows[0]) : undefined;
  }

  async revokeActiveByScanId(scanId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE report_share_links SET revoked_at = NOW() WHERE scan_id = $1 AND revoked_at IS NULL`, [scanId]);
  }

  private rowToLink(row: Record<string, unknown>): ReportShareLink {
    return {
      id: row.id as string,
      scanId: row.scan_id as string,
      createdAt: (row.created_at as Date).toISOString(),
      revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : undefined,
      expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : undefined,
    };
  }
}
