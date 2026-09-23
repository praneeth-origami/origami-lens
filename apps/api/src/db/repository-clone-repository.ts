import type { RepositoryCloneJob, RepositoryCloneStatus, RepositoryDiscoveryMetadata } from '@origami/contracts';
import { getPool } from './pool.js';

interface CreateCloneJobInput {
  id: string;
  repositoryId: string;
  ownerId?: string;
}

interface CompleteCloneJobInput {
  status: RepositoryCloneStatus;
  commitSha?: string;
  discovery?: RepositoryDiscoveryMetadata;
  error?: string;
}

export class RepositoryCloneRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async createJob(input: CreateCloneJobInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    await pool.query(
      `INSERT INTO repository_clone_jobs (id, repository_id, owner_id, status)
       VALUES ($1, $2, $3, 'QUEUED')`,
      [input.id, input.repositoryId, input.ownerId ?? null],
    );
  }

  async markRunning(jobId: string, clonePath: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `UPDATE repository_clone_jobs SET status = 'RUNNING', clone_path = $2, started_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [jobId, clonePath],
    );
  }

  async complete(jobId: string, data: CompleteCloneJobInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    await pool.query(
      `UPDATE repository_clone_jobs SET
         status = $2,
         commit_sha = $3,
         discovered_file_count = $4,
         discovered_directory_count = $5,
         discovered_total_size_bytes = $6,
         discovery_json = $7,
         error = $8,
         completed_at = NOW(),
         updated_at = NOW()
       WHERE id = $1`,
      [
        jobId,
        data.status,
        data.commitSha ?? null,
        data.discovery?.fileCount ?? null,
        data.discovery?.directoryCount ?? null,
        data.discovery?.totalSizeBytes ?? null,
        data.discovery ? JSON.stringify(data.discovery) : null,
        data.error ?? null,
      ],
    );
  }

  async getById(jobId: string): Promise<RepositoryCloneJob | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM repository_clone_jobs WHERE id = $1`, [jobId]);
    if (result.rows.length === 0) return undefined;
    return this.rowToJob(result.rows[0]);
  }

  async getLatestForRepository(repositoryId: string): Promise<RepositoryCloneJob | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT * FROM repository_clone_jobs WHERE repository_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [repositoryId],
    );
    if (result.rows.length === 0) return undefined;
    return this.rowToJob(result.rows[0]);
  }

  private rowToJob(row: Record<string, unknown>): RepositoryCloneJob {
    return {
      jobId: row.id as string,
      repositoryId: row.repository_id as string,
      ownerId: (row.owner_id as string) ?? undefined,
      status: row.status as RepositoryCloneStatus,
      commitSha: (row.commit_sha as string) ?? undefined,
      discovery: (row.discovery_json as RepositoryDiscoveryMetadata) ?? undefined,
      error: (row.error as string) ?? undefined,
      startedAt: row.started_at ? (row.started_at as Date).toISOString() : undefined,
      completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : undefined,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}
