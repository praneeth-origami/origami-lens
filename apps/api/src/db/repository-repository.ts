import type { Repository, RepositoryProvider } from '@origami/contracts';
import { getPool } from './pool.js';

interface CreateRepositoryInput {
  id: string;
  /** @deprecated no longer written by any real caller — see userId. */
  ownerId?: string;
  /** The authenticated owner (Phase 16/B, migration 012) — always request.user.id, never client-supplied. */
  userId?: string;
  repoUrl: string;
  provider: RepositoryProvider;
  branch: string;
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
        `INSERT INTO repositories (id, owner_id, user_id, repo_url, provider, branch, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'CONNECTED')
         RETURNING *`,
        [input.id, input.ownerId ?? null, input.userId ?? null, input.repoUrl, input.provider, input.branch],
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
   * The authorization-aware lookup (Phase 16/B) — filters at the SQL layer
   * rather than fetching then comparing in JS, so a row belonging to
   * another user never even leaves the database. Returns undefined for
   * "doesn't exist" and "exists but isn't yours" identically — callers must
   * not distinguish the two in their response (matches this project's
   * existing "generic 404" convention).
   */
  async getByIdForUser(id: string, userId: string): Promise<Repository | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(`SELECT * FROM repositories WHERE id = $1 AND user_id = $2`, [id, userId]);
    return result.rows[0] ? this.rowToRepository(result.rows[0]) : undefined;
  }

  async list(ownerId?: string): Promise<Repository[]> {
    const pool = getPool();
    if (!pool) return [];

    const result = ownerId
      ? await pool.query(`SELECT * FROM repositories WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100`, [ownerId])
      : await pool.query(`SELECT * FROM repositories ORDER BY created_at DESC LIMIT 100`);

    return result.rows.map((row) => this.rowToRepository(row));
  }

  /** The only listing a real, authenticated caller ever gets (Phase 16/B) — always scoped to their own user_id, never an optional filter. */
  async listForUser(userId: string): Promise<Repository[]> {
    const pool = getPool();
    if (!pool) return [];

    const result = await pool.query(`SELECT * FROM repositories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [userId]);
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
      repoUrl: row.repo_url as string,
      provider: row.provider as RepositoryProvider,
      branch: row.branch as string,
      status: row.status as Repository['status'],
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}
