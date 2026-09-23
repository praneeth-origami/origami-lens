import type { EmbeddingErrorCategory, RepositoryEmbeddingJob, RepositoryEmbeddingStatus } from '@origami/contracts';
import { getPool } from './pool.js';

interface CreateEmbeddingJobInput {
  id: string;
  repositoryId: string;
  indexJobId: string;
  ownerId?: string;
  commitSha: string;
  model: string;
}

interface CompleteEmbeddingJobInput {
  status: RepositoryEmbeddingStatus;
  dimensions?: number;
  totalChunks?: number;
  embeddedChunks?: number;
  skippedChunks?: number;
  failedChunks?: number;
  error?: string;
  errorCategory?: EmbeddingErrorCategory;
}

export interface InsertEmbeddingInput {
  id: string;
  repositoryId: string;
  embeddingJobId: string;
  chunkId: string;
  commitSha: string;
  model: string;
  dimensions: number;
  contentHash: string;
  vector: number[];
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

export class RepositoryEmbeddingRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async createJob(input: CreateEmbeddingJobInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `INSERT INTO repository_embedding_jobs (id, repository_id, index_job_id, owner_id, commit_sha, status, model)
       VALUES ($1, $2, $3, $4, $5, 'QUEUED', $6)`,
      [input.id, input.repositoryId, input.indexJobId, input.ownerId ?? null, input.commitSha, input.model],
    );
  }

  async markRunning(jobId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE repository_embedding_jobs SET status = 'RUNNING', started_at = NOW(), updated_at = NOW() WHERE id = $1`, [jobId]);
  }

  async completeJob(jobId: string, data: CompleteEmbeddingJobInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `UPDATE repository_embedding_jobs SET
         status = $2, dimensions = $3, total_chunks = $4, embedded_chunks = $5,
         skipped_chunks = $6, failed_chunks = $7, error = $8, error_category = $9,
         completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [
        jobId, data.status, data.dimensions ?? null, data.totalChunks ?? null, data.embeddedChunks ?? null,
        data.skippedChunks ?? null, data.failedChunks ?? null, data.error ?? null, data.errorCategory ?? null,
      ],
    );
  }

  async getJobById(jobId: string): Promise<RepositoryEmbeddingJob | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM repository_embedding_jobs WHERE id = $1`, [jobId]);
    return result.rows[0] ? this.rowToJob(result.rows[0]) : undefined;
  }

  async getLatestJobForRepository(repositoryId: string): Promise<RepositoryEmbeddingJob | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM repository_embedding_jobs WHERE repository_id = $1 ORDER BY created_at DESC LIMIT 1`, [repositoryId]);
    return result.rows[0] ? this.rowToJob(result.rows[0]) : undefined;
  }

  async getLatestJobForCommit(repositoryId: string, commitSha: string): Promise<RepositoryEmbeddingJob | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT * FROM repository_embedding_jobs WHERE repository_id = $1 AND commit_sha = $2 ORDER BY created_at DESC LIMIT 1`,
      [repositoryId, commitSha],
    );
    return result.rows[0] ? this.rowToJob(result.rows[0]) : undefined;
  }

  /** Content-hash-scoped lookup — this (not chunk_id) is the real reuse identity, since a re-index of the same commit produces fresh chunk rows for byte-identical content (see the migration's comment). */
  async findExistingByContentHashes(
    repositoryId: string,
    commitSha: string,
    model: string,
    contentHashes: string[],
  ): Promise<Set<string>> {
    const pool = getPool();
    if (!pool || contentHashes.length === 0) return new Set();
    const result = await pool.query(
      `SELECT content_hash FROM repository_code_embeddings WHERE repository_id = $1 AND commit_sha = $2 AND model = $3 AND content_hash = ANY($4::text[])`,
      [repositoryId, commitSha, model, contentHashes],
    );
    return new Set((result.rows as { content_hash: string }[]).map((r) => r.content_hash));
  }

  /**
   * Bounded batch insert, one embedding job's worth of chunks at a time
   * (see repository-embedding-worker.ts's batching) — never the whole
   * repository in one statement. ON CONFLICT DO NOTHING makes this safe to
   * retry: a duplicate (repository, commit, content_hash, model) is silently
   * skipped rather than erroring the whole batch, since the real
   * uniqueness constraint is the database's, not this check.
   */
  async insertEmbeddingsBatch(embeddings: InsertEmbeddingInput[]): Promise<void> {
    if (embeddings.length === 0) return;
    const pool = getPool();
    if (!pool) return;

    const columns = ['id', 'repository_id', 'embedding_job_id', 'chunk_id', 'commit_sha', 'model', 'dimensions', 'content_hash', 'embedding'];
    const values: unknown[] = [];
    const placeholders = embeddings.map((e, rowIndex) => {
      const base = rowIndex * columns.length;
      values.push(e.id, e.repositoryId, e.embeddingJobId, e.chunkId, e.commitSha, e.model, e.dimensions, e.contentHash, toVectorLiteral(e.vector));
      return `(${columns.map((_, colIndex) => `$${base + colIndex + 1}`).join(', ')})`;
    });

    await pool.query(
      `INSERT INTO repository_code_embeddings (${columns.join(', ')}) VALUES ${placeholders.join(', ')}
       ON CONFLICT (repository_id, commit_sha, content_hash, model) DO NOTHING`,
      values,
    );
  }

  async countEmbeddings(repositoryId: string, commitSha: string, model: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM repository_code_embeddings WHERE repository_id = $1 AND commit_sha = $2 AND model = $3`,
      [repositoryId, commitSha, model],
    );
    return (result.rows[0]?.count as number) ?? 0;
  }

  /** Cleanup for a cancelled/failed job — removes only the rows THIS job actually inserted (reused rows from a prior job keep their original embedding_job_id and are never touched). */
  async deleteEmbeddingsForJob(embeddingJobId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`DELETE FROM repository_code_embeddings WHERE embedding_job_id = $1`, [embeddingJobId]);
  }

  private rowToJob(row: Record<string, unknown>): RepositoryEmbeddingJob {
    return {
      jobId: row.id as string,
      repositoryId: row.repository_id as string,
      indexJobId: row.index_job_id as string,
      ownerId: (row.owner_id as string) ?? undefined,
      commitSha: row.commit_sha as string,
      status: row.status as RepositoryEmbeddingStatus,
      model: row.model as string,
      dimensions: (row.dimensions as number) ?? undefined,
      totalChunks: (row.total_chunks as number) ?? undefined,
      embeddedChunks: (row.embedded_chunks as number) ?? undefined,
      skippedChunks: (row.skipped_chunks as number) ?? undefined,
      failedChunks: (row.failed_chunks as number) ?? undefined,
      error: (row.error as string) ?? undefined,
      errorCategory: (row.error_category as EmbeddingErrorCategory) ?? undefined,
      startedAt: row.started_at ? (row.started_at as Date).toISOString() : undefined,
      completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : undefined,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}
