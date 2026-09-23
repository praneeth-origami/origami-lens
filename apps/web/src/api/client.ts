import type {
  AggregatedIssue,
  CloneRepositoryResponse,
  CodeTarget,
  ComponentGenerationJob,
  ComponentJobListItem,
  CreateRepositoryIssueRequest,
  CreateRepositoryRequest,
  EmbedRepositoryResponse,
  Issue,
  IssueFilters,
  IssueStatus,
  PageScanRecord,
  Repository,
  RepositoryAskResponse,
  RepositoryCloneStatus,
  RepositoryEmbeddingStatus,
  RepositoryFixApproveResponse,
  RepositoryFixProposal,
  RepositoryFixProposalResponse,
  RepositoryFixReviewResponse,
  RepositoryIndexStatus,
  RepositoryIssue,
  RepositoryIssueAnalysis,
  RepositorySearchResponse,
  ScanListItem,
  ScanResponse,
  ScanStatusResponse,
  Severity,
  StartRepositoryIndexResponse,
} from '@origami/contracts';
import { CODE_TARGET_META } from '@origami/contracts';
import type { AuthMeResponse, ListProviderConnectionsResponse } from '@origami/contracts';

const API_BASE = import.meta.env.VITE_API_URL ?? '/api';
// Auth routes are mounted at /auth/* directly (not nested under /api), so
// they use the API's own origin without the /api prefix segment — see
// apps/web/vite.config.ts's separate /auth proxy entry.
const AUTH_BASE = import.meta.env.VITE_API_URL ?? '';

/** Same shape as a plain Error everywhere it's caught today (only `.message` was ever read) — `.code` is additive, for callers (like repository search) that need to branch on the server's errorCode rather than just display the message. */
export class ApiRequestError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; errorCode?: string };
    throw new ApiRequestError(err.error ?? `Request failed (${res.status})`, err.errorCode);
  }
  return res.json() as Promise<T>;
}

export function fetchScans() {
  return request<{ scans: ScanListItem[] }>('/scans');
}

export interface DependencyHealth {
  api: { status: 'ok' | 'down'; service: string; error?: string };
  browserWorker: { status: 'ok' | 'down'; service: string; error?: string };
  aiRouter: { status: 'ok' | 'down'; service: string; error?: string };
  readyForScan: boolean;
}

export function fetchDependencyHealth() {
  return request<DependencyHealth>('/health/dependencies');
}

export function fetchScan(scanId: string) {
  return request<ScanResponse & { issuesByCategory: Record<string, number> }>(`/scans/${scanId}`);
}

export function fetchScanStatus(scanId: string) {
  return request<ScanStatusResponse>(`/scans/${scanId}/status`);
}

export function fetchScanPages(scanId: string) {
  return request<{ scanId: string; pages: PageScanRecord[] }>(`/scans/${scanId}/pages`);
}

export function fetchPageScanDetail(scanId: string, pageScanId: string) {
  return request<{ scanId: string; page: PageScanRecord; issues: Issue[] }>(
    `/scans/${scanId}/pages/${pageScanId}`,
  );
}

export function fetchScanIssues(scanId: string, filters: IssueFilters) {
  const params = new URLSearchParams();
  if (filters.severity && filters.severity !== 'all') params.set('severity', filters.severity);
  if (filters.category && filters.category !== 'all') params.set('category', filters.category);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.search) params.set('search', filters.search);
  if (filters.sort) params.set('sort', filters.sort);
  const qs = params.toString();
  return request<{ issues: Issue[]; total: number; url: string; scanId: string }>(
    `/scans/${scanId}/issues${qs ? `?${qs}` : ''}`,
  );
}

export function fetchIssue(issueId: string) {
  return request<{
    issue: Issue | AggregatedIssue;
    scan: {
      scanId: string;
      url: string;
      scannedAt: string;
      healthScore: ScanResponse['healthScore'];
      scanType?: ScanResponse['scanType'];
    };
  }>(`/issues/${issueId}`);
}

export function updateIssueStatus(issueId: string, status: IssueStatus) {
  return request<{ issue: Issue }>(`/issues/${issueId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function askAi(question: string, issue: Issue, url: string) {
  return request<{ answer: string; aiAvailable: boolean }>('/ai/ask', {
    method: 'POST',
    body: JSON.stringify({ question, issue, url }),
  });
}

export function suggestFix(issue: Issue, url: string) {
  return request<{ fix: Record<string, unknown>; aiAvailable: boolean }>('/ai/suggest-fix', {
    method: 'POST',
    body: JSON.stringify({ issue, url }),
  });
}

export function fetchComponentJobs() {
  return request<{ jobs: ComponentJobListItem[] }>('/components');
}

export function fetchComponentJob(jobId: string) {
  return request<ComponentGenerationJob>(`/components/${jobId}`);
}

export function retryComponentJob(jobId: string, target?: CodeTarget) {
  return request<{ jobId: string; status: string }>(`/components/${jobId}/retry`, {
    method: 'POST',
    body: JSON.stringify({ target }),
  });
}

export function cancelComponentJob(jobId: string) {
  return request<{ jobId: string; status: string }>(`/components/${jobId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchRepositories() {
  return request<{ repositories: Repository[] }>('/repositories');
}

export function fetchRepository(id: string) {
  return request<Repository>(`/repositories/${id}`);
}

export function createRepository(input: CreateRepositoryRequest) {
  return request<Repository>('/repositories', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Flattened GET /repositories/:id/clone-status response — every field comes straight from the persisted clone job, never fabricated (see the Phase 2 report). */
export interface RepositoryCloneStatusResponse {
  repositoryId: string;
  jobId: string;
  status: RepositoryCloneStatus;
  commitSha?: string;
  fileCount?: number;
  directoryCount?: number;
  totalSizeBytes?: number;
  topLevelDirectories?: string[];
  topLevelFiles?: string[];
  extensions?: Record<string, number>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export function cloneRepository(id: string) {
  return request<CloneRepositoryResponse>(`/repositories/${id}/clone`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchCloneStatus(id: string) {
  return request<RepositoryCloneStatusResponse>(`/repositories/${id}/clone-status`);
}

export function cancelRepositoryClone(id: string) {
  return request<CloneRepositoryResponse>(`/repositories/${id}/clone/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Flattened GET /repositories/:id/index-status response — every field comes straight from the persisted index job (see the Phase 3 report). */
export interface RepositoryIndexStatusResponse {
  repositoryId: string;
  jobId: string;
  status: RepositoryIndexStatus;
  commitSha: string;
  filesIndexed: number;
  filesSkipped: number;
  chunksCreated: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RepositoryIndexSummaryResponse {
  repositoryId: string;
  jobId: string;
  status: RepositoryIndexStatus;
  commitSha: string;
  filesIndexed: number;
  filesSkipped: number;
  chunksCreated: number;
  languages: Record<string, number>;
}

export function indexRepository(id: string) {
  return request<StartRepositoryIndexResponse>(`/repositories/${id}/index`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchIndexStatus(id: string) {
  return request<RepositoryIndexStatusResponse>(`/repositories/${id}/index-status`);
}

export function fetchIndexSummary(id: string) {
  return request<RepositoryIndexSummaryResponse>(`/repositories/${id}/index-summary`);
}

export function cancelRepositoryIndex(id: string) {
  return request<StartRepositoryIndexResponse>(`/repositories/${id}/index/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Flattened GET /repositories/:id/embed-status response — every field comes straight from the persisted embedding job; the model/dimensions are whatever was actually configured/returned, never hard-coded (see the Phase 4 report). */
export interface RepositoryEmbeddingStatusResponse {
  repositoryId: string;
  jobId: string;
  status: RepositoryEmbeddingStatus;
  commitSha: string;
  model: string;
  dimensions?: number;
  totalChunks: number;
  embeddedChunks: number;
  skippedChunks: number;
  failedChunks: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export function embedRepository(id: string) {
  return request<EmbedRepositoryResponse>(`/repositories/${id}/embed`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchEmbedStatus(id: string) {
  return request<RepositoryEmbeddingStatusResponse>(`/repositories/${id}/embed-status`);
}

export function cancelRepositoryEmbedding(id: string) {
  return request<EmbedRepositoryResponse>(`/repositories/${id}/embed/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function searchRepository(id: string, query: string, limit?: number) {
  return request<RepositorySearchResponse>(`/repositories/${id}/search`, {
    method: 'POST',
    body: JSON.stringify({ query, limit }),
  });
}

/** Phase 9 — grounded repository code Q&A, reusing the same search/reranking pipeline as searchRepository() above. */
export function askRepository(id: string, query: string) {
  return request<RepositoryAskResponse>(`/repositories/${id}/ask`, {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

/** Phase 10 — AI issue analysis + code fix proposal for a website-scan finding, review-only (never modifies the repository). */
export function proposeRepositoryFindingFix(repositoryId: string, findingId: string, instruction?: string) {
  return request<RepositoryFixProposalResponse>(`/repositories/${repositoryId}/findings/${findingId}/fix-proposal`, {
    method: 'POST',
    body: JSON.stringify({ instruction }),
  });
}

/** Phase 12, step 1 — reuses Phase 11's apply pipeline but RETAINS the isolated workspace for a subsequent explicit approval. Still never creates a branch/commit/PR on its own. */
export function reviewRepositoryFindingFix(repositoryId: string, findingId: string, proposal: RepositoryFixProposalResponse) {
  return request<RepositoryFixReviewResponse>(`/repositories/${repositoryId}/findings/${findingId}/fix-proposal/review`, {
    method: 'POST',
    body: JSON.stringify({ proposal }),
  });
}

/** Phase 12, step 2 — the only call in this app that ever creates a Git branch, commits, pushes, or opens a Pull Request. Only ever invoked after the user has explicitly clicked "Create Pull Request" and confirmed. */
export function approveRepositoryFindingFix(repositoryId: string, findingId: string, applicationId: string, proposal: RepositoryFixProposalResponse) {
  return request<RepositoryFixApproveResponse>(`/repositories/${repositoryId}/findings/${findingId}/fix-proposal/approve`, {
    method: 'POST',
    body: JSON.stringify({ applicationId, proposal }),
  });
}

/** Phase 8 — repository issue detection + AI fix proposal + reviewable diff. */
export function createRepositoryIssue(repositoryId: string, input: CreateRepositoryIssueRequest) {
  return request<RepositoryIssue>(`/repositories/${repositoryId}/issues`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchRepositoryIssues(repositoryId: string) {
  return request<{ repositoryId: string; issues: RepositoryIssue[] }>(`/repositories/${repositoryId}/issues`);
}

export function fetchRepositoryIssue(repositoryId: string, issueId: string) {
  return request<RepositoryIssue>(`/repositories/${repositoryId}/issues/${issueId}`);
}

export function analyzeRepositoryIssue(repositoryId: string, issueId: string) {
  return request<{ analysisId: string; issueId: string; status: string }>(`/repositories/${repositoryId}/issues/${issueId}/analyze`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchRepositoryIssueAnalysis(repositoryId: string, issueId: string) {
  return request<RepositoryIssueAnalysis>(`/repositories/${repositoryId}/issues/${issueId}/analysis`);
}

export function proposeRepositoryFix(repositoryId: string, issueId: string) {
  return request<{ proposalId: string; issueId: string; status: string }>(`/repositories/${repositoryId}/issues/${issueId}/propose-fix`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchRepositoryFixProposals(repositoryId: string, issueId: string) {
  return request<{ issueId: string; proposals: RepositoryFixProposal[] }>(`/repositories/${repositoryId}/issues/${issueId}/fix-proposals`);
}

export function approveRepositoryFixProposal(repositoryId: string, issueId: string, proposalId: string) {
  return request<RepositoryFixProposal>(`/repositories/${repositoryId}/issues/${issueId}/fix-proposals/${proposalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function rejectRepositoryFixProposal(repositoryId: string, issueId: string, proposalId: string) {
  return request<RepositoryFixProposal>(`/repositories/${repositoryId}/issues/${issueId}/fix-proposals/${proposalId}/reject`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export { CODE_TARGET_META };
export type { CodeTarget };

export type SeverityTab = 'all' | Severity;

export const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const CATEGORY_LABEL: Record<string, string> = {
  functional: 'Functional',
  performance: 'Performance',
  visualMobile: 'Visual / Mobile',
  accessibility: 'Accessibility',
  bestPractices: 'Best Practices',
  seo: 'SEO',
  securityHygiene: 'Security Hygiene',
};

export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  ignored: 'Ignored',
};

/* -------------------------------------------------------------------- */
/* Phase 16/A — Origami Lens's own application login (GitHub OAuth +     */
/* server-side session). Never touches a repository/branch/commit/PR.   */
/* -------------------------------------------------------------------- */

/** Full-page navigation (not a fetch) — GitHub's OAuth redirect requires a real top-level browser navigation. */
export function githubLoginUrl(): string {
  return `${AUTH_BASE}/auth/github/login`;
}

export async function fetchCurrentUser(): Promise<AuthMeResponse> {
  const res = await fetch(`${AUTH_BASE}/auth/me`, { credentials: 'include' });
  if (!res.ok) return { user: null };
  return res.json() as Promise<AuthMeResponse>;
}

export async function logout(): Promise<void> {
  await fetch(`${AUTH_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
}

/* -------------------------------------------------------------------- */
/* Phase 16/C-E — Git provider authorization (GitHub App installation,   */
/* GitLab/Bitbucket OAuth). Never receives a token/secret of any kind —  */
/* only connection status/account-login metadata (ProviderConnectionSummary). */
/* -------------------------------------------------------------------- */

/** Full-page navigation — GitHub's App installation flow requires a real top-level browser navigation. */
export function githubConnectUrl(): string {
  return `${AUTH_BASE}/providers/github/connect`;
}

/** Full-page navigation — GitLab's OAuth authorization flow requires a real top-level browser navigation. */
export function gitlabConnectUrl(): string {
  return `${AUTH_BASE}/providers/gitlab/connect`;
}

/** Full-page navigation — Bitbucket's OAuth authorization flow requires a real top-level browser navigation. */
export function bitbucketConnectUrl(): string {
  return `${AUTH_BASE}/providers/bitbucket/connect`;
}

export async function fetchProviderConnections(): Promise<ListProviderConnectionsResponse> {
  const res = await fetch(`${AUTH_BASE}/providers/connections`, { credentials: 'include' });
  if (!res.ok) return { connections: [] };
  return res.json() as Promise<ListProviderConnectionsResponse>;
}

export async function disconnectProvider(connectionId: string): Promise<void> {
  await fetch(`${AUTH_BASE}/providers/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE', credentials: 'include' });
}
