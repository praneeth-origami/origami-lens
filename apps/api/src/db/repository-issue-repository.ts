import type { RepositoryIssue, RepositoryIssueSeverity, RepositoryIssueSource, RepositoryIssueStatus } from '@origami/contracts';
import { getPool } from './pool.js';

export interface CreateIssueInput {
  id: string;
  repositoryId: string;
  ownerId?: string;
  commitSha: string;
  title: string;
  description: string;
  severity: RepositoryIssueSeverity;
  source: RepositoryIssueSource;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface UpdateIssueStatusInput {
  status: RepositoryIssueStatus;
}

function rowToIssue(row: Record<string, unknown>): RepositoryIssue {
  return {
    id: row.id as string,
    repositoryId: row.repository_id as string,
    ownerId: (row.owner_id as string) ?? undefined,
    commitSha: row.commit_sha as string,
    title: row.title as string,
    description: row.description as string,
    severity: row.severity as RepositoryIssueSeverity,
    status: row.status as RepositoryIssueStatus,
    source: row.source as RepositoryIssueSource,
    filePath: (row.file_path as string) ?? undefined,
    symbol: (row.symbol as string) ?? undefined,
    lineStart: row.line_start === null || row.line_start === undefined ? undefined : Number(row.line_start),
    lineEnd: row.line_end === null || row.line_end === undefined ? undefined : Number(row.line_end),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/** Postgres-backed store for repository_issues (migration 009) — mirrors every other Repository*Repository class's isEnabled()/pool pattern exactly. */
export class RepositoryIssueRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateIssueInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO repository_issues
         (id, repository_id, owner_id, commit_sha, title, description, severity, status, source, file_path, symbol, line_start, line_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9, $10, $11, $12)`,
      [
        input.id, input.repositoryId, input.ownerId ?? null, input.commitSha, input.title, input.description,
        input.severity, input.source, input.filePath ?? null, input.symbol ?? null, input.lineStart ?? null, input.lineEnd ?? null,
      ],
    );
  }

  async getById(issueId: string): Promise<RepositoryIssue | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM repository_issues WHERE id = $1`, [issueId]);
    return result.rows[0] ? rowToIssue(result.rows[0]) : undefined;
  }

  async listForRepository(repositoryId: string): Promise<RepositoryIssue[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT * FROM repository_issues WHERE repository_id = $1 ORDER BY created_at DESC`,
      [repositoryId],
    );
    return (result.rows as Record<string, unknown>[]).map(rowToIssue);
  }

  async updateStatus(issueId: string, data: UpdateIssueStatusInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE repository_issues SET status = $2, updated_at = NOW() WHERE id = $1`, [issueId, data.status]);
  }
}
