import type { Repository, RepositoryProvider, RepositoryRole } from '@origami/contracts';
import { DuplicateRepositoryError, RepositoryRepository } from './db/repository-repository.js';
import { RepositoryStore } from './repository-store.js';

export { DuplicateRepositoryError };

export interface CreateRepositoryInput {
  id: string;
  /** Who created this connection (audit only) — always request.user.id, never client-supplied. */
  userId: string;
  /**
   * The real ownership boundary (Phase 2) — always the creating user's
   * organization, resolved server-side (see index.ts's resolveOrganizationIds),
   * never client-supplied. Optional and defaults to `userId` only so the many
   * existing single-user worker/service tests that predate organizations
   * don't all need updating to pass one explicitly — every real production
   * caller resolves and passes a real organization id.
   */
  organizationId?: string;
  repoUrl: string;
  provider: RepositoryProvider;
  branch: string;
  /** Which layer this repository represents (migration 019) — optional, defaults to FULL_STACK (matches every pre-existing repository) when omitted. */
  role?: RepositoryRole;
}

export class UnifiedRepositoryStore {
  private legacy = new RepositoryStore();
  private repo = new RepositoryRepository();

  getRepository(): RepositoryRepository {
    return this.repo;
  }

  /** Throws DuplicateRepositoryError if this organization+repoUrl+branch is already connected — checked against the legacy store first (fast path, always available) and authoritatively enforced by Postgres's own unique constraint when configured. */
  async create(input: CreateRepositoryInput): Promise<Repository> {
    const organizationId = input.organizationId ?? input.userId;
    const existing = this.legacy.findDuplicate(organizationId, input.repoUrl, input.branch);
    if (existing) {
      throw new DuplicateRepositoryError();
    }

    if (this.repo.isEnabled()) {
      const created = await this.repo.create({ ...input, organizationId });
      this.legacy.save(created);
      return created;
    }

    const now = new Date().toISOString();
    const created: Repository = {
      id: input.id,
      userId: input.userId,
      organizationId,
      repoUrl: input.repoUrl,
      provider: input.provider,
      branch: input.branch,
      status: 'CONNECTED',
      role: input.role ?? 'FULL_STACK',
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

  /** Phase 2 — the authorization-aware lookup: filters at the SQL layer when Postgres is configured, so a row belonging to another organization never leaves the database. Returns undefined for "doesn't exist" and "exists but isn't yours" identically. Takes every organization the caller belongs to (today always exactly their one personal org). */
  async getByIdForOrganizationsAsync(id: string, organizationIds: string[]): Promise<Repository | undefined> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getByIdForOrganizations(id, organizationIds);
      } catch (error) {
        console.error('[unified-repository-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getByIdForOrganizations(id, organizationIds);
  }

  /**
   * Deletes a repository (and, when Postgres is configured, everything
   * cascaded from it — clone/index/embedding jobs, repository issues, fix
   * workflows) but only if it belongs to one of the caller's organizations.
   * Removed from BOTH stores when both are active, mirroring create()'s
   * dual-write, so the legacy mirror never resurrects a repository the real
   * store already deleted. Returns false for "doesn't exist" and "exists
   * but isn't yours" identically. The on-disk clone workspace is NOT
   * removed here — see index.ts's DELETE /repositories/:id route.
   */
  async deleteForOrganizationsAsync(id: string, organizationIds: string[]): Promise<boolean> {
    let deleted = false;
    if (this.repo.isEnabled()) {
      try {
        deleted = await this.repo.deleteForOrganizations(id, organizationIds);
      } catch (error) {
        console.error('[unified-repository-store] Postgres delete failed:', error instanceof Error ? error.message : error);
      }
    }
    const deletedFromLegacy = this.legacy.deleteForOrganizations(id, organizationIds);
    return deleted || deletedFromLegacy;
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

  /** Phase 2 — the only listing a real, authenticated caller ever gets: always scoped to every organization they belong to, never an optional filter. */
  async listForOrganizationsAsync(organizationIds: string[]): Promise<Repository[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.listForOrganizations(organizationIds);
      } catch (error) {
        console.error('[unified-repository-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.listForOrganizations(organizationIds);
  }
}
