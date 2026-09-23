import type { CreateWorkflowInput, RepositoryFixWorkflowRecord, UpdateWorkflowProgressInput } from './db/repository-fix-workflow-repository.js';
import { RepositoryFixWorkflowRepository } from './db/repository-fix-workflow-repository.js';
import { RepositoryFixWorkflowStore } from './repository-fix-workflow-store.js';

/** Unifies the always-available legacy store with the Postgres-backed repository — same dual-write/pg-primary-with-fallback pattern as every other unified store in this project. */
export class UnifiedRepositoryFixWorkflowStore {
  private legacy = new RepositoryFixWorkflowStore();
  private repo = new RepositoryFixWorkflowRepository();

  getRepository(): RepositoryFixWorkflowRepository {
    return this.repo;
  }

  async create(input: CreateWorkflowInput): Promise<RepositoryFixWorkflowRecord> {
    const record = this.legacy.create(input);
    if (this.repo.isEnabled()) await this.repo.create(input);
    return record;
  }

  async getByIdAsync(id: string): Promise<RepositoryFixWorkflowRecord | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getById(id);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-repository-fix-workflow-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getById(id);
  }

  /**
   * Real DB-level atomic claim when Postgres is enabled; single-process
   * synchronous claim in the legacy fallback (see repository-fix-workflow-store.ts's
   * doc comment for that tier's limitation). Returns `{claimed:true, workflow}`
   * only for the caller that actually won the transition out of REVIEWABLE;
   * every other (concurrent or later) caller gets `{claimed:false, workflow}`
   * with the CURRENT row so it can report the already-in-progress/already-
   * completed state instead of starting a second execution.
   */
  async claimForApprovalAsync(id: string): Promise<{ claimed: boolean; workflow: RepositoryFixWorkflowRecord | undefined }> {
    if (this.repo.isEnabled()) {
      try {
        const claimed = await this.repo.claimForApproval(id);
        if (claimed) return { claimed: true, workflow: claimed };
        return { claimed: false, workflow: await this.getByIdAsync(id) };
      } catch (error) {
        console.error('[unified-repository-fix-workflow-store] Postgres claim failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    const claimed = this.legacy.claimForApproval(id);
    if (claimed) return { claimed: true, workflow: claimed };
    return { claimed: false, workflow: this.legacy.getById(id) };
  }

  async updateProgressAsync(id: string, data: UpdateWorkflowProgressInput): Promise<void> {
    this.legacy.updateProgress(id, data);
    if (this.repo.isEnabled()) await this.repo.updateProgress(id, data).catch(() => {});
  }

  async listExpiredReviewableAsync(nowIso: string): Promise<RepositoryFixWorkflowRecord[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.listExpiredReviewable(nowIso);
      } catch (error) {
        console.error('[unified-repository-fix-workflow-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.listExpiredReviewable(nowIso);
  }
}
