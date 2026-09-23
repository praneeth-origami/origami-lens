import type { RepositoryIssueAnalysis } from '@origami/contracts';
import { RepositoryIssueAnalysisRepository, type CompleteAnalysisInput, type CreateAnalysisInput } from './db/repository-issue-analysis-repository.js';
import { RepositoryIssueAnalysisStore } from './repository-issue-analysis-store.js';

/** Unifies the always-available legacy store with the Postgres-backed repository — same dual-write/pg-primary-with-fallback pattern as every other unified store in this project. */
export class UnifiedRepositoryIssueAnalysisStore {
  private legacy = new RepositoryIssueAnalysisStore();
  private repo = new RepositoryIssueAnalysisRepository();

  getRepository(): RepositoryIssueAnalysisRepository {
    return this.repo;
  }

  async create(input: CreateAnalysisInput): Promise<RepositoryIssueAnalysis> {
    const analysis = this.legacy.create(input);
    if (this.repo.isEnabled()) await this.repo.create(input);
    return analysis;
  }

  async markRunning(analysisId: string): Promise<void> {
    this.legacy.markRunning(analysisId);
    if (this.repo.isEnabled()) await this.repo.markRunning(analysisId).catch(() => {});
  }

  async complete(analysisId: string, data: CompleteAnalysisInput): Promise<void> {
    this.legacy.complete(analysisId, data);
    if (this.repo.isEnabled()) await this.repo.complete(analysisId, data).catch(() => {});
  }

  async getByIdAsync(analysisId: string): Promise<RepositoryIssueAnalysis | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getById(analysisId);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-repository-issue-analysis-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getById(analysisId);
  }

  async getLatestForIssueAsync(issueId: string): Promise<RepositoryIssueAnalysis | undefined> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.getLatestForIssue(issueId);
      } catch (error) {
        console.error('[unified-repository-issue-analysis-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getLatestForIssue(issueId);
  }

  /** Duplicate-job protection at the route/service layer — backed by (never a substitute for) the real Postgres partial unique index. */
  async hasActiveAnalysisAsync(issueId: string): Promise<boolean> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.hasActiveAnalysis(issueId);
      } catch (error) {
        console.error('[unified-repository-issue-analysis-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.hasActiveAnalysis(issueId);
  }
}
