import type { RepositoryCloneJob, RepositoryCloneStatus, RepositoryDiscoveryMetadata } from '@origami/contracts';
import { RepositoryCloneRepository } from './db/repository-clone-repository.js';
import { RepositoryCloneStore } from './repository-clone-store.js';

export interface CreateCloneJobInput {
  id: string;
  repositoryId: string;
  ownerId?: string;
}

export interface CompleteCloneJobInput {
  status: RepositoryCloneStatus;
  commitSha?: string;
  discovery?: RepositoryDiscoveryMetadata;
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Unifies the always-available legacy store with the Postgres-backed repository — same dual-write/pg-primary-with-fallback pattern as UnifiedRepositoryStore (Phase 1) and UnifiedComponentStore. */
export class UnifiedRepositoryCloneStore {
  private legacy = new RepositoryCloneStore();
  private repo = new RepositoryCloneRepository();

  getRepository(): RepositoryCloneRepository {
    return this.repo;
  }

  async create(input: CreateCloneJobInput): Promise<RepositoryCloneJob> {
    const now = nowIso();
    const job: RepositoryCloneJob = {
      jobId: input.id,
      repositoryId: input.repositoryId,
      ownerId: input.ownerId,
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
    };
    this.legacy.save(job);
    if (this.repo.isEnabled()) {
      await this.repo.createJob(input);
    }
    return job;
  }

  async markRunning(jobId: string, clonePath: string): Promise<void> {
    const existing = this.legacy.getById(jobId);
    if (existing) {
      this.legacy.save({ ...existing, status: 'RUNNING', startedAt: nowIso(), updatedAt: nowIso() });
    }
    if (this.repo.isEnabled()) {
      await this.repo.markRunning(jobId, clonePath).catch(() => {});
    }
  }

  async complete(jobId: string, data: CompleteCloneJobInput): Promise<void> {
    const existing = this.legacy.getById(jobId);
    if (existing) {
      this.legacy.save({
        ...existing,
        status: data.status,
        commitSha: data.commitSha,
        discovery: data.discovery,
        error: data.error,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
    if (this.repo.isEnabled()) {
      await this.repo.complete(jobId, data).catch(() => {});
    }
  }

  async getByIdAsync(jobId: string): Promise<RepositoryCloneJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getById(jobId);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-repository-clone-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getById(jobId);
  }

  async getLatestForRepositoryAsync(repositoryId: string): Promise<RepositoryCloneJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getLatestForRepository(repositoryId);
      } catch (error) {
        console.error('[unified-repository-clone-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getLatestForRepository(repositoryId);
  }
}
