import type { RepositoryIssue } from '@origami/contracts';
import { RepositoryIssueRepository, type CreateIssueInput } from './db/repository-issue-repository.js';
import { RepositoryIssueStore } from './repository-issue-store.js';

/** Unifies the always-available legacy store with the Postgres-backed repository — same dual-write/pg-primary-with-fallback pattern as every other unified store in this project. */
export class UnifiedRepositoryIssueStore {
  private legacy = new RepositoryIssueStore();
  private repo = new RepositoryIssueRepository();

  getRepository(): RepositoryIssueRepository {
    return this.repo;
  }

  async create(input: CreateIssueInput): Promise<RepositoryIssue> {
    const issue = this.legacy.create(input);
    if (this.repo.isEnabled()) await this.repo.create(input);
    return issue;
  }

  async getByIdAsync(issueId: string): Promise<RepositoryIssue | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getById(issueId);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-repository-issue-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getById(issueId);
  }

  async listForRepositoryAsync(repositoryId: string): Promise<RepositoryIssue[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.listForRepository(repositoryId);
      } catch (error) {
        console.error('[unified-repository-issue-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.listForRepository(repositoryId);
  }

  async updateStatus(issueId: string, status: RepositoryIssue['status']): Promise<void> {
    this.legacy.updateStatus(issueId, status);
    if (this.repo.isEnabled()) await this.repo.updateStatus(issueId, { status }).catch(() => {});
  }
}
