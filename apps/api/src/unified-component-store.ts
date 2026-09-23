import type { ComponentEvidence, ComponentGenerationJob, ComponentJobListItem } from '@origami/contracts';
import { ComponentRepository } from './db/component-repository.js';
import { ComponentJobStore } from './component-store.js';

export class UnifiedComponentStore {
  private legacy = new ComponentJobStore();
  private repo = new ComponentRepository();

  getRepository(): ComponentRepository {
    return this.repo;
  }

  saveJob(job: ComponentGenerationJob): void {
    this.legacy.saveJob(job);
  }

  async saveEvidence(jobId: string, evidence: ComponentEvidence): Promise<void> {
    this.legacy.saveEvidence(jobId, evidence);
    if (this.repo.isEnabled()) {
      await this.repo.saveEvidence(jobId, evidence).catch(() => {});
    }
  }

  async getEvidenceAsync(jobId: string): Promise<ComponentEvidence | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getEvidence(jobId);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-component-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getEvidence(jobId);
  }

  async getJobAsync(jobId: string): Promise<ComponentGenerationJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getJob(jobId);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-component-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getJob(jobId);
  }

  /** The authorization-aware lookup (UX audit follow-up) — filters at the SQL layer when Postgres is configured, so a job belonging to another organization never leaves the database. Returns undefined for "doesn't exist" and "exists but isn't yours" identically. */
  async getJobForOrganizationsAsync(jobId: string, organizationIds: string[]): Promise<ComponentGenerationJob | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getJobForOrganizations(jobId, organizationIds);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-component-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getJobForOrganizations(jobId, organizationIds);
  }

  /**
   * Deletes a component job but only if it belongs to one of the caller's
   * organizations — mirrors UnifiedRepositoryStore's deleteForOrganizationsAsync
   * exactly (removed from BOTH stores when both are active, so the legacy
   * mirror never resurrects a job the real store already deleted). Returns
   * false for "doesn't exist" and "exists but isn't yours" identically.
   * No on-disk workspace to clean up — a component job's evidence/result are
   * stored entirely in the row itself, unlike a repository's clone directory.
   */
  async deleteForOrganizationsAsync(jobId: string, organizationIds: string[]): Promise<boolean> {
    let deleted = false;
    if (this.repo.isEnabled()) {
      try {
        deleted = await this.repo.deleteForOrganizations(jobId, organizationIds);
      } catch (error) {
        console.error('[unified-component-store] Postgres delete failed:', error instanceof Error ? error.message : error);
      }
    }
    const deletedFromLegacy = this.legacy.deleteForOrganizations(jobId, organizationIds);
    return deleted || deletedFromLegacy;
  }

  async listJobsAsync(ownerId?: string): Promise<ComponentJobListItem[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.listJobs(ownerId);
      } catch (error) {
        console.error('[unified-component-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.listJobs();
  }

  /** The only listing a real, authenticated caller ever gets (UX audit follow-up) — always scoped to every organization they belong to, never an optional filter. */
  async listJobsForOrganizationsAsync(organizationIds: string[]): Promise<ComponentJobListItem[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.listJobsForOrganizations(organizationIds);
      } catch (error) {
        console.error('[unified-component-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.listJobsForOrganizations(organizationIds);
  }
}
