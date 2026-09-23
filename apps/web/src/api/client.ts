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
  IssueSource,
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
  RepositoryResolution,
  RepositoryRole,
  RepositorySearchResponse,
  ScanListItem,
  ScanResponse,
  ScanStatusResponse,
  Severity,
  StartRepositoryIndexResponse,
  ReportExportFormat,
  CreateReportShareResponse,
  ReportShareStatusResponse,
  LensReport,
} from '@origami/contracts';
import { CODE_TARGET_META } from '@origami/contracts';
import type {
  AuthMeResponse,
  AuthUser,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  ListProviderConnectionsResponse,
  LoginRequest,
  Persona,
  RegisterRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
  ResendVerificationEmailRequest,
  ResendVerificationEmailResponse,
} from '@origami/contracts';
import type {
  BillingStatusResponse,
  CreateBillingPortalSessionResponse,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  Subscription,
} from '@origami/contracts';
import type {
  AddWorkspaceMemberRequest,
  AdminActivityType,
  AdminListUsersResponse,
  AdminListWorkspacesResponse,
  AdminOverviewResponse,
  AdminUserDetail,
  ListAdminActivityResponse,
  ListWorkspaceMembersResponse,
  OrganizationRole,
  PlatformRole,
  SubscriptionPlan,
  TransferWorkspaceOwnershipRequest,
  UpdateWorkspaceMemberRoleRequest,
  WorkspaceRoleResponse,
  CreateWorkspaceInvitationRequest,
  CreateWorkspaceInvitationResponse,
  ListWorkspaceInvitationsResponse,
  InvitationPreviewResponse,
  AcceptInvitationResponse,
  ListMyWorkspacesResponse,
  SwitchWorkspaceRequest,
} from '@origami/contracts';

import { notifyApiError, notifyNetworkError } from '../notifications/error-messages';

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

/** `silent: true` opts a call out of the automatic error toast below — only for the handful of pages that already render a well-crafted contextual inline message for that specific call, to avoid the double-notification spec §5 warns against. A 401 always redirects to /login regardless of `silent` (an expired session isn't something any single page can meaningfully recover from on its own). */
export interface ApiRequestInit extends RequestInit {
  silent?: boolean;
}

function redirectToLoginOn401(): void {
  if (window.location.pathname === '/login') return;
  window.location.href = '/login';
}

async function request<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const { silent, ...fetchInit } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...fetchInit.headers },
      ...fetchInit,
    });
  } catch {
    notifyNetworkError();
    throw new ApiRequestError('Unable to reach the server. Check your connection and try again.', 'NETWORK_ERROR');
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; errorCode?: string };
    if (res.status === 401 || err.errorCode === 'UNAUTHENTICATED') {
      notifyApiError({ status: res.status, code: err.errorCode, serverMessage: err.error });
      redirectToLoginOn401();
    } else if (!silent) {
      notifyApiError({ status: res.status, code: err.errorCode, serverMessage: err.error });
    }
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

export function deleteScan(scanId: string) {
  return request<{ ok: true }>(`/scans/${scanId}`, { method: 'DELETE', body: JSON.stringify({}) });
}

export function fetchScanStatus(scanId: string) {
  return request<ScanStatusResponse>(`/scans/${scanId}/status`);
}

/**
 * PDF/JSON/Markdown/CSV are all downloaded the same way — a real fetch (not
 * the generic `request()` helper above, which always calls `.json()`) so
 * the response's exact bytes and server-computed filename (Content-
 * Disposition) are used untouched, matching the same Blob+anchor pattern
 * this app already used for the old client-only JSON export.
 */
export async function downloadReportExport(scanId: string, format: ReportExportFormat): Promise<void> {
  const res = await fetch(`${API_BASE}/scans/${scanId}/report/export/${format}`, { credentials: 'include' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; errorCode?: string };
    notifyApiError({ status: res.status, code: err.errorCode, serverMessage: err.error });
    throw new ApiRequestError(err.error ?? `Export failed (${res.status})`, err.errorCode);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filenameMatch = /filename="([^"]+)"/.exec(disposition);
  const filename = filenameMatch?.[1] ?? `origami-lens-report.${format === 'markdown' ? 'md' : format}`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function getReportShareStatus(scanId: string) {
  return request<ReportShareStatusResponse>(`/scans/${scanId}/report/share`);
}

/** Always rotates — see report-share-service.ts's doc comment for why a previously issued link can never be re-displayed (only its hash is stored). */
export function createOrRotateReportShare(scanId: string) {
  return request<CreateReportShareResponse>(`/scans/${scanId}/report/share`, { method: 'POST', body: JSON.stringify({}) });
}

export function revokeReportShare(scanId: string) {
  return request<{ ok: true }>(`/scans/${scanId}/report/share`, { method: 'DELETE', body: JSON.stringify({}) });
}

/** Public — no session cookie required (see GET /reports/share/:token). Uses the same `request()` helper anyway since it's still same-origin JSON; a 404 here is expected/normal for a disabled or unknown link, not a bug. */
export function fetchSharedReport(token: string) {
  return request<LensReport>(`/reports/share/${token}`, { silent: true });
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

/** GET /issues/:issueId/repository-resolution — whether the finding's repository can be determined automatically (already chosen, or the only one connected) or needs the manual picker (see IssueDetailPage.tsx). Never guesses between multiple candidates — see repository-finding-resolution-service.ts. */
export function fetchRepositoryResolution(issueId: string) {
  return request<RepositoryResolution>(`/issues/${issueId}/repository-resolution`);
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

export function deleteComponentJob(jobId: string) {
  return request<{ ok: true }>(`/components/${jobId}`, { method: 'DELETE', body: JSON.stringify({}) });
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

export function deleteRepository(id: string) {
  return request<{ ok: true }>(`/repositories/${id}`, { method: 'DELETE', body: JSON.stringify({}) });
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

/* -------------------------------------------------------------------- */
/* Phase 17 — Stripe billing/subscriptions/entitlements/usage limits.    */
/* Same request<T>('/billing/...') pattern as every other non-auth call  */
/* above (NOT authRequest/AUTH_BASE, which is /auth/* and /providers/*   */
/* only) — see apps/api/src/index.ts's /billing/* routes.                */
/* -------------------------------------------------------------------- */

export function fetchBillingStatus() {
  return request<BillingStatusResponse>('/billing/status');
}

export function createCheckoutSession(input: CreateCheckoutSessionRequest) {
  return request<CreateCheckoutSessionResponse>('/billing/checkout', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createBillingPortalSession() {
  return request<CreateBillingPortalSessionResponse>('/billing/portal', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Backs the success page's polling loop — never grants access itself, see billing-service.ts's getCheckoutSessionStatus. */
export function fetchCheckoutSession(sessionId: string) {
  return request<{ status: string | null; subscription: Subscription }>(`/billing/session/${encodeURIComponent(sessionId)}`);
}

export function updateSeats(seats: number) {
  return request<{ ok: true }>('/billing/seats', {
    method: 'PATCH',
    body: JSON.stringify({ seats }),
  });
}

/* -------------------------------------------------------------------- */
/* Phase 18 — RBAC: workspace membership/role management + platform      */
/* administration. Same request<T>('/...') pattern as every other        */
/* non-auth call above — see apps/api/src/index.ts's /workspace/* and     */
/* /admin/* routes. The API remains authoritative regardless of what the  */
/* UI does with any of this (see useWorkspaceRole.ts).                   */
/* -------------------------------------------------------------------- */

export function fetchWorkspaceMembers() {
  return request<ListWorkspaceMembersResponse>('/workspace/members');
}

export function addWorkspaceMember(input: AddWorkspaceMemberRequest) {
  return request<{ userId: string; email?: string; displayName?: string; role: OrganizationRole; joinedAt: string }>('/workspace/members', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateWorkspaceMemberRole(userId: string, input: UpdateWorkspaceMemberRoleRequest) {
  return request<{ ok: true }>(`/workspace/members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function removeWorkspaceMember(userId: string) {
  return request<{ ok: true }>(`/workspace/members/${encodeURIComponent(userId)}`, { method: 'DELETE', body: JSON.stringify({}) });
}

export function transferWorkspaceOwnership(input: TransferWorkspaceOwnershipRequest) {
  return request<{ ok: true }>('/workspace/transfer-ownership', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchWorkspaceRole() {
  return request<WorkspaceRoleResponse>('/workspace/role');
}

/* -------------------------------------------------------------------- */
/* Phase 20 — workspace email invitations + the workspace switcher.      */
/* Membership is created only on explicit acceptance — see               */
/* apps/api/src/workspace-invitation-service.ts.                         */
/* -------------------------------------------------------------------- */

export function createWorkspaceInvitation(input: CreateWorkspaceInvitationRequest) {
  return request<CreateWorkspaceInvitationResponse>('/workspace/invitations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchWorkspaceInvitations() {
  return request<ListWorkspaceInvitationsResponse>('/workspace/invitations');
}

export function revokeWorkspaceInvitation(id: string) {
  return request<{ ok: true }>(`/workspace/invitations/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({}) });
}

export function resendWorkspaceInvitation(id: string) {
  return request<CreateWorkspaceInvitationResponse>(`/workspace/invitations/${encodeURIComponent(id)}/resend`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Public — no auth required, so a fresh visitor can see what they were invited to before signing in. */
export function fetchInvitationPreview(token: string) {
  return request<InvitationPreviewResponse>(`/invitations/${encodeURIComponent(token)}`);
}

export function acceptInvitation(token: string) {
  return request<AcceptInvitationResponse>(`/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** The workspace switcher's data source — every organization the caller belongs to. Only rendered when this has more than one entry. */
export function fetchMyWorkspaces() {
  return request<ListMyWorkspacesResponse>('/workspace/list-mine');
}

export function switchWorkspace(input: SwitchWorkspaceRequest) {
  return request<{ ok: true }>('/workspace/switch', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface AdminUserSearchFilters {
  search?: string;
  role?: PlatformRole;
  plan?: SubscriptionPlan;
}

export function fetchAdminUsers(filters: AdminUserSearchFilters = {}) {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.role) params.set('role', filters.role);
  if (filters.plan) params.set('plan', filters.plan);
  const qs = params.toString();
  return request<AdminListUsersResponse>(`/admin/users${qs ? `?${qs}` : ''}`);
}

export function fetchAdminUserDetail(userId: string) {
  return request<AdminUserDetail>(`/admin/users/${encodeURIComponent(userId)}`);
}

export function fetchAdminWorkspaces() {
  return request<AdminListWorkspacesResponse>('/admin/workspaces');
}

export function fetchAdminOverview() {
  return request<AdminOverviewResponse>('/admin/overview');
}

export interface AdminActivityFilters {
  type?: AdminActivityType;
  status?: string;
  limit?: number;
}

export function fetchAdminActivity(filters: AdminActivityFilters = {}) {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.status) params.set('status', filters.status);
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return request<ListAdminActivityResponse>(`/admin/activity${qs ? `?${qs}` : ''}`);
}

export function fetchAdminRecentActivity(limit = 20) {
  return request<ListAdminActivityResponse>(`/admin/activity/recent?limit=${limit}`);
}

export interface AdminSystemHealth {
  api: { status: 'ok' | 'down'; service: string; error?: string };
  browserWorker: { status: 'ok' | 'down'; service: string; error?: string };
  aiRouter: { status: 'ok' | 'down'; service: string; error?: string };
  readyForScan: boolean;
  postgres: { status: 'ok' | 'down'; error?: string };
  redis: { configured: boolean; status: 'ok' | 'down' | 'not_configured'; error?: string };
  queues: { name: string; active: number; waiting: number; delayed: number; failed: number }[];
}

export function fetchAdminSystemHealth() {
  return request<AdminSystemHealth>('/admin/system-health');
}

export function updateUserPlatformRole(userId: string, platformRole: PlatformRole) {
  return request<{ user: AuthUser }>(`/admin/users/${encodeURIComponent(userId)}/platform-role`, {
    method: 'PATCH',
    body: JSON.stringify({ platformRole }),
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

/** Now defined in @origami/contracts (apps/api's report renderers need the same labels) — re-exported here unchanged so no existing import site needs to change. */
export { CATEGORY_LABEL } from '@origami/contracts';

export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  ignored: 'Ignored',
};

/** Friendly display names for `Issue.source` — the detector that found the issue. Used by the Issue Detail page's header/sidebar; every IssueSource value must stay covered here. */
export const SOURCE_LABEL: Record<IssueSource, string> = {
  playwright: 'Playwright',
  cdp: 'Chrome DevTools Protocol',
  lighthouse: 'Lighthouse',
  'axe-core': 'axe-core',
  'origami-rule': 'Origami Rule Engine',
  'vision-ai': 'Vision AI',
};

export const REPOSITORY_ROLE_LABEL: Record<RepositoryRole, string> = {
  FRONTEND: 'Frontend',
  BACKEND: 'Backend',
  FULL_STACK: 'Full Stack',
};

/* -------------------------------------------------------------------- */
/* Phase 16/A — Origami Lens's own application login (GitHub OAuth +     */
/* server-side session). Never touches a repository/branch/commit/PR.   */
/* -------------------------------------------------------------------- */

/** Full-page navigation (not a fetch) — GitHub's OAuth redirect requires a real top-level browser navigation. */
export function githubLoginUrl(): string {
  return `${AUTH_BASE}/auth/github/login`;
}

/** Full-page navigation (not a fetch) — Google's OAuth redirect requires a real top-level browser navigation. A second login option (alongside GitHub above) for users with no GitHub/GitLab/Bitbucket account. */
export function googleLoginUrl(): string {
  return `${AUTH_BASE}/auth/google/login`;
}

export async function fetchCurrentUser(): Promise<AuthMeResponse> {
  const res = await fetch(`${AUTH_BASE}/auth/me`, { credentials: 'include' });
  if (!res.ok) return { user: null };
  return res.json() as Promise<AuthMeResponse>;
}

export async function logout(): Promise<void> {
  await fetch(`${AUTH_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
}

/** Same auth-endpoint convention as fetchCurrentUser/logout above (raw fetch against AUTH_BASE, not API_BASE) — errors are parsed the same way request() does, so callers can show err.message/err.code (e.g. WEAK_PASSWORD, EMAIL_ALREADY_REGISTERED, INVALID_CREDENTIALS). */
/**
 * Deliberately does NOT auto-toast (unlike request() above) — every caller
 * (login/register/forgot-password/reset-password) already renders a
 * dedicated, well-placed inline `.auth-error` right next to the form field
 * for every failure case (wrong password, weak password, email already
 * registered, invalid/expired reset token, ...). Adding a toast on top
 * would just double the same message, which spec §5 explicitly warns
 * against. A 401 here also isn't a "session expired" event — it's simply
 * "wrong credentials" on the login page itself — so the request()'s
 * redirect-to-/login-on-401 behavior would be nonsensical here too.
 */
async function authRequest<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AUTH_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; errorCode?: string };
    throw new ApiRequestError(err.error ?? `Request failed (${res.status})`, err.errorCode);
  }
  return res.json() as Promise<T>;
}

export function registerWithEmail(input: RegisterRequest): Promise<{ user: AuthUser }> {
  return authRequest('/auth/register', input);
}

export function loginWithEmail(input: LoginRequest): Promise<{ user: AuthUser }> {
  return authRequest('/auth/login', input);
}

export function requestPasswordReset(input: ForgotPasswordRequest): Promise<ForgotPasswordResponse> {
  return authRequest('/auth/forgot-password', input);
}

export function resetPassword(input: ResetPasswordRequest): Promise<{ ok: true }> {
  return authRequest('/auth/reset-password', input);
}

export function verifyEmail(input: VerifyEmailRequest): Promise<{ ok: true }> {
  return authRequest('/auth/verify-email', input);
}

export function resendVerificationEmail(input: ResendVerificationEmailRequest): Promise<ResendVerificationEmailResponse> {
  return authRequest('/auth/resend-verification-email', input);
}

/** Phase 3 — the one-time onboarding answer. Can be called again later to change it; there's no lock. */
export async function setPersona(persona: Persona): Promise<AuthMeResponse> {
  const res = await fetch(`${AUTH_BASE}/auth/persona`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiRequestError(err.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<AuthMeResponse>;
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

export interface DisconnectProviderResult {
  ok: boolean;
  /** Set only when the connection was GitHub and the real App-installation removal on GitHub's side failed — the local connection is still removed either way, but the App may remain installed on GitHub until removed there too. */
  githubUninstallError?: string;
  /** Always true for a Bitbucket disconnect — Bitbucket Cloud has no API for an app to revoke its own authorization, so the local connection is removed but Bitbucket itself must be revoked manually. Not a failure/error like githubUninstallError — this is simply always the case for this provider. */
  bitbucketManualRevokeRequired?: boolean;
}

export async function disconnectProvider(connectionId: string): Promise<DisconnectProviderResult> {
  const res = await fetch(`${AUTH_BASE}/providers/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) return { ok: false };
  return res.json() as Promise<DisconnectProviderResult>;
}
