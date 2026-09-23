import type { Organization, OrganizationRole, WorkspaceMember } from '@origami/contracts';
import { getPool } from './pool.js';

function rowToOrganization(row: Record<string, unknown>): Organization {
  return {
    id: row.id as string,
    name: row.name as string,
    personalOwnerUserId: (row.personal_owner_user_id as string) ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function rowToWorkspaceMember(row: Record<string, unknown>): WorkspaceMember {
  return {
    userId: row.user_id as string,
    email: (row.email as string) ?? undefined,
    displayName: (row.display_name as string) ?? undefined,
    role: row.role as OrganizationRole,
    joinedAt: (row.created_at as Date).toISOString(),
  };
}

/**
 * Postgres-backed store for `organizations`/`organization_memberships`
 * (migration 015). Like UserRepository, there is deliberately no
 * in-memory/JSON-file fallback — organization membership is a real
 * authorization boundary (see Repository.organizationId), not best-effort
 * feature data. `isEnabled()` gates every caller the same way
 * UserRepository's does.
 */
export class OrganizationRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  /** Every organization a user belongs to — today always exactly one (their personal org), since Team/Agency membership doesn't exist yet. Callers should treat this as "the set of organizations whose repositories this user may access," not assume length 1, so nothing here needs to change once shared organizations ship. */
  async getOrganizationIdsForUser(userId: string): Promise<string[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(`SELECT organization_id FROM organization_memberships WHERE user_id = $1`, [userId]);
    return result.rows.map((row) => row.organization_id as string);
  }

  /** Phase 17 — how many seats of an organization's plan are actually filled, for the billing settings page's "N of M seats used" and Entitlements.seatsUsed (see entitlement-service.ts). A personal organization always has exactly one member (its owner). */
  /** Phase 20 — the workspace switcher's data source: every organization a user belongs to, with their role in each. */
  async listOrganizationsForUser(userId: string): Promise<{ organizationId: string; name: string; role: OrganizationRole }[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT o.id AS organization_id, o.name, m.role
       FROM organization_memberships m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1
       ORDER BY m.created_at ASC`,
      [userId],
    );
    return result.rows.map((row) => ({
      organizationId: row.organization_id as string,
      name: row.name as string,
      role: row.role as OrganizationRole,
    }));
  }

  async countMembers(organizationId: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 1;
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM organization_memberships WHERE organization_id = $1`, [organizationId]);
    return (result.rows[0]?.count as number) ?? 0;
  }

  async getPersonalOrganization(userId: string): Promise<Organization | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM organizations WHERE personal_owner_user_id = $1`, [userId]);
    return result.rows[0] ? rowToOrganization(result.rows[0]) : undefined;
  }

  /**
   * Fetch-or-create a user's personal organization — called on every
   * login (see auth-service.ts) so it's "auto-created at signup" for a new
   * user and a no-op for an existing one, and self-heals any user the
   * migration 015 backfill somehow missed. Race-safe: two concurrent calls
   * for the same brand-new user both attempt the insert, the UNIQUE
   * constraint on personal_owner_user_id rejects the loser, which then
   * re-reads the winner's row instead of erroring.
   */
  async getOrCreatePersonalOrganization(userId: string, displayName: string): Promise<Organization> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const existing = await this.getPersonalOrganization(userId);
    if (existing) return existing;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orgResult = await client.query(
        `INSERT INTO organizations (id, name, personal_owner_user_id)
         VALUES (gen_random_uuid(), $1, $2)
         ON CONFLICT (personal_owner_user_id) DO UPDATE SET updated_at = organizations.updated_at
         RETURNING *`,
        [`${displayName} workspace`, userId],
      );
      const organization = rowToOrganization(orgResult.rows[0]);
      await client.query(
        `INSERT INTO organization_memberships (id, organization_id, user_id, role)
         VALUES (gen_random_uuid(), $1, $2, 'OWNER')
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [organization.id, userId],
      );
      await client.query('COMMIT');
      return organization;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Phase 18 — GET /admin/workspaces's data source. One row per organization with its current owner's email (LEFT JOIN — a personal organization always has exactly one OWNER row by construction, so this never fans out). Plan/member-count are layered on by admin-service.ts (separate, small tables — not worth a bigger join here). */
  async listAllForAdmin(): Promise<{ id: string; name: string; createdAt: string; ownerEmail?: string }[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT o.id, o.name, o.created_at, ou.email AS owner_email
       FROM organizations o
       LEFT JOIN organization_memberships om ON om.organization_id = o.id AND om.role = 'OWNER'
       LEFT JOIN users ou ON ou.id = om.user_id
       ORDER BY o.created_at ASC`,
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      createdAt: (row.created_at as Date).toISOString(),
      ownerEmail: (row.owner_email as string) ?? undefined,
    }));
  }

  /** Phase 19 — the admin user-detail drawer's org-name lookup (a membership row alone only carries the organizationId). */
  async getById(organizationId: string): Promise<Organization | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM organizations WHERE id = $1`, [organizationId]);
    return result.rows[0] ? rowToOrganization(result.rows[0]) : undefined;
  }

  /** Phase 18 — the core lookup assertWorkspaceRole (authorization/workspace-authorization.ts) calls on every role-gated route. Undefined means "not a member of this organization at all," which callers treat as a 404-equivalent (existence-hiding), never a 403. */
  async getMembershipRole(organizationId: string, userId: string): Promise<OrganizationRole | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    return (result.rows[0]?.role as OrganizationRole) ?? undefined;
  }

  async countMembersByRole(organizationId: string, role: OrganizationRole): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM organization_memberships WHERE organization_id = $1 AND role = $2`,
      [organizationId, role],
    );
    return (result.rows[0]?.count as number) ?? 0;
  }

  /** The workspace-members page's data source — joined to `users` since a bare membership row (just ids/role) isn't enough to render a member list. */
  async listMembers(organizationId: string): Promise<WorkspaceMember[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT m.user_id, m.role, m.created_at, u.email, u.display_name
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1
       ORDER BY m.created_at ASC`,
      [organizationId],
    );
    return result.rows.map(rowToWorkspaceMember);
  }

  /** Low-level insert — see workspace-member-service.ts's addWorkspaceMemberByEmail for the actual API entry point (email lookup, duplicate/plan checks, audit logging). Throws on an existing (organizationId, userId) pair via the migration 015 unique constraint. */
  async addMember(organizationId: string, userId: string, role: OrganizationRole): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `INSERT INTO organization_memberships (id, organization_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [organizationId, userId, role],
    );
  }

  async removeMember(organizationId: string, userId: string): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(`DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`, [organizationId, userId]);
  }

  async updateMemberRole(organizationId: string, userId: string, role: OrganizationRole): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `UPDATE organization_memberships SET role = $3 WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId, role],
    );
  }

  /** Phase 18 — the only path that ever assigns OWNER to someone other than an organization's original creator. Transactional: the old owner is demoted to ADMIN (never removed — see workspace-member-service.ts's doc comment on why), the new owner is promoted, both in one atomic step so the organization is never briefly ownerless or double-owned. */
  async transferOwnership(organizationId: string, fromUserId: string, toUserId: string): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE organization_memberships SET role = 'ADMIN' WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, fromUserId],
      );
      await client.query(
        `UPDATE organization_memberships SET role = 'OWNER' WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, toUserId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
