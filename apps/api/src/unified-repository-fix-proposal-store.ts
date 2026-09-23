import type { RepositoryFixProposal } from '@origami/contracts';
import { RepositoryFixProposalRepository, type CompleteProposalInput, type CreateProposalInput } from './db/repository-fix-proposal-repository.js';
import { RepositoryFixProposalStore } from './repository-fix-proposal-store.js';

/** Unifies the always-available legacy store with the Postgres-backed repository — same dual-write/pg-primary-with-fallback pattern as every other unified store in this project. */
export class UnifiedRepositoryFixProposalStore {
  private legacy = new RepositoryFixProposalStore();
  private repo = new RepositoryFixProposalRepository();

  getRepository(): RepositoryFixProposalRepository {
    return this.repo;
  }

  async create(input: CreateProposalInput): Promise<RepositoryFixProposal> {
    const proposal = this.legacy.create(input);
    if (this.repo.isEnabled()) await this.repo.create(input);
    return proposal;
  }

  async markRunning(proposalId: string): Promise<void> {
    this.legacy.markRunning(proposalId);
    if (this.repo.isEnabled()) await this.repo.markRunning(proposalId).catch(() => {});
  }

  async complete(proposalId: string, data: CompleteProposalInput): Promise<void> {
    this.legacy.complete(proposalId, data);
    if (this.repo.isEnabled()) await this.repo.complete(proposalId, data).catch(() => {});
  }

  async setDecisionAsync(proposalId: string, status: 'APPROVED' | 'REJECTED'): Promise<RepositoryFixProposal | undefined> {
    const updated = this.legacy.setDecision(proposalId, status);
    if (this.repo.isEnabled()) await this.repo.setDecision(proposalId, status).catch(() => {});
    if (updated) return updated;
    return this.getByIdAsync(proposalId);
  }

  async getByIdAsync(proposalId: string): Promise<RepositoryFixProposal | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getById(proposalId);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-repository-fix-proposal-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getById(proposalId);
  }

  async listForIssueAsync(issueId: string): Promise<RepositoryFixProposal[]> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.listForIssue(issueId);
      } catch (error) {
        console.error('[unified-repository-fix-proposal-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.listForIssue(issueId);
  }

  /** Duplicate-job protection at the route/service layer — backed by (never a substitute for) the real Postgres partial unique index. */
  async hasActiveProposalAsync(issueId: string): Promise<boolean> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.hasActiveProposal(issueId);
      } catch (error) {
        console.error('[unified-repository-fix-proposal-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.hasActiveProposal(issueId);
  }
}
