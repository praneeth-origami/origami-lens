import type { OrganizationRole, WorkspaceInvitation, WorkspaceInvitationStatus } from '@origami/contracts';
import { getPool } from './pool.js';

export interface CreateInvitationInput {
  id: string;
  organizationId: string;
  invitedEmail: string;
  invitedByUserId: string;
  role: OrganizationRole;
  tokenHash: string;
  expiresAt: string;
}

export interface InvitationPreview {
  organizationId: string;
  organizationName: string;
  inviterEmail?: string;
  invitedEmail: string;
  role: OrganizationRole;
  status: WorkspaceInvitationStatus;
  expiresAt: string;
}

export type AcceptInvitationResult =
  | { ok: true; organizationId: string; organizationName: string; role: OrganizationRole }
  | { ok: false; reason: 'NOT_FOUND' | 'EMAIL_MISMATCH' | 'EXPIRED' | 'REVOKED' | 'ALREADY_ACCEPTED' };

function rowToInvitation(row: Record<string, unknown>): WorkspaceInvitation {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    invitedEmail: row.invited_email as string,
    invitedByUserId: row.invited_by_user_id as string,
    invitedByEmail: (row.invited_by_email as string) ?? undefined,
    role: row.role as OrganizationRole,
    status: row.status as WorkspaceInvitationStatus,
    expiresAt: (row.expires_at as Date).toISOString(),
    acceptedAt: row.accepted_at ? (row.accepted_at as Date).toISOString() : undefined,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

/**
 * Postgres-backed store for `workspace_invitations` (migration 030). Owns
 * the whole accept transaction itself (spans this table plus
 * organization_memberships and users) rather than composing across
 * OrganizationRepository/UserRepository without a shared client — see
 * acceptByTokenHash.
 */
export class WorkspaceInvitationRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateInvitationInput): Promise<WorkspaceInvitation> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const result = await pool.query(
      `INSERT INTO workspace_invitations (id, organization_id, invited_email, invited_by_user_id, role, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [input.id, input.organizationId, input.invitedEmail, input.invitedByUserId, input.role, input.tokenHash, input.expiresAt],
    );
    return rowToInvitation(result.rows[0]);
  }

  async findPendingByOrgAndEmail(organizationId: string, invitedEmail: string): Promise<WorkspaceInvitation | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT * FROM workspace_invitations WHERE organization_id = $1 AND invited_email = $2 AND status = 'PENDING'`,
      [organizationId, invitedEmail],
    );
    return result.rows[0] ? rowToInvitation(result.rows[0]) : undefined;
  }

  /** Org-scoped lookup for revoke/resend — a non-member organizationId simply finds nothing, which callers treat as a 404 (existence-hiding), matching this codebase's other cross-workspace-access convention. */
  async findById(organizationId: string, id: string): Promise<WorkspaceInvitation | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM workspace_invitations WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
    return result.rows[0] ? rowToInvitation(result.rows[0]) : undefined;
  }

  /** The workspace settings page's "Pending invitations" list — joined to `users` for the inviter's email, most recent first. */
  async listByOrganization(organizationId: string, limit = 200): Promise<WorkspaceInvitation[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT i.*, u.email AS invited_by_email
       FROM workspace_invitations i
       JOIN users u ON u.id = i.invited_by_user_id
       WHERE i.organization_id = $1
       ORDER BY i.created_at DESC
       LIMIT $2`,
      [organizationId, Math.min(limit, 200)],
    );
    return result.rows.map(rowToInvitation);
  }

  async revoke(id: string): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(`UPDATE workspace_invitations SET status = 'REVOKED', updated_at = NOW() WHERE id = $1 AND status = 'PENDING'`, [id]);
  }

  /** Resend rotates the SAME row's token/expiry rather than creating a new invitation, so there is never more than one active token for a given invitation (spec §25). */
  async rotateToken(id: string, tokenHash: string, expiresAt: string): Promise<WorkspaceInvitation | undefined> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const result = await pool.query(
      `UPDATE workspace_invitations SET token_hash = $2, expires_at = $3, updated_at = NOW() WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [id, tokenHash, expiresAt],
    );
    return result.rows[0] ? rowToInvitation(result.rows[0]) : undefined;
  }

  /**
   * The public GET /invitations/:token preview lookup. Opportunistically
   * flips a PENDING row past its expires_at to EXPIRED in the same query so
   * the status column stays accurate for the org's invitation list too,
   * without needing a background sweep job.
   */
  async findPreviewByTokenHash(tokenHash: string): Promise<InvitationPreview | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    await pool.query(
      `UPDATE workspace_invitations SET status = 'EXPIRED', updated_at = NOW() WHERE token_hash = $1 AND status = 'PENDING' AND expires_at <= NOW()`,
      [tokenHash],
    );
    const result = await pool.query(
      `SELECT i.organization_id, o.name AS organization_name, u.email AS inviter_email,
              i.invited_email, i.role, i.status, i.expires_at
       FROM workspace_invitations i
       JOIN organizations o ON o.id = i.organization_id
       JOIN users u ON u.id = i.invited_by_user_id
       WHERE i.token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      organizationId: row.organization_id as string,
      organizationName: row.organization_name as string,
      inviterEmail: (row.inviter_email as string) ?? undefined,
      invitedEmail: row.invited_email as string,
      role: row.role as OrganizationRole,
      status: row.status as WorkspaceInvitationStatus,
      expiresAt: (row.expires_at as Date).toISOString(),
    };
  }

  /**
   * The entire accept transaction. A single conditional UPDATE covers every
   * business rule at once — PENDING, not expired, AND the caller's own
   * (normalized) email matching invited_email — so acceptance is fully
   * atomic and race-safe against concurrent accepts of the same invitation
   * (spec §20/§21): only one concurrent caller's UPDATE can ever affect a
   * row, every other caller (including a second tab of the SAME accepting
   * user) affects zero rows and is told why via the fallback diagnostic
   * SELECT below.
   */
  async acceptByTokenHash(tokenHash: string, acceptingUserId: string, normalizedAcceptingEmail: string): Promise<AcceptInvitationResult> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updateResult = await client.query(
        `UPDATE workspace_invitations
         SET status = 'ACCEPTED', accepted_at = NOW(), accepted_by_user_id = $2, updated_at = NOW()
         WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > NOW() AND invited_email = $3
         RETURNING id, organization_id, role`,
        [tokenHash, acceptingUserId, normalizedAcceptingEmail],
      );

      if (updateResult.rows.length === 0) {
        const diagnostic = await client.query(
          `SELECT status, expires_at, invited_email FROM workspace_invitations WHERE token_hash = $1`,
          [tokenHash],
        );
        await client.query('ROLLBACK');
        const row = diagnostic.rows[0];
        if (!row) return { ok: false, reason: 'NOT_FOUND' };
        if (row.status === 'REVOKED') return { ok: false, reason: 'REVOKED' };
        if (row.status === 'ACCEPTED') return { ok: false, reason: 'ALREADY_ACCEPTED' };
        if (row.invited_email !== normalizedAcceptingEmail) return { ok: false, reason: 'EMAIL_MISMATCH' };
        return { ok: false, reason: 'EXPIRED' };
      }

      const { organization_id: organizationId, role } = updateResult.rows[0];
      await client.query(
        `INSERT INTO organization_memberships (id, organization_id, user_id, role)
         VALUES (gen_random_uuid(), $1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [organizationId, acceptingUserId, role],
      );
      await client.query(`UPDATE users SET active_organization_id = $2, updated_at = NOW() WHERE id = $1`, [acceptingUserId, organizationId]);
      const orgResult = await client.query(`SELECT name FROM organizations WHERE id = $1`, [organizationId]);
      await client.query('COMMIT');
      return { ok: true, organizationId, organizationName: orgResult.rows[0]?.name as string, role: role as OrganizationRole };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
