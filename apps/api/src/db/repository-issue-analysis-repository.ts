import type { RepositoryIssueAnalysis, RepositoryIssueAnalysisStatus, RepositoryIssueConfidence } from '@origami/contracts';
import { getPool } from './pool.js';

export interface CreateAnalysisInput {
  id: string;
  issueId: string;
  repositoryId: string;
  commitSha: string;
}

export interface CompleteAnalysisInput {
  status: RepositoryIssueAnalysisStatus;
  summary?: string;
  rootCause?: string;
  confidence?: RepositoryIssueConfidence;
  affectedFiles?: string[];
  affectedSymbols?: string[];
  reasoning?: string;
  recommendedFix?: string;
  validationPlan?: string;
  model?: string;
  evidenceChunkCount?: number;
  error?: string;
}

function rowToAnalysis(row: Record<string, unknown>): RepositoryIssueAnalysis {
  return {
    id: row.id as string,
    issueId: row.issue_id as string,
    repositoryId: row.repository_id as string,
    commitSha: row.commit_sha as string,
    status: row.status as RepositoryIssueAnalysisStatus,
    summary: (row.summary as string) ?? undefined,
    rootCause: (row.root_cause as string) ?? undefined,
    confidence: (row.confidence as RepositoryIssueConfidence) ?? undefined,
    affectedFiles: (row.affected_files as string[]) ?? undefined,
    affectedSymbols: (row.affected_symbols as string[]) ?? undefined,
    reasoning: (row.reasoning as string) ?? undefined,
    recommendedFix: (row.recommended_fix as string) ?? undefined,
    validationPlan: (row.validation_plan as string) ?? undefined,
    model: (row.model as string) ?? undefined,
    evidenceChunkCount: row.evidence_chunk_count === null || row.evidence_chunk_count === undefined ? undefined : Number(row.evidence_chunk_count),
    error: (row.error as string) ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/** Postgres-backed store for repository_issue_analyses (migration 009). */
export class RepositoryIssueAnalysisRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateAnalysisInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO repository_issue_analyses (id, issue_id, repository_id, commit_sha, status) VALUES ($1, $2, $3, $4, 'QUEUED')`,
      [input.id, input.issueId, input.repositoryId, input.commitSha],
    );
  }

  async markRunning(analysisId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE repository_issue_analyses SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [analysisId]);
  }

  async complete(analysisId: string, data: CompleteAnalysisInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `UPDATE repository_issue_analyses SET
         status = $2, summary = $3, root_cause = $4, confidence = $5, affected_files = $6, affected_symbols = $7,
         reasoning = $8, recommended_fix = $9, validation_plan = $10, model = $11, evidence_chunk_count = $12, error = $13, updated_at = NOW()
       WHERE id = $1`,
      [
        analysisId, data.status, data.summary ?? null, data.rootCause ?? null, data.confidence ?? null,
        data.affectedFiles ? JSON.stringify(data.affectedFiles) : null, data.affectedSymbols ? JSON.stringify(data.affectedSymbols) : null,
        data.reasoning ?? null, data.recommendedFix ?? null, data.validationPlan ?? null, data.model ?? null,
        data.evidenceChunkCount ?? null, data.error ?? null,
      ],
    );
  }

  async getById(analysisId: string): Promise<RepositoryIssueAnalysis | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM repository_issue_analyses WHERE id = $1`, [analysisId]);
    return result.rows[0] ? rowToAnalysis(result.rows[0]) : undefined;
  }

  async getLatestForIssue(issueId: string): Promise<RepositoryIssueAnalysis | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT * FROM repository_issue_analyses WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [issueId],
    );
    return result.rows[0] ? rowToAnalysis(result.rows[0]) : undefined;
  }

  /** Route-level check backing the real uq_repository_issue_analyses_active partial unique index — never the only line of defense (see that index), but lets the API return a clear 409 instead of a raw constraint-violation error. */
  async hasActiveAnalysis(issueId: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;
    const result = await pool.query(
      `SELECT 1 FROM repository_issue_analyses WHERE issue_id = $1 AND status IN ('QUEUED', 'RUNNING') LIMIT 1`,
      [issueId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
