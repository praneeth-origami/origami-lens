import type { RepositoryFixFileChange, RepositoryFixProposal, RepositoryFixProposalStatus } from '@origami/contracts';
import { getPool } from './pool.js';

export interface CreateProposalInput {
  id: string;
  issueId: string;
  repositoryId: string;
  commitSha: string;
}

export interface CompleteProposalInput {
  status: RepositoryFixProposalStatus;
  summary?: string;
  filesChanged?: RepositoryFixFileChange[];
  proposedDiff?: string;
  model?: string;
  validationError?: string;
}

function rowToProposal(row: Record<string, unknown>): RepositoryFixProposal {
  return {
    id: row.id as string,
    issueId: row.issue_id as string,
    repositoryId: row.repository_id as string,
    commitSha: row.commit_sha as string,
    status: row.status as RepositoryFixProposalStatus,
    summary: (row.summary as string) ?? undefined,
    filesChanged: (row.files_changed as RepositoryFixFileChange[]) ?? [],
    proposedDiff: (row.proposed_diff as string) ?? '',
    model: (row.model as string) ?? undefined,
    validationError: (row.validation_error as string) ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/** Postgres-backed store for repository_fix_proposals (migration 009). */
export class RepositoryFixProposalRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateProposalInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO repository_fix_proposals (id, issue_id, repository_id, commit_sha, status) VALUES ($1, $2, $3, $4, 'QUEUED')`,
      [input.id, input.issueId, input.repositoryId, input.commitSha],
    );
  }

  async markRunning(proposalId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE repository_fix_proposals SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [proposalId]);
  }

  async complete(proposalId: string, data: CompleteProposalInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `UPDATE repository_fix_proposals SET
         status = $2, summary = $3, files_changed = $4, proposed_diff = $5, model = $6, validation_error = $7, updated_at = NOW()
       WHERE id = $1`,
      [
        proposalId, data.status, data.summary ?? null,
        data.filesChanged ? JSON.stringify(data.filesChanged) : null, data.proposedDiff ?? null, data.model ?? null, data.validationError ?? null,
      ],
    );
  }

  async setDecision(proposalId: string, status: 'APPROVED' | 'REJECTED'): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE repository_fix_proposals SET status = $2, updated_at = NOW() WHERE id = $1`, [proposalId, status]);
  }

  async getById(proposalId: string): Promise<RepositoryFixProposal | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM repository_fix_proposals WHERE id = $1`, [proposalId]);
    return result.rows[0] ? rowToProposal(result.rows[0]) : undefined;
  }

  async listForIssue(issueId: string): Promise<RepositoryFixProposal[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM repository_fix_proposals WHERE issue_id = $1 ORDER BY created_at DESC`, [issueId]);
    return (result.rows as Record<string, unknown>[]).map(rowToProposal);
  }

  /** Route-level check backing the real uq_repository_fix_proposals_active partial unique index — never the only line of defense. */
  async hasActiveProposal(issueId: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;
    const result = await pool.query(
      `SELECT 1 FROM repository_fix_proposals WHERE issue_id = $1 AND status IN ('QUEUED', 'RUNNING', 'FIX_PROPOSED') LIMIT 1`,
      [issueId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
