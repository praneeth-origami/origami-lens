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
}
