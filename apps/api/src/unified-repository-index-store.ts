import type { RepositoryIndexJob, RepositoryIndexStatus } from '@origami/contracts';
import { RepositoryIndexRepository, type InsertCodeChunkInput, type InsertIndexFileInput } from './db/repository-index-repository.js';
import { RepositoryIndexStore } from './repository-index-store.js';

/** Bumped only if the extraction/chunking algorithm changes in a way that would produce different output for the same input — see the Phase 3 report's determinism section. */
export const INDEXER_VERSION = '1';

export interface CreateIndexJobInput {
  id: string;
  repositoryId: string;
  cloneJobId: string;
  ownerId?: string;
  commitSha: string;
}

export interface CompleteIndexJobInput {
  status: RepositoryIndexStatus;
  filesIndexed?: number;
  filesSkipped?: number;
  chunksCreated?: number;
  error?: string;
}

export interface RepositoryIndexSummaryCounts {
  filesIndexed: number;
  filesSkipped: number;
  chunksCreated: number;
  languages: Record<string, number>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Unifies the always-available legacy store with the Postgres-backed repository — same dual-write/pg-primary-with-fallback pattern as Phases 1-2's unified stores. */
export class UnifiedRepositoryIndexStore {
  private legacy = new RepositoryIndexStore();
  private repo = new RepositoryIndexRepository();

  getRepository(): RepositoryIndexRepository {
    return this.repo;
  }

  async create(input: CreateIndexJobInput): Promise<RepositoryIndexJob> {
    const now = nowIso();
    const job: RepositoryIndexJob = {
      jobId: input.id,
      repositoryId: input.repositoryId,
      cloneJobId: input.cloneJobId,
      ownerId: input.ownerId,
      commitSha: input.commitSha,
      status: 'QUEUED',
      indexerVersion: INDEXER_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    this.legacy.saveJob(job);
    if (this.repo.isEnabled()) await this.repo.createJob(input);
    return job;
  }

  async markRunning(jobId: string): Promise<void> {
    const existing = this.legacy.getJobById(jobId);
    if (existing) this.legacy.saveJob({ ...existing, status: 'RUNNING', startedAt: nowIso(), updatedAt: nowIso() });
    if (this.repo.isEnabled()) await this.repo.markRunning(jobId).catch(() => {});
  }

  async complete(jobId: string, data: CompleteIndexJobInput): Promise<void> {
    const existing = this.legacy.getJobById(jobId);
    if (existing) {
      this.legacy.saveJob({
        ...existing,
        status: data.status,
        filesIndexed: data.filesIndexed,
        filesSkipped: data.filesSkipped,
        chunksCreated: data.chunksCreated,
        error: data.error,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
    if (this.repo.isEnabled()) await this.repo.completeJob(jobId, data).catch(() => {});
  }

  async getByIdAsync(jobId: string): Promise<RepositoryIndexJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getJobById(jobId);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-repository-index-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getJobById(jobId);
  }

  async getLatestForRepositoryAsync(repositoryId: string): Promise<RepositoryIndexJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getLatestJobForRepository(repositoryId);
      } catch (error) {
        console.error('[unified-repository-index-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getLatestJobForRepository(repositoryId);
  }

  async getLatestForCommitAsync(repositoryId: string, commitSha: string): Promise<RepositoryIndexJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getLatestJobForCommit(repositoryId, commitSha);
      } catch (error) {
        console.error('[unified-repository-index-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getLatestJobForCommit(repositoryId, commitSha);
  }

  async insertFile(input: InsertIndexFileInput): Promise<void> {
    this.legacy.insertFile(input);
    if (this.repo.isEnabled()) await this.repo.insertFile(input).catch(() => {});
  }

  async insertChunksBatch(chunks: InsertCodeChunkInput[]): Promise<void> {
    if (chunks.length === 0) return;
    this.legacy.insertChunksBatch(chunks);
    if (this.repo.isEnabled()) await this.repo.insertChunksBatch(chunks).catch(() => {});
  }

  async getSummaryAsync(indexJobId: string): Promise<RepositoryIndexSummaryCounts> {
    if (this.repo.isEnabled()) {
      try {
        const [{ indexed, skipped }, chunksCreated, languages] = await Promise.all([
          this.repo.getFileCounts(indexJobId),
          this.repo.getChunkCount(indexJobId),
          this.repo.getLanguageDistribution(indexJobId),
        ]);
        return { filesIndexed: indexed, filesSkipped: skipped, chunksCreated, languages };
      } catch (error) {
        console.error('[unified-repository-index-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    const { indexed, skipped } = this.legacy.getFileCounts(indexJobId);
    return { filesIndexed: indexed, filesSkipped: skipped, chunksCreated: this.legacy.getChunkCount(indexJobId), languages: this.legacy.getLanguageDistribution(indexJobId) };
  }

  /** Removes this job's partial file/chunk rows — used on cancellation/failure so a partial index is never left in a searchable state (see the Phase 3 report's cleanup policy). */
  async deletePartialIndex(indexJobId: string): Promise<void> {
    this.legacy.deletePartialIndex(indexJobId);
    if (this.repo.isEnabled()) await this.repo.deletePartialIndex(indexJobId).catch(() => {});
  }

  /** Added for Phase 4 (BGE-M3 embeddings) — reads Phase 3's persisted chunks as embedding input. Purely additive; every method above is unchanged. */
  async getChunksForJobAsync(indexJobId: string): Promise<InsertCodeChunkInput[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getChunksForJob(indexJobId);
      } catch (error) {
        console.error('[unified-repository-index-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getChunksForJob(indexJobId);
  }

  /** Added for Phase 8 (repository issue creation + fix validation) — see the matching addition on RepositoryIndexRepository. Purely additive. */
  async getFilesForJobAsync(indexJobId: string): Promise<InsertIndexFileInput[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getFilesForJob(indexJobId);
      } catch (error) {
        console.error('[unified-repository-index-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getFilesForJob(indexJobId);
  }
}
