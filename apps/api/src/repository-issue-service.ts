import type { RepositoryIssue, RepositoryIssueErrorCode, RepositoryIssueSeverity } from '@origami/contracts';
import { randomUUID } from 'node:crypto';
import { canAccessRepository } from './repository-service.js';
import { isSensitiveFile } from './repository-file-safety.js';
import { isRepositoryPathSafe, normalizeRepositoryPath } from './repository-path-safety.js';
import type { UnifiedRepositoryIndexStore } from './unified-repository-index-store.js';
import type { UnifiedRepositoryIssueStore } from './unified-repository-issue-store.js';

export class IssueError extends Error {
  constructor(message: string, public readonly code: RepositoryIssueErrorCode) {
    super(message);
    this.name = 'IssueError';
  }
}

const VALID_SEVERITIES = new Set<RepositoryIssueSeverity>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5_000;

/** Statuses that mean "the repository has never had a successful index" — mirrors repository-search-service.ts's NOT_YET_INDEXED_STATUSES exactly, since an issue also requires a completed index job to validate file/symbol references against. */
const NOT_YET_INDEXED_STATUSES = new Set(['CONNECTED', 'DISCONNECTED', 'CLONING', 'READY_FOR_INDEXING', 'INDEXING', 'FAILED']);

export interface RepositoryLike {
  id: string;
  ownerId?: string;
  userId?: string;
  organizationId?: string;
  status: string;
}

export interface IssueStores {
  indexStore: Pick<UnifiedRepositoryIndexStore, 'getLatestForRepositoryAsync' | 'getFilesForJobAsync' | 'getChunksForJobAsync'>;
  issueStore: Pick<UnifiedRepositoryIssueStore, 'create' | 'getByIdAsync' | 'listForRepositoryAsync'>;
}

export interface CreateIssueParams {
  repositoryId: string;
  ownerId?: string;
  title: unknown;
  description: unknown;
  severity?: unknown;
  filePath?: unknown;
  symbol?: unknown;
  lineStart?: unknown;
  lineEnd?: unknown;
}

function validateString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IssueError(`${field} is required and must be a non-empty string.`, 'ISSUE_VALIDATION_FAILED');
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new IssueError(`${field} must be ${maxLength} characters or fewer.`, 'ISSUE_VALIDATION_FAILED');
  }
  return trimmed;
}

function validateSeverity(value: unknown): RepositoryIssueSeverity {
  if (value === undefined || value === null) return 'MEDIUM';
  if (typeof value !== 'string' || !VALID_SEVERITIES.has(value as RepositoryIssueSeverity)) {
    throw new IssueError('severity must be one of LOW, MEDIUM, HIGH, CRITICAL.', 'ISSUE_VALIDATION_FAILED');
  }
  return value as RepositoryIssueSeverity;
}

function validateLineRange(lineStart: unknown, lineEnd: unknown): { lineStart?: number; lineEnd?: number } {
  if (lineStart === undefined && lineEnd === undefined) return {};
  if (lineStart === undefined || lineEnd === undefined) {
    throw new IssueError('lineStart and lineEnd must both be supplied together.', 'ISSUE_VALIDATION_FAILED');
  }
  const start = Number(lineStart);
  const end = Number(lineEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new IssueError('lineStart and lineEnd must be positive integers with lineStart <= lineEnd.', 'ISSUE_VALIDATION_FAILED');
  }
  return { lineStart: start, lineEnd: end };
}

/**
 * Creates a user-reported repository issue. Validates repository existence/
 * ownership/readiness, then (if a file/symbol is supplied) validates them
 * against the repository's actual indexed commit — never against the real
 * clone on disk, and never by executing anything. commitSha is always taken
 * from the repository's own latest completed index job, never accepted from
 * the request (see CreateRepositoryIssueRequest — it has no commitSha field).
 */
export async function createRepositoryIssue(
  repository: RepositoryLike | undefined,
  stores: IssueStores,
  params: CreateIssueParams,
): Promise<RepositoryIssue> {
  if (!repository) {
    throw new IssueError('Repository not found.', 'REPOSITORY_NOT_FOUND');
  }
  if (!canAccessRepository(repository.organizationId, params.ownerId)) {
    throw new IssueError('Repository not found.', 'REPOSITORY_ACCESS_DENIED');
  }
  if (NOT_YET_INDEXED_STATUSES.has(repository.status)) {
    throw new IssueError('Repository must be indexed before an issue can be filed against it.', 'REPOSITORY_NOT_READY');
  }

  const indexJob = await stores.indexStore.getLatestForRepositoryAsync(repository.id);
  if (!indexJob || indexJob.status !== 'COMPLETED') {
    throw new IssueError('No successful repository index is available.', 'REPOSITORY_NOT_READY');
  }

  const title = validateString(params.title, 'title', MAX_TITLE_LENGTH);
  const description = validateString(params.description, 'description', MAX_DESCRIPTION_LENGTH);
  const severity = validateSeverity(params.severity);
  const { lineStart, lineEnd } = validateLineRange(params.lineStart, params.lineEnd);

  let filePath: string | undefined;
  let symbol: string | undefined;

  if (params.filePath !== undefined && params.filePath !== null) {
    if (typeof params.filePath !== 'string' || !params.filePath.trim()) {
      throw new IssueError('filePath must be a non-empty string when supplied.', 'ISSUE_VALIDATION_FAILED');
    }
    filePath = normalizeRepositoryPath(params.filePath);
    if (!isRepositoryPathSafe(filePath)) {
      throw new IssueError('filePath must be a relative path inside the repository (no absolute paths, no ../ traversal).', 'ISSUE_VALIDATION_FAILED');
    }
    if (isSensitiveFile(filePath)) {
      throw new IssueError('filePath refers to a sensitive file, which cannot be referenced.', 'ISSUE_VALIDATION_FAILED');
    }

    const files = await stores.indexStore.getFilesForJobAsync(indexJob.jobId);
    const fileExists = files.some((f) => f.filePath === filePath && f.status === 'INDEXED');
    if (!fileExists) {
      throw new IssueError(`File "${filePath}" was not found in the indexed repository.`, 'FILE_NOT_FOUND');
    }
  }

  if (params.symbol !== undefined && params.symbol !== null) {
    if (typeof params.symbol !== 'string' || !params.symbol.trim()) {
      throw new IssueError('symbol must be a non-empty string when supplied.', 'ISSUE_VALIDATION_FAILED');
    }
    symbol = params.symbol.trim();

    const chunks = await stores.indexStore.getChunksForJobAsync(indexJob.jobId);
    const symbolExists = chunks.some((c) => c.symbol === symbol && (!filePath || c.filePath === filePath));
    if (!symbolExists) {
      throw new IssueError(
        filePath ? `Symbol "${symbol}" was not found in "${filePath}".` : `Symbol "${symbol}" was not found in the indexed repository.`,
        'SYMBOL_NOT_FOUND',
      );
    }
  }

  return stores.issueStore.create({
    id: randomUUID(),
    repositoryId: repository.id,
    ownerId: repository.ownerId,
    commitSha: indexJob.commitSha,
    title,
    description,
    severity,
    source: 'USER_REPORTED',
    filePath,
    symbol,
    lineStart,
    lineEnd,
  });
}

export async function getRepositoryIssue(
  repository: RepositoryLike | undefined,
  stores: Pick<IssueStores, 'issueStore'>,
  issueId: string,
  requestOwnerId: string | undefined,
): Promise<RepositoryIssue> {
  if (!repository || !canAccessRepository(repository.organizationId, requestOwnerId)) {
    throw new IssueError('Repository not found.', 'REPOSITORY_NOT_FOUND');
  }
  const issue = await stores.issueStore.getByIdAsync(issueId);
  if (!issue || issue.repositoryId !== repository.id) {
    throw new IssueError('Issue not found.', 'ISSUE_NOT_FOUND');
  }
  return issue;
}

export async function listRepositoryIssues(
  repository: RepositoryLike | undefined,
  stores: Pick<IssueStores, 'issueStore'>,
  requestOwnerId: string | undefined,
): Promise<RepositoryIssue[]> {
  if (!repository || !canAccessRepository(repository.organizationId, requestOwnerId)) {
    throw new IssueError('Repository not found.', 'REPOSITORY_NOT_FOUND');
  }
  return stores.issueStore.listForRepositoryAsync(repository.id);
}
