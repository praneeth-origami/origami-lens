import type { Repository, RepositoryProvider, RepositoryRole } from '@origami/contracts';
import { getPool } from './pool.js';

interface CreateRepositoryInput {
  id: string;
  /** @deprecated no longer written by any real caller — see organizationId. */
  ownerId?: string;
  /** Who created this connection (audit only, migration 012) — always request.user.id, never client-supplied. Not read for authorization; see organizationId. */
  userId?: string;
  /** The real ownership boundary (Phase 2, migration 016) — always the creating user's organization, resolved server-side, never client-supplied. */
  organizationId?: string;
  repoUrl: string;
  provider: RepositoryProvider;
  branch: string;
  /** Which layer this repository represents (migration 019) — defaults to FULL_STACK at the SQL layer when omitted, matching every pre-existing repository. */
  role?: RepositoryRole;
}

/** Postgres unique_violation error code (constraint uq_repositories_owner_url_branch in 005_repositories.sql). */
const UNIQUE_VIOLATION = '23505';

export class DuplicateRepositoryError extends Error {
  constructor() {
    super('This repository and branch are already connected.');
    this.name = 'DuplicateRepositoryError';
  }
}

export class RepositoryRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateRepositoryInput): Promise<Repository> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    try {
      const result = await pool.query(
        `INSERT INTO repositories (id, owner_id, user_id, organization_id, repo_url, provider, branch, status, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONNECTED', COALESCE($8::repository_role, 'FULL_STACK'::repository_role))
         RETURNING *`,
        [input.id, input.ownerId ?? null, input.userId ?? null, input.organizationId ?? null, input.repoUrl, input.provider, input.branch, input.role ?? null],
      );
      return this.rowToRepository(result.rows[0]);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new DuplicateRepositoryError();
      }
      throw error;
    }
  }

  /** Repository-level state only (see RepositoryStatus) — distinct from and never confused with a clone job's own QUEUED/RUNNING/COMPLETED lifecycle in repository_clone_jobs. */
  async updateStatus(id: string, status: Repository['status']): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE repositories SET status = $2, updated_at = NOW() WHERE id = $1`, [id, status]);
  }

  async getById(id: string): Promise<Repository | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(`SELECT * FROM repositories WHERE id = $1`, [id]);
    if (result.rows.length === 0) return undefined;
    return this.rowToRepository(result.rows[0]);
  }

  /**
   * The authorization-aware lookup (Phase 2, migration 016) — filters at the
   * SQL layer rather than fetching then comparing in JS, so a row belonging
   * to another organization never even leaves the database. Returns
   * undefined for "doesn't exist" and "exists but isn't yours" identically
   * — callers must not distinguish the two in their response (matches this
   * project's existing "generic 404" convention). Takes every organization
   * the caller belongs to (today always exactly their one personal org) so
   * this doesn't need to change once Team/Agency sharing ships.
   */
  async getByIdForOrganizations(id: string, organizationIds: string[]): Promise<Repository | undefined> {
    const pool = getPool();
    if (!pool || organizationIds.length === 0) return undefined;

    const result = await pool.query(`SELECT * FROM repositories WHERE id = $1 AND organization_id = ANY($2::uuid[])`, [id, organizationIds]);
    return result.rows[0] ? this.rowToRepository(result.rows[0]) : undefined;
  }

  /**
   * Deletes a repository and everything under it (clone/index/embedding
   * jobs, repository issues, fix workflows — all ON DELETE CASCADE, see
   * migrations 006-010) in one statement, but only if it belongs to one of
   * the caller's organizations. Returns false for "doesn't exist" and
   * "exists but isn't yours" identically. The on-disk clone workspace is
   * NOT removed here — see index.ts's use of REPOSITORY_CLONE_ROOT, which
   * the caller cleans up separately after this succeeds.
   */
  async deleteForOrganizations(id: string, organizationIds: string[]): Promise<boolean> {
    if (organizationIds.length === 0) return false;
    const pool = getPool();
    if (!pool) return false;

    const result = await pool.query(`DELETE FROM repositories WHERE id = $1 AND organization_id = ANY($2::uuid[])`, [id, organizationIds]);
    return (result.rowCount ?? 0) > 0;
  }

  async list(ownerId?: string): Promise<Repository[]> {
    const pool = getPool();
    if (!pool) return [];

    const result = ownerId
      ? await pool.query(`SELECT * FROM repositories WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100`, [ownerId])
      : await pool.query(`SELECT * FROM repositories ORDER BY created_at DESC LIMIT 100`);

    return result.rows.map((row) => this.rowToRepository(row));
  }

  /** The only listing a real, authenticated caller ever gets (Phase 2) — always scoped to every organization they belong to, never an optional filter. */
  async listForOrganizations(organizationIds: string[]): Promise<Repository[]> {
    const pool = getPool();
    if (!pool || organizationIds.length === 0) return [];

    const result = await pool.query(`SELECT * FROM repositories WHERE organization_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 100`, [organizationIds]);
    return result.rows.map((row) => this.rowToRepository(row));
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === UNIQUE_VIOLATION);
  }

  private rowToRepository(row: Record<string, unknown>): Repository {
    return {
      id: row.id as string,
      ownerId: (row.owner_id as string) ?? undefined,
      userId: (row.user_id as string) ?? undefined,
      organizationId: (row.organization_id as string) ?? undefined,
      repoUrl: row.repo_url as string,
      provider: row.provider as RepositoryProvider,
      branch: row.branch as string,
      status: row.status as Repository['status'],
      role: (row.role as RepositoryRole) ?? 'FULL_STACK',
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}
