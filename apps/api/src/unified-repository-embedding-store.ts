import type { EmbeddingErrorCategory, RepositoryEmbeddingJob, RepositoryEmbeddingStatus } from '@origami/contracts';
import { RepositoryEmbeddingRepository, type InsertEmbeddingInput } from './db/repository-embedding-repository.js';
import { RepositoryEmbeddingStore } from './repository-embedding-store.js';

export interface CreateEmbeddingJobInput {
  id: string;
  repositoryId: string;
  indexJobId: string;
  ownerId?: string;
  commitSha: string;
  model: string;
}

export interface CompleteEmbeddingJobInput {
  status: RepositoryEmbeddingStatus;
  dimensions?: number;
  totalChunks?: number;
  embeddedChunks?: number;
  skippedChunks?: number;
  failedChunks?: number;
  error?: string;
  errorCategory?: EmbeddingErrorCategory;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Unifies the always-available legacy store with the Postgres-backed repository — same dual-write/pg-primary-with-fallback pattern as Phases 1-3's unified stores. */
export class UnifiedRepositoryEmbeddingStore {
  private legacy = new RepositoryEmbeddingStore();
  private repo = new RepositoryEmbeddingRepository();

  getRepository(): RepositoryEmbeddingRepository {
    return this.repo;
  }

  async create(input: CreateEmbeddingJobInput): Promise<RepositoryEmbeddingJob> {
    const now = nowIso();
    const job: RepositoryEmbeddingJob = {
      jobId: input.id,
      repositoryId: input.repositoryId,
      indexJobId: input.indexJobId,
      ownerId: input.ownerId,
      commitSha: input.commitSha,
      status: 'QUEUED',
      model: input.model,
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

  async complete(jobId: string, data: CompleteEmbeddingJobInput): Promise<void> {
    const existing = this.legacy.getJobById(jobId);
    if (existing) {
      this.legacy.saveJob({
        ...existing,
        status: data.status,
        dimensions: data.dimensions ?? existing.dimensions,
        totalChunks: data.totalChunks,
        embeddedChunks: data.embeddedChunks,
        skippedChunks: data.skippedChunks,
        failedChunks: data.failedChunks,
        error: data.error,
        errorCategory: data.errorCategory,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
    if (this.repo.isEnabled()) await this.repo.completeJob(jobId, data).catch(() => {});
  }

  async getByIdAsync(jobId: string): Promise<RepositoryEmbeddingJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getJobById(jobId);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-repository-embedding-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getJobById(jobId);
  }

  async getLatestForRepositoryAsync(repositoryId: string): Promise<RepositoryEmbeddingJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getLatestJobForRepository(repositoryId);
      } catch (error) {
        console.error('[unified-repository-embedding-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getLatestJobForRepository(repositoryId);
  }

  async getLatestForCommitAsync(repositoryId: string, commitSha: string): Promise<RepositoryEmbeddingJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getLatestJobForCommit(repositoryId, commitSha);
      } catch (error) {
        console.error('[unified-repository-embedding-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getLatestJobForCommit(repositoryId, commitSha);
  }

  async findExistingByContentHashesAsync(repositoryId: string, commitSha: string, model: string, contentHashes: string[]): Promise<Set<string>> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.findExistingByContentHashes(repositoryId, commitSha, model, contentHashes);
      } catch (error) {
        console.error('[unified-repository-embedding-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.findExistingByContentHashes(repositoryId, commitSha, model, contentHashes);
  }

  async insertEmbeddingsBatch(embeddings: InsertEmbeddingInput[]): Promise<void> {
    if (embeddings.length === 0) return;
    this.legacy.insertEmbeddingsBatch(embeddings);
    if (this.repo.isEnabled()) await this.repo.insertEmbeddingsBatch(embeddings).catch(() => {});
  }

  async countEmbeddingsAsync(repositoryId: string, commitSha: string, model: string): Promise<number> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.countEmbeddings(repositoryId, commitSha, model);
      } catch (error) {
        console.error('[unified-repository-embedding-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.countEmbeddings(repositoryId, commitSha, model);
  }

  /** Added for Phase 5 (search) — legacy-store-only accessor used by the no-Postgres vector-search fallback (see repository-search-service.ts). The real production path always uses pgvector's native `<=>` operator via RepositorySearchRepository instead. */
  getEmbeddingsForCommitLegacy(repositoryId: string, commitSha: string, model: string): InsertEmbeddingInput[] {
    return this.legacy.getEmbeddingsForCommit(repositoryId, commitSha, model);
  }

  /** Removes only the rows the given job actually inserted — used on cancellation/failure so a partial embedding run never masquerades as complete (see the Phase 4 report's cleanup policy). Reused rows from an earlier job are untouched. */
  async deleteEmbeddingsForJob(embeddingJobId: string): Promise<void> {
    this.legacy.deleteEmbeddingsForJob(embeddingJobId);
    if (this.repo.isEnabled()) await this.repo.deleteEmbeddingsForJob(embeddingJobId).catch(() => {});
  }
}
