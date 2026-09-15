import type {
  RepositoryFixChangedFile,
  RepositoryFixLineGrounding,
  RepositoryFixPrProvider,
  RepositoryFixSyntaxStatus,
  RepositoryFixWorkflowStatus,
} from '@origami/contracts';
import { getPool } from './pool.js';

export interface RepositoryFixWorkflowRecord {
  id: string;
  repositoryId: string;
  findingId: string;
  ownerId?: string;
  commitSha: string;
  proposalHash: string;
  changedFiles: RepositoryFixChangedFile[];
  diff: string;
  lineGrounding: RepositoryFixLineGrounding[];
  syntaxStatus: RepositoryFixSyntaxStatus;
  workspaceDir: string;
  status: RepositoryFixWorkflowStatus;
  branchName?: string;
  newCommitSha?: string;
  provider?: RepositoryFixPrProvider;
  prNumber?: number;
  prUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface CreateWorkflowInput {
  id: string;
  repositoryId: string;
  findingId: string;
  ownerId?: string;
  commitSha: string;
  proposalHash: string;
  changedFiles: RepositoryFixChangedFile[];
  diff: string;
  lineGrounding: RepositoryFixLineGrounding[];
  syntaxStatus: RepositoryFixSyntaxStatus;
  workspaceDir: string;
  expiresAt: string;
}

export interface UpdateWorkflowProgressInput {
  status: RepositoryFixWorkflowStatus;
  branchName?: string;
  newCommitSha?: string;
  provider?: RepositoryFixPrProvider;
  prNumber?: number;
  prUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

function rowToWorkflow(row: Record<string, unknown>): RepositoryFixWorkflowRecord {
  return {
    id: row.id as string,
    repositoryId: row.repository_id as string,
    findingId: row.finding_id as string,
    ownerId: (row.owner_id as string) ?? undefined,
    commitSha: row.commit_sha as string,
    proposalHash: row.proposal_hash as string,
    changedFiles: (row.changed_files as RepositoryFixChangedFile[]) ?? [],
    diff: (row.diff as string) ?? '',
    lineGrounding: (row.line_grounding as RepositoryFixLineGrounding[]) ?? [],
    syntaxStatus: row.syntax_status as RepositoryFixSyntaxStatus,
    workspaceDir: row.workspace_dir as string,
    status: row.status as RepositoryFixWorkflowStatus,
    branchName: (row.branch_name as string) ?? undefined,
    newCommitSha: (row.new_commit_sha as string) ?? undefined,
    provider: (row.provider as RepositoryFixPrProvider) ?? undefined,
    prNumber: (row.pr_number as number) ?? undefined,
    prUrl: (row.pr_url as string) ?? undefined,
    errorCode: (row.error_code as string) ?? undefined,
    errorMessage: (row.error_message as string) ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    expiresAt: (row.expires_at as Date).toISOString(),
  };
}

/** Postgres-backed store for repository_fix_workflows (migration 010). */
export class RepositoryFixWorkflowRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateWorkflowInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO repository_fix_workflows
         (id, repository_id, finding_id, owner_id, commit_sha, proposal_hash, changed_files, diff, line_grounding, syntax_status, workspace_dir, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'REVIEWABLE', $12)`,
      [
        input.id, input.repositoryId, input.findingId, input.ownerId ?? null, input.commitSha, input.proposalHash,
        JSON.stringify(input.changedFiles), input.diff, JSON.stringify(input.lineGrounding), input.syntaxStatus, input.workspaceDir, input.expiresAt,
      ],
    );
  }

  async getById(id: string): Promise<RepositoryFixWorkflowRecord | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM repository_fix_workflows WHERE id = $1`, [id]);
    return result.rows[0] ? rowToWorkflow(result.rows[0]) : undefined;
  }

  /**
   * The atomic idempotency/concurrency claim: only the FIRST caller for a
   * given applicationId ever transitions it out of REVIEWABLE — a real
   * single-row conditional UPDATE, backed by Postgres row-level locking,
   * not an in-memory flag. Returns the row if THIS call won the claim,
   * undefined if it lost (the row was already claimed by a concurrent or
   * prior call) — the caller then re-reads the current row via getById to
   * decide what to report back.
   */
  async claimForApproval(id: string): Promise<RepositoryFixWorkflowRecord | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `UPDATE repository_fix_workflows SET status = 'APPROVED', updated_at = NOW() WHERE id = $1 AND status = 'REVIEWABLE' RETURNING *`,
      [id],
    );
    return result.rows[0] ? rowToWorkflow(result.rows[0]) : undefined;
  }

  async updateProgress(id: string, data: UpdateWorkflowProgressInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `UPDATE repository_fix_workflows SET
         status = $2, branch_name = COALESCE($3, branch_name), new_commit_sha = COALESCE($4, new_commit_sha),
         provider = COALESCE($5, provider), pr_number = COALESCE($6, pr_number), pr_url = COALESCE($7, pr_url),
         error_code = $8, error_message = $9, updated_at = NOW()
       WHERE id = $1`,
      [
        id, data.status, data.branchName ?? null, data.newCommitSha ?? null,
        data.provider ?? null, data.prNumber ?? null, data.prUrl ?? null,
        data.errorCode ?? null, data.errorMessage ?? null,
      ],
    );
  }

  /** REVIEWABLE rows whose TTL has passed — used by the cleanup sweep to expire and discard their workspaces. */
  async listExpiredReviewable(nowIso: string): Promise<RepositoryFixWorkflowRecord[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM repository_fix_workflows WHERE status = 'REVIEWABLE' AND expires_at < $1`, [nowIso]);
    return (result.rows as Record<string, unknown>[]).map(rowToWorkflow);
  }
}
