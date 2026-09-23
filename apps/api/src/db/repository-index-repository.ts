import type { RepositoryIndexJob, RepositoryIndexStatus, RepositoryIndexedFileStatus } from '@origami/contracts';
import { getPool } from './pool.js';

interface CreateIndexJobInput {
  id: string;
  repositoryId: string;
  cloneJobId: string;
  ownerId?: string;
  commitSha: string;
}

interface CompleteIndexJobInput {
  status: RepositoryIndexStatus;
  filesIndexed?: number;
  filesSkipped?: number;
  chunksCreated?: number;
  error?: string;
}

export interface InsertIndexFileInput {
  id: string;
  indexJobId: string;
  repositoryId: string;
  commitSha: string;
  filePath: string;
  language: string;
  fileSizeBytes: number;
  contentHash?: string;
  status: RepositoryIndexedFileStatus;
  error?: string;
}

export interface InsertCodeChunkInput {
  id: string;
  indexJobId: string;
  repositoryId: string;
  commitSha: string;
  fileId: string;
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  isExported: boolean;
  content: string;
  contentHash: string;
  chunkKey: string;
}

const CHUNK_COLUMNS = [
  'id', 'index_job_id', 'repository_id', 'commit_sha', 'file_id', 'file_path', 'language',
  'symbol', 'symbol_type', 'parent_symbol', 'start_line', 'end_line', 'start_column', 'end_column',
  'is_exported', 'content', 'content_hash', 'chunk_key',
];

export class RepositoryIndexRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async createJob(input: CreateIndexJobInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `INSERT INTO repository_index_jobs (id, repository_id, clone_job_id, owner_id, commit_sha, status)
       VALUES ($1, $2, $3, $4, $5, 'QUEUED')`,
      [input.id, input.repositoryId, input.cloneJobId, input.ownerId ?? null, input.commitSha],
    );
  }

  async markRunning(jobId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE repository_index_jobs SET status = 'RUNNING', started_at = NOW(), updated_at = NOW() WHERE id = $1`, [jobId]);
  }

  async completeJob(jobId: string, data: CompleteIndexJobInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `UPDATE repository_index_jobs SET status = $2, files_indexed = $3, files_skipped = $4, chunks_created = $5, error = $6, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [jobId, data.status, data.filesIndexed ?? null, data.filesSkipped ?? null, data.chunksCreated ?? null, data.error ?? null],
    );
  }

  async getJobById(jobId: string): Promise<RepositoryIndexJob | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM repository_index_jobs WHERE id = $1`, [jobId]);
    return result.rows[0] ? this.rowToJob(result.rows[0]) : undefined;
  }

  async getLatestJobForRepository(repositoryId: string): Promise<RepositoryIndexJob | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM repository_index_jobs WHERE repository_id = $1 ORDER BY created_at DESC LIMIT 1`, [repositoryId]);
    return result.rows[0] ? this.rowToJob(result.rows[0]) : undefined;
  }

  /** Scoped to repository + commit — the basis for "do not run multiple index jobs simultaneously for repository + commit SHA". */
  async getLatestJobForCommit(repositoryId: string, commitSha: string): Promise<RepositoryIndexJob | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT * FROM repository_index_jobs WHERE repository_id = $1 AND commit_sha = $2 ORDER BY created_at DESC LIMIT 1`,
      [repositoryId, commitSha],
    );
    return result.rows[0] ? this.rowToJob(result.rows[0]) : undefined;
  }

  async insertFile(input: InsertIndexFileInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO repository_index_files (id, index_job_id, repository_id, commit_sha, file_path, language, file_size_bytes, content_hash, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [input.id, input.indexJobId, input.repositoryId, input.commitSha, input.filePath, input.language, input.fileSizeBytes, input.contentHash ?? null, input.status, input.error ?? null],
    );
  }

  /** Bounded multi-row insert — see repository-index-worker.ts's batching for why this is never called with an unbounded array. */
  async insertChunksBatch(chunks: InsertCodeChunkInput[]): Promise<void> {
    if (chunks.length === 0) return;
    const pool = getPool();
    if (!pool) return;

    const values: unknown[] = [];
    const placeholders = chunks.map((chunk, rowIndex) => {
      const row = [
        chunk.id, chunk.indexJobId, chunk.repositoryId, chunk.commitSha, chunk.fileId, chunk.filePath, chunk.language,
        chunk.symbol, chunk.symbolType, chunk.parentSymbol, chunk.startLine, chunk.endLine, chunk.startColumn, chunk.endColumn,
        chunk.isExported, chunk.content, chunk.contentHash, chunk.chunkKey,
      ];
      const base = rowIndex * CHUNK_COLUMNS.length;
      values.push(...row);
      return `(${CHUNK_COLUMNS.map((_, colIndex) => `$${base + colIndex + 1}`).join(', ')})`;
    });

    await pool.query(
      `INSERT INTO repository_code_chunks (${CHUNK_COLUMNS.join(', ')}) VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  async getFileCounts(indexJobId: string): Promise<{ indexed: number; skipped: number }> {
    const pool = getPool();
    if (!pool) return { indexed: 0, skipped: 0 };
    const result = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM repository_index_files WHERE index_job_id = $1 GROUP BY status`,
      [indexJobId],
    );
    let indexed = 0;
    let skipped = 0;
    for (const row of result.rows as { status: string; count: number }[]) {
      if (row.status === 'INDEXED') indexed += row.count;
      else skipped += row.count;
    }
    return { indexed, skipped };
  }

  async getChunkCount(indexJobId: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM repository_code_chunks WHERE index_job_id = $1`, [indexJobId]);
    return (result.rows[0]?.count as number) ?? 0;
  }

  /**
   * Full chunk rows for one index job — added for Phase 4 (BGE-M3
   * embeddings), which reads Phase 3's persisted chunks as its input. Purely
   * additive: no existing method's behavior changes. Chunk volume per job is
   * already bounded by Phase 3's REPOSITORY_MAX_FILE_COUNT/size limits, so a
   * single query is acceptable here — the embedding worker itself still
   * batches the expensive parts (model calls, vector inserts) via
   * AI_EMBED_BATCH_SIZE, which is what actually protects memory/GPU/network.
   */
  async getChunksForJob(indexJobId: string): Promise<InsertCodeChunkInput[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT id, index_job_id, repository_id, commit_sha, file_id, file_path, language, symbol, symbol_type,
              parent_symbol, start_line, end_line, start_column, end_column, is_exported, content, content_hash, chunk_key
       FROM repository_code_chunks WHERE index_job_id = $1 ORDER BY file_path, start_line`,
      [indexJobId],
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      indexJobId: row.index_job_id as string,
      repositoryId: row.repository_id as string,
      commitSha: row.commit_sha as string,
      fileId: row.file_id as string,
      filePath: row.file_path as string,
      language: row.language as string,
      symbol: row.symbol as string,
      symbolType: row.symbol_type as string,
      parentSymbol: (row.parent_symbol as string) ?? null,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      startColumn: row.start_column as number,
      endColumn: row.end_column as number,
      isExported: row.is_exported as boolean,
      content: row.content as string,
      contentHash: row.content_hash as string,
      chunkKey: row.chunk_key as string,
    }));
  }

  /** Indexed-file count per language — computed from real rows, matching "must be calculated from actual indexed files." */
  async getLanguageDistribution(indexJobId: string): Promise<Record<string, number>> {
    const pool = getPool();
    if (!pool) return {};
    const result = await pool.query(
      `SELECT language, COUNT(*)::int AS count FROM repository_index_files WHERE index_job_id = $1 AND status = 'INDEXED' GROUP BY language`,
      [indexJobId],
    );
    return Object.fromEntries((result.rows as { language: string; count: number }[]).map((row) => [row.language, row.count]));
  }

  /**
   * Phase 8 — indexed file records (path/language/status/contentHash) for
   * one index job, used by repository-issue-service.ts to validate that a
   * user-supplied filePath genuinely exists in the indexed commit before an
   * issue can reference it, and by repository-fix-service.ts to look up the
   * trusted contentHash for a file a proposed diff touches. Purely
   * additive — mirrors getChunksForJob's exact shape/rationale.
   */
  async getFilesForJob(indexJobId: string): Promise<InsertIndexFileInput[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT id, index_job_id, repository_id, commit_sha, file_path, language, file_size_bytes, content_hash, status, error
       FROM repository_index_files WHERE index_job_id = $1 ORDER BY file_path`,
      [indexJobId],
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      indexJobId: row.index_job_id as string,
      repositoryId: row.repository_id as string,
      commitSha: row.commit_sha as string,
      filePath: row.file_path as string,
      language: row.language as string,
      fileSizeBytes: Number(row.file_size_bytes),
      contentHash: (row.content_hash as string) ?? undefined,
      status: row.status as InsertIndexFileInput['status'],
      error: (row.error as string) ?? undefined,
    }));
  }

  /** Deletes this job's file/chunk rows (chunks cascade automatically via file_id) — used on cancellation/failure so Phase 4 never searches a partial index. The job row itself is kept as a CANCELLED/FAILED history record. */
  async deletePartialIndex(indexJobId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`DELETE FROM repository_index_files WHERE index_job_id = $1`, [indexJobId]);
  }

  private rowToJob(row: Record<string, unknown>): RepositoryIndexJob {
    return {
      jobId: row.id as string,
      repositoryId: row.repository_id as string,
      cloneJobId: row.clone_job_id as string,
      ownerId: (row.owner_id as string) ?? undefined,
      commitSha: row.commit_sha as string,
      status: row.status as RepositoryIndexStatus,
      indexerVersion: row.indexer_version as string,
      filesIndexed: (row.files_indexed as number) ?? undefined,
      filesSkipped: (row.files_skipped as number) ?? undefined,
      chunksCreated: (row.chunks_created as number) ?? undefined,
      error: (row.error as string) ?? undefined,
      startedAt: row.started_at ? (row.started_at as Date).toISOString() : undefined,
      completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : undefined,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}
