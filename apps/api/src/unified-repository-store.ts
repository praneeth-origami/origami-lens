import type { Repository, RepositoryProvider } from '@origami/contracts';
import { DuplicateRepositoryError, RepositoryRepository } from './db/repository-repository.js';
import { RepositoryStore } from './repository-store.js';

export { DuplicateRepositoryError };

export interface CreateRepositoryInput {
  id: string;
  /** The authenticated owner (Phase 16/B) — always request.user.id, never client-supplied. */
  userId: string;
  repoUrl: string;
  provider: RepositoryProvider;
  branch: string;
}

export class UnifiedRepositoryStore {
  private legacy = new RepositoryStore();
  private repo = new RepositoryRepository();

  getRepository(): RepositoryRepository {
    return this.repo;
  }

  /** Throws DuplicateRepositoryError if this user+repoUrl+branch is already connected — checked against the legacy store first (fast path, always available) and authoritatively enforced by Postgres's own unique constraint when configured. */
  async create(input: CreateRepositoryInput): Promise<Repository> {
    const existing = this.legacy.findDuplicate(input.userId, input.repoUrl, input.branch);
    if (existing) {
      throw new DuplicateRepositoryError();
    }

    if (this.repo.isEnabled()) {
      const created = await this.repo.create(input);
      this.legacy.save(created);
      return created;
    }

    const now = new Date().toISOString();
    const created: Repository = {
      id: input.id,
      userId: input.userId,
      repoUrl: input.repoUrl,
      provider: input.provider,
      branch: input.branch,
      status: 'CONNECTED',
      createdAt: now,
      updatedAt: now,
    };
    return this.legacy.save(created);
  }

  /** Updates repository-level state (see RepositoryStatus) — a no-op if the repository doesn't exist. Used by the Phase 2 clone worker to move CONNECTED -> CLONING -> READY_FOR_INDEXING/FAILED; never used for clone job status itself. */
  async updateStatus(id: string, status: Repository['status']): Promise<Repository | undefined> {
    const existing = await this.getByIdAsync(id);
    if (!existing) return undefined;

    const updated: Repository = { ...existing, status, updatedAt: new Date().toISOString() };
    this.legacy.save(updated);
    if (this.repo.isEnabled()) {
      await this.repo.updateStatus(id, status).catch(() => {});
    }
    return updated;
  }

  async getByIdAsync(id: string): Promise<Repository | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getById(id);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-repository-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getById(id);
  }

  /** Phase 16/B — the authorization-aware lookup: filters at the SQL layer when Postgres is configured, so a row belonging to another user never leaves the database. Returns undefined for "doesn't exist" and "exists but isn't yours" identically. */
  async getByIdForUserAsync(id: string, userId: string): Promise<Repository | undefined> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getByIdForUser(id, userId);
      } catch (error) {
        console.error('[unified-repository-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getByIdForUser(id, userId);
  }

  async listAsync(ownerId?: string): Promise<Repository[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.list(ownerId);
      } catch (error) {
        console.error('[unified-repository-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.list(ownerId);
  }

  /** Phase 16/B — the only listing a real, authenticated caller ever gets: always scoped to their own userId, never an optional filter. */
  async listForUserAsync(userId: string): Promise<Repository[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.listForUser(userId);
      } catch (error) {
        console.error('[unified-repository-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.listForUser(userId);
  }
}
