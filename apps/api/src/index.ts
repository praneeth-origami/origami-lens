import './load-env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type {
  AskRequest,
  AuthErrorCode,
  AuthMeResponse,
  BillingErrorCode,
  BillingStatusResponse,
  CreateCheckoutSessionRequest,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  ListProviderConnectionsResponse,
  LoginRequest,
  CloneRepositoryResponse,
  CodeTarget,
  ComponentGenerationJob,
  CreateComponentJobRequest,
  CreateRepositoryIssueRequest,
  CreateRepositoryRequest,
  CreateScanRequest,
  ExplainIssueRequest,
  EmbedRepositoryResponse,
  IssueFilters,
  IssueStatus,
  Persona,
  RegisterRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
  ResendVerificationEmailRequest,
  ResendVerificationEmailResponse,
  ReportExportFormat,
  CreateReportShareResponse,
  ReportShareStatusResponse,
  RepositoryAskErrorCode,
  RepositoryFixApplyErrorCode,
  RepositoryFixProposalErrorCode,
  RepositoryFixProposalResponse,
  RepositoryFixWorkflowErrorCode,
  RepositoryIndexSummary,
  RepositoryIssueErrorCode,
  RepositorySearchErrorCode,
  ScanRequest,
  ScanType,
  StartRepositoryIndexResponse,
  UpdateSeatsRequest,
  AddWorkspaceMemberRequest,
  UpdateWorkspaceMemberRoleRequest,
  TransferWorkspaceOwnershipRequest,
  UpdatePlatformRoleRequest,
  WorkspaceErrorCode,
  AdminErrorCode,
  ListWorkspaceMembersResponse,
  WorkspaceRoleResponse,
  AdminListUsersResponse,
  AdminListWorkspacesResponse,
  AdminOverviewResponse,
  ListAdminActivityResponse,
  AdminActivityType,
  PlatformRole,
  SubscriptionPlan,
  CreateWorkspaceInvitationRequest,
  ListWorkspaceInvitationsResponse,
  InvitationPreviewResponse,
  AcceptInvitationResponse,
  WorkspaceInvitationErrorCode,
  ListMyWorkspacesResponse,
  SwitchWorkspaceRequest,
} from '@origami/contracts';
import { CODE_TARGET_META, DEFAULT_WEBSITE_MAX_PAGES, MAX_WEBSITE_PAGES } from '@origami/contracts';
import type { FastifyRequest } from 'fastify';
import { ScanPipeline } from './scan-pipeline.js';
import { countIssuesByCategory, filterIssues } from './scan-store.js';
import { checkDependencies } from './health.js';
import { createWebsiteScanRecord } from './website-scan-orchestrator.js';
import { enqueueWebsiteScan, startWebsiteScanWorker } from './workers/website-scan-worker.js';
import { cancelComponentJob, enqueueComponentJob, startComponentGenerationWorker } from './workers/component-generation-worker.js';
import { ComponentGenerator } from './component-generator.js';
import { UnifiedComponentStore } from './unified-component-store.js';
import { DuplicateRepositoryError, UnifiedRepositoryStore } from './unified-repository-store.js';
import { parseRepositoryUrl, validateBranch } from './repository-service.js';
import { deleteRepositoryClones } from './repository-clone-service.js';
import { UnifiedRepositoryCloneStore } from './unified-repository-clone-store.js';
import { cancelRepositoryCloneJob, enqueueRepositoryCloneJob, startRepositoryCloneWorker } from './workers/repository-clone-worker.js';
import { UnifiedRepositoryIndexStore } from './unified-repository-index-store.js';
import { cancelRepositoryIndexJob, enqueueRepositoryIndexJob, startRepositoryIndexWorker } from './workers/repository-index-worker.js';
import { UnifiedRepositoryEmbeddingStore } from './unified-repository-embedding-store.js';
import { cancelRepositoryEmbeddingJob, enqueueRepositoryEmbeddingJob, startRepositoryEmbeddingWorker } from './workers/repository-embedding-worker.js';
import { RepositorySearchRepository } from './db/repository-search-repository.js';
import { SearchError, defaultSearchProviderDeps, searchRepository } from './repository-search-service.js';
import { AskError, answerRepositoryQuestion } from './repository-ai-service.js';
import { HttpRepositoryQaProvider } from './repository-qa-provider.js';
import { FindingFixError, proposeFindingFix as proposeFindingFixForScanIssue } from './repository-finding-fix-service.js';
import { FindingRepositoryMismatchError, assertFindingRepositoryMatches, resolveRepositoryForIssue } from './repository-finding-resolution-service.js';
import { HttpFindingFixProvider } from './repository-finding-fix-provider.js';
import { FixApplicationError, applyFindingFix } from './repository-fix-application-service.js';
import { FixWorkflowError, approveFindingFix, reviewFindingFix, sweepExpiredFixWorkflows } from './repository-fix-workflow-service.js';
import { sweepExpiringSubscriptions } from './billing/subscription-expiry-sweep.js';
import { UnifiedRepositoryFixWorkflowStore } from './unified-repository-fix-workflow-store.js';
import { resolveRepositoryProvider } from './repository-provider-resolver.js';
import { isDatabaseEnabled } from './db/pool.js';
import { UserRepository } from './db/user-repository.js';
import { SessionRepository } from './db/session-repository.js';
import { PasswordResetTokenRepository } from './db/password-reset-token-repository.js';
import { EmailVerificationTokenRepository } from './db/email-verification-token-repository.js';
import { ReportShareLinkRepository } from './db/report-share-link-repository.js';
import { ProviderConnectionRepository } from './db/provider-connection-repository.js';
import { OrganizationRepository } from './db/organization-repository.js';
import { AuditLogRepository } from './db/audit-log-repository.js';
import { WorkspaceInvitationRepository } from './db/workspace-invitation-repository.js';
import { isPlatformAdmin, canAssignPlatformRole } from './authorization/platform-permissions.js';
import {
  canManageBilling,
  canManageMembers,
  canConfigureRepository,
  canRunScanOrAI,
  canMutateRepository,
  canReadWorkspaceResource,
  canTransferOwnership,
} from './authorization/workspace-permissions.js';
import { assertWorkspaceRole, getWorkspaceRoleOrThrow, WorkspaceAuthorizationError } from './authorization/workspace-authorization.js';
import { createWorkspaceRoleMiddleware } from './authorization/workspace-role-middleware.js';
import {
  WorkspaceMemberError,
  listWorkspaceMembers,
  addWorkspaceMemberByEmail,
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
  transferWorkspaceOwnership,
} from './workspace-member-service.js';
import {
  WorkspaceInvitationError,
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
  resendWorkspaceInvitation,
  getInvitationPreview,
  acceptWorkspaceInvitation,
} from './workspace-invitation-service.js';
import {
  AdminError,
  listWorkspacesForAdmin,
  updateUserPlatformRole,
  searchUsersForAdmin,
  getUserDetailForAdmin,
  getAdminOverview,
} from './admin-service.js';
import { listActiveActivity, listRecentActivity } from './admin/activity-repository.js';
import { getWorkerHealthReport } from './admin/worker-health-service.js';
import { SubscriptionRepository } from './db/subscription-repository.js';
import { UsageCounterRepository } from './db/usage-counter-repository.js';
import { StripeWebhookEventRepository } from './db/stripe-webhook-event-repository.js';
import { EntitlementService } from './billing/entitlement-service.js';
import { createUsageLimitMiddleware } from './billing/usage-limit-middleware.js';
import { getStripeClient, getStripeWebhookSecret } from './billing/stripe-client.js';
import {
  BillingError,
  createBillingPortalSession,
  createCheckoutSession,
  getBillingStatus,
  getCheckoutSessionStatus,
  registerStripeWebhookRoute,
  updateSeats,
} from './billing/billing-service.js';
import { buildGitHubAppInstallUrl, isGitHubAppConfigured, uninstallGitHubApp } from './github-app-auth.js';
import { buildGitLabAuthorizeUrl, isGitLabOAuthConfigured, GitLabOAuthError } from './gitlab-oauth.js';
import { buildBitbucketAuthorizeUrl, isBitbucketOAuthConfigured, BitbucketOAuthError } from './bitbucket-oauth.js';
import { connectGitHubInstallation, connectGitLabAccount, connectBitbucketAccount } from './provider-connection-service.js';
import { createAuthMiddleware, SESSION_COOKIE_NAME, sessionCookieOptions } from './auth-middleware.js';
import { AuthError, getSessionTtlMs, loginWithGitHub, loginWithGoogle, logout as logoutSession } from './auth-service.js';
import {
  PasswordAuthError,
  loginWithEmail,
  registerWithEmail,
  requestPasswordReset,
  resetPassword,
  confirmEmailVerification,
  resendVerificationEmail,
} from './password-auth-service.js';
import { buildLensReport, isReportReady, renderReportCsv, renderReportJson, renderReportMarkdown, reportFilename } from './report-service.js';
import { renderReportPdf } from './report-pdf-renderer.js';
import { ReportShareError, createOrRotateReportShare, getReportShareStatus, getSharedReportByToken, revokeReportShare } from './report-share-service.js';
import {
  sendPasswordResetEmail,
  sendWorkspaceInvitationEmail,
  sendPasswordChangedEmail,
  sendWorkspaceMemberAddedEmail,
  sendWorkspaceMemberRemovedEmail,
  sendRepositoryConnectedEmail,
  sendPullRequestCreatedEmail,
  sendBillingSubscriptionStartedEmail,
  sendBillingPaymentSuccessfulEmail,
  sendBillingPaymentFailedEmail,
  sendBillingSubscriptionCancelledEmail,
  sendRepositoryIndexCompletedEmail,
  sendRepositoryIndexFailedEmail,
  sendBillingPlanLimitReachedEmail,
  sendBillingPlanExpiringSoonEmail,
  sendEmailVerificationEmail,
} from './email-service.js';
import { DEV_EMAIL_PREVIEWS } from './email/templates/index.js';
import { GitHubOAuthError, buildGitHubAuthorizeUrl, completeGitHubOAuthLogin, isGitHubOAuthConfigured } from './auth-github-oauth.js';
import { GoogleOAuthError, buildGoogleAuthorizeUrl, completeGoogleOAuthLogin, isGoogleOAuthConfigured } from './auth-google-oauth.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { UnifiedRepositoryIssueStore } from './unified-repository-issue-store.js';
import { UnifiedRepositoryIssueAnalysisStore } from './unified-repository-issue-analysis-store.js';
import { UnifiedRepositoryFixProposalStore } from './unified-repository-fix-proposal-store.js';
import { IssueError, createRepositoryIssue, getRepositoryIssue, listRepositoryIssues } from './repository-issue-service.js';
import { HttpIssueAnalysisProvider } from './repository-issue-analysis-provider.js';
import { HttpFixProposalProvider } from './repository-fix-provider.js';
import type { RunIssueAnalysisDeps, SearchEvidenceCandidate } from './repository-issue-analysis-service.js';
import type { ProposeFixDeps } from './repository-fix-service.js';
import {
  enqueueRepositoryIssueAnalysisJob,
  startRepositoryIssueAnalysisWorker,
} from './workers/repository-issue-analysis-worker.js';
import {
  enqueueRepositoryFixProposalJob,
  startRepositoryFixProposalWorker,
} from './workers/repository-fix-proposal-worker.js';

const PORT = Number(process.env.API_PORT ?? 3100);
const HOST = process.env.API_HOST ?? '0.0.0.0';
const WEB_APP_BASE_URL = (process.env.WEB_APP_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const AI_ROUTER_URL = process.env.AI_ROUTER_URL ?? 'http://localhost:3102';

/**
 * Fastify defaults to a 1MB request body limit, which is too small for
 * POST /components: a Screenshot -> Code evidence payload bundles a base64
 * screenshot (cropped to the selection + margin, JPEG q=0.85, but base64
 * itself adds ~37% overhead) plus a trimmed DOM tree (depth <= 4, <= 25
 * children/node), <= 20 asset entries, and CSS variables — a large selection
 * on a high-DPR display can plausibly exceed 1MB on its own before any of
 * that other evidence is added. 8MB comfortably covers that realistic
 * worst case while staying far short of an unbounded/"enormous" limit.
 * See services/ai-router/src/index.ts for the matching limit on the /gateway
 * relay call, which carries the same screenshot data onward.
 */
const MAX_REQUEST_BODY_BYTES = Number(process.env.MAX_REQUEST_BODY_MB || 8) * 1024 * 1024;

const pipeline = new ScanPipeline();
const store = pipeline.getStore();
const artifactStore = pipeline.getArtifactStore();
const repo = store.getRepository();

const componentStore = new UnifiedComponentStore();
const componentGenerator = new ComponentGenerator();
const componentRepo = componentStore.getRepository();

const repositoryStore = new UnifiedRepositoryStore();
const repositoryCloneStore = new UnifiedRepositoryCloneStore();
const repositoryIndexStore = new UnifiedRepositoryIndexStore();
const repositoryEmbeddingStore = new UnifiedRepositoryEmbeddingStore();
const repositorySearchRepository = new RepositorySearchRepository();
const repositoryIssueStore = new UnifiedRepositoryIssueStore();
const repositoryIssueAnalysisStore = new UnifiedRepositoryIssueAnalysisStore();
const repositoryFixProposalStore = new UnifiedRepositoryFixProposalStore();
const repositoryFixWorkflowStore = new UnifiedRepositoryFixWorkflowStore();
// Phase 16/A — real user identity + sessions (migration 011). No JSON-file
// fallback by design (see the Phase 16 design report): these two stores
// require a real database or are simply disabled (isEnabled() === false),
// never a best-effort degraded mode.
const userRepository = new UserRepository();
const sessionRepository = new SessionRepository();
const passwordResetTokenRepository = new PasswordResetTokenRepository();
const emailVerificationTokenRepository = new EmailVerificationTokenRepository();
const reportShareLinkRepository = new ReportShareLinkRepository();
const authMiddleware = createAuthMiddleware(sessionRepository);
// Phase 16/C — real, per-user Git provider authorization (migration 013). Same "Postgres or disabled, never a JSON fallback" rule as users/sessions above.
const providerConnectionRepository = new ProviderConnectionRepository();
// Phase 2 — organizations (migration 015). Same "Postgres or disabled, never a JSON fallback" rule: organization membership is a real authorization boundary (see Repository.organizationId), not best-effort feature data.
const organizationRepository = new OrganizationRepository();
// Phase 17 — Stripe billing/entitlements/usage limits (migrations 023-025). Same "Postgres or disabled" rule as everything else above: a plan/quota is a real authorization boundary, not best-effort data.
const subscriptionRepository = new SubscriptionRepository();
const usageCounterRepository = new UsageCounterRepository();
const stripeWebhookEventRepository = new StripeWebhookEventRepository();
const entitlementService = new EntitlementService({
  subscriptionRepo: subscriptionRepository,
  usageCounterRepo: usageCounterRepository,
  organizationRepo: organizationRepository,
  sendBillingPlanLimitReachedEmail,
  webAppBaseUrl: WEB_APP_BASE_URL,
});
const usageLimitMiddleware = createUsageLimitMiddleware(entitlementService);
// Phase 18 — RBAC (migrations 026-028): platform roles, workspace roles, audit log.
const auditLogRepository = new AuditLogRepository();
const workspaceInvitationRepository = new WorkspaceInvitationRepository();
const founderBootstrap = { userRepo: userRepository, auditLog: auditLogRepository };
const workspaceRoleMiddleware = createWorkspaceRoleMiddleware(organizationRepository);

/**
 * Every repository route's real ownership boundary since Phase 2: the set
 * of organizations a user belongs to (today always exactly one — their own
 * personal organization, auto-created at signup by
 * organizationRepo.getOrCreatePersonalOrganization in auth-service.ts).
 * Falls back to treating the userId itself as its own "organization" when
 * Postgres/organizations aren't configured, matching
 * UnifiedRepositoryStore.create()'s own no-DB fallback convention so
 * behavior is identical with or without a real database.
 */
async function resolveOrganizationIds(userId: string): Promise<string[]> {
  if (!organizationRepository.isEnabled()) return [userId];
  const ids = await organizationRepository.getOrganizationIdsForUser(userId);
  if (ids.length > 0) return ids;
  // Self-heal: every login already creates a personal organization, so this
  // only fires for a user who somehow has none yet (e.g. a row inserted
  // before migration 015's backfill ran).
  const organization = await organizationRepository.getOrCreatePersonalOrganization(userId, userId);
  return [organization.id];
}

/**
 * The same organization-membership resolution as resolveOrganizationIds
 * above, but for the handful of scan/component routes the Origami Lens
 * browser extension calls directly with no session cookie at all (it has no
 * login mechanism — see the extension's scan-coordinator.ts/
 * component-coordinator.ts). Those routes use authMiddleware.populateUser
 * (never rejects) instead of requireAuth, so request.user may legitimately
 * be undefined here; an empty array signals "anonymous caller" to those
 * routes, which then fall back to the pre-organization unscoped lookup by
 * id — the same access model these routes always had, and still safe since
 * the caller already knows the specific id (its own freshly-created scan/
 * job), not enumerating or listing anyone else's.
 */
async function resolveOrganizationIdsOptional(user: { id: string } | undefined): Promise<string[]> {
  if (!user) return [];
  return resolveOrganizationIds(user.id);
}

/**
 * The resolver every usageLimitMiddleware.requireQuota(...) preHandler uses
 * — only ever wired onto routes that already run authMiddleware.requireAuth
 * first, so request.user is always set by the time this runs. Prefers the
 * user's explicitly active workspace (set on workspace switch, or
 * automatically on accepting a workspace invitation — see
 * workspace-invitation-repository.ts) when it's still a real membership;
 * falls back to "first organization" exactly as before otherwise, so a
 * user who has never switched/accepted anything sees zero behavior change.
 */
async function resolveOrganizationIdForAuthenticatedRequest(request: FastifyRequest): Promise<string | undefined> {
  if (!request.user) return undefined;
  const ids = await resolveOrganizationIds(request.user.id);
  const active = request.user.activeOrganizationId;
  if (active && ids.includes(active)) return active;
  return ids[0];
}

/**
 * The single-resource "get this scan by its id" lookup shared by every
 * extension-reachable scan route: real organization-scoped access for a
 * logged-in dashboard caller, the original unscoped-by-id lookup for the
 * extension's anonymous caller — see resolveOrganizationIdsOptional's doc
 * comment for why that fallback is still safe.
 */
async function resolveScanForRequest(user: { id: string } | undefined, scanId: string) {
  if (user) {
    return store.getScanForOrganizationsAsync(scanId, await resolveOrganizationIds(user.id));
  }
  return store.getScanAsync(scanId);
}

/**
 * Phase 8 — best-effort reuse of Phase 4/5/6's real search/embedding/
 * reranking pipeline as an OPTIONAL evidence-gathering enhancement for
 * issue analysis/fix proposals (see repository-issue-analysis-service.ts's
 * SearchForEvidence doc comment). Never a hard dependency: a repository
 * without embeddings yet (or a reranker that's currently down) simply
 * causes this to throw, which the caller catches and ignores, falling back
 * to direct file/symbol evidence only. ownerId is intentionally omitted
 * here — by the time this runs, the calling route has already verified the
 * caller owns the repository, so this internal reuse call does not need to
 * repeat that check against itself.
 */
async function searchForRepositoryEvidence(repositoryId: string, query: string, limit: number): Promise<SearchEvidenceCandidate[]> {
  const repository = await repositoryStore.getByIdAsync(repositoryId);
  const response = await searchRepository(
    repository,
    { embeddingStore: repositoryEmbeddingStore, indexStore: repositoryIndexStore, searchRepository: repositorySearchRepository },
    { repositoryId, query, limit },
  );
  return response.results.map((r) => ({
    filePath: r.filePath, language: r.language, symbol: r.symbol, symbolType: r.symbolType, startLine: r.startLine, endLine: r.endLine, content: r.content ?? '',
  }));
}

const issueAnalysisDeps: RunIssueAnalysisDeps = { provider: new HttpIssueAnalysisProvider(), searchForEvidence: searchForRepositoryEvidence };
const fixProposalDeps: ProposeFixDeps = { provider: new HttpFixProposalProvider(), searchForEvidence: searchForRepositoryEvidence };

/** Phase 9 — repository AI assistant's LLM provider, isolated from gateway.ts exactly like Phase 8's issue-analysis/fix-proposal providers. */
const repositoryQaProvider = new HttpRepositoryQaProvider();

/** Maps a Phase 9 ask failure to an HTTP status — same "generic 404, never confirm existence" convention as searchErrorStatusCode/issueErrorStatusCode. Most codes are inherited 1:1 from Phase 5's own SearchError taxonomy (see repository-ai-service.ts's mapSearchErrorCode) since Q&A reuses searchRepository() directly. */
function askErrorStatusCode(code: RepositoryAskErrorCode): number {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_ACCESS_DENIED':
      return 404;
    case 'ASK_QUERY_INVALID':
    case 'REPOSITORY_NOT_READY':
    case 'EMBEDDINGS_NOT_READY':
      return 400;
    case 'EMBEDDING_TIMEOUT':
    case 'LLM_TIMEOUT':
      return 504;
    case 'EMBEDDING_PROVIDER_UNAVAILABLE':
    case 'LLM_PROVIDER_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

/** Maps a Phase 8 issue/analysis/proposal failure to an HTTP status — REPOSITORY_NOT_FOUND/REPOSITORY_ACCESS_DENIED/ISSUE_NOT_FOUND all map to 404, matching every other repository route's "never confirm existence to a caller it doesn't belong to" convention. */
function issueErrorStatusCode(code: RepositoryIssueErrorCode): number {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_ACCESS_DENIED':
    case 'ISSUE_NOT_FOUND':
    case 'ANALYSIS_NOT_FOUND':
    case 'PROPOSAL_NOT_FOUND':
      return 404;
    case 'REPOSITORY_NOT_READY':
    case 'ISSUE_VALIDATION_FAILED':
    case 'FILE_NOT_FOUND':
    case 'SYMBOL_NOT_FOUND':
    case 'ANALYSIS_FAILED':
    case 'PROPOSAL_INVALID':
      return 400;
    case 'ANALYSIS_IN_PROGRESS':
    case 'PROPOSAL_IN_PROGRESS':
    case 'PROPOSAL_ALREADY_DECIDED':
      return 409;
    case 'ANALYSIS_TIMEOUT':
    case 'PROPOSAL_TIMEOUT':
      return 504;
    case 'ANALYSIS_PROVIDER_UNAVAILABLE':
    case 'PROPOSAL_PROVIDER_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

/** Phase 10 — AI issue analysis + code fix proposal for a website-scan finding, isolated from gateway.ts exactly like Phase 8/9's providers. */
const findingFixProvider = new HttpFindingFixProvider();

/** Maps a Phase 10 finding-fix failure to an HTTP status — same "generic 404, never confirm existence" convention as every other repository route. Most codes are inherited 1:1 from Phase 5's own SearchError taxonomy since finding-fix reuses searchRepository() directly (see repository-finding-fix-service.ts's mapSearchErrorCode). */
function findingFixErrorStatusCode(code: RepositoryFixProposalErrorCode): number {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_ACCESS_DENIED':
    case 'FINDING_NOT_FOUND':
      return 404;
    case 'FINDING_INVALID':
    case 'REPOSITORY_NOT_READY':
    case 'EMBEDDINGS_NOT_READY':
    case 'PROPOSAL_INVALID':
      return 400;
    case 'EMBEDDING_TIMEOUT':
    case 'LLM_TIMEOUT':
      return 504;
    case 'EMBEDDING_PROVIDER_UNAVAILABLE':
    case 'LLM_PROVIDER_UNAVAILABLE':
      return 503;
    case 'LLM_INVALID_RESPONSE':
      // The LLM was reachable and answered — the response itself was
      // malformed/truncated. A "Bad Gateway"-shaped problem (matches the
      // AI Router's own 502 for this exact case), not "Service Unavailable".
      return 502;
    case 'REPOSITORY_MISMATCH':
      // This finding already has a different repository recorded against it
      // (see Issue.repositoryId) — a 409 (conflicts with the finding's
      // current state), same convention as fixApplicationErrorStatusCode's
      // STALE_REPOSITORY below.
      return 409;
    default:
      return 500;
  }
}

/** Maps a Phase 11 fix-application failure to an HTTP status — same "generic 404, never confirm existence" convention as every other repository route. STALE_REPOSITORY is a 409 (the request conflicts with the repository's current state); CANCELLED uses 499 (client closed the request) purely for log/diagnostic clarity — the reply is normally never actually sent in that case, since the client already disconnected. */
function fixApplicationErrorStatusCode(code: RepositoryFixApplyErrorCode): number {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_ACCESS_DENIED':
    case 'FINDING_NOT_FOUND':
      return 404;
    case 'REPOSITORY_NOT_READY':
    case 'PROPOSAL_INVALID':
    case 'UNSAFE_PATH':
    case 'SENSITIVE_FILE':
    case 'FILE_NOT_FOUND':
    case 'OLD_TEXT_NOT_FOUND':
    case 'OLD_TEXT_AMBIGUOUS':
    case 'SYNTAX_VALIDATION_FAILED':
    case 'SYNTAX_VALIDATION_UNSUPPORTED':
      return 400;
    case 'STALE_REPOSITORY':
      return 409;
    case 'CANCELLED':
      return 499;
    default:
      return 500;
  }
}

/** Maps a Phase 12 review/approval failure to an HTTP status. Extends fixApplicationErrorStatusCode's taxonomy 1:1 for every code Phase 11 can also throw (reviewFindingFix relays those verbatim); adds Phase 12's own workspace/approval/Git-workflow/PR codes. WORKFLOW_IN_PROGRESS and STALE_REPOSITORY are both 409 (the request conflicts with the resource's current state); GIT_AUTH_NOT_CONFIGURED/GIT_REMOTE_UNAVAILABLE/PROVIDER_UNSUPPORTED are 503 (a server-side configuration/dependency problem, not the caller's fault). */
function fixWorkflowErrorStatusCode(code: RepositoryFixWorkflowErrorCode): number {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_ACCESS_DENIED':
    case 'FINDING_NOT_FOUND':
    case 'WORKSPACE_NOT_FOUND':
      return 404;
    case 'REPOSITORY_NOT_READY':
    case 'PROPOSAL_INVALID':
    case 'UNSAFE_PATH':
    case 'SENSITIVE_FILE':
    case 'FILE_NOT_FOUND':
    case 'OLD_TEXT_NOT_FOUND':
    case 'OLD_TEXT_AMBIGUOUS':
    case 'SYNTAX_VALIDATION_FAILED':
    case 'SYNTAX_VALIDATION_UNSUPPORTED':
    case 'UNEXPECTED_CHANGES':
    case 'GIT_BRANCH_INVALID':
    case 'GIT_DIRTY_WORKTREE':
    case 'COMMIT_SHA_MISMATCH':
    case 'APPROVAL_REQUIRED':
      return 400;
    case 'STALE_REPOSITORY':
    case 'WORKSPACE_EXPIRED':
    case 'APPROVAL_EXPIRED':
    case 'GIT_BRANCH_EXISTS':
    case 'PR_ALREADY_EXISTS':
    case 'WORKFLOW_IN_PROGRESS':
      return 409;
    case 'CANCELLED':
      return 499;
    case 'GIT_AUTH_NOT_CONFIGURED':
    case 'GIT_REMOTE_UNAVAILABLE':
    case 'PROVIDER_UNSUPPORTED':
    case 'GIT_COMMIT_IDENTITY_MISSING':
      return 503;
    case 'GIT_COMMIT_FAILED':
    case 'GIT_PUSH_FAILED':
    case 'PR_CREATION_FAILED':
    case 'WORKSPACE_CREATION_FAILED':
    case 'GIT_DIFF_FAILED':
    case 'FIX_APPLICATION_FAILED':
    case 'FIX_WORKFLOW_FAILED':
    default:
      return 500;
  }
}

/** Maps a Phase 5 search failure to an HTTP status — REPOSITORY_NOT_FOUND and REPOSITORY_ACCESS_DENIED both map to 404 with the same generic message, matching every other repository route's "never confirm existence to a caller it doesn't belong to" convention. */
function searchErrorStatusCode(code: RepositorySearchErrorCode): number {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_ACCESS_DENIED':
      return 404;
    case 'SEARCH_QUERY_INVALID':
    case 'REPOSITORY_NOT_READY':
    case 'EMBEDDINGS_NOT_READY':
      return 400;
    case 'EMBEDDING_TIMEOUT':
    case 'RERANKER_TIMEOUT':
      return 504;
    case 'EMBEDDING_PROVIDER_UNAVAILABLE':
    case 'RERANKER_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

if (process.env.START_SCAN_WORKER !== 'false') {
  startWebsiteScanWorker();
  startComponentGenerationWorker(componentStore, componentGenerator);
  startRepositoryCloneWorker(repositoryCloneStore, repositoryStore);
  startRepositoryIndexWorker(repositoryIndexStore, repositoryStore, repositoryCloneStore, {
    getUserById: (id) => userRepository.getById(id),
    sendRepositoryIndexCompletedEmail,
    sendRepositoryIndexFailedEmail,
    webAppBaseUrl: WEB_APP_BASE_URL,
  });
  startRepositoryEmbeddingWorker(repositoryEmbeddingStore, repositoryStore, repositoryIndexStore);
  startRepositoryIssueAnalysisWorker(repositoryIssueStore, repositoryIssueAnalysisStore, repositoryIndexStore, issueAnalysisDeps);
  startRepositoryFixProposalWorker(repositoryIssueStore, repositoryIssueAnalysisStore, repositoryFixProposalStore, repositoryIndexStore, fixProposalDeps);

  // Phase 12 — periodically expires (and discards the retained workspace
  // for) any reviewed-but-never-approved fix application past its TTL. Not
  // a queue/worker (there is no job to process, only a sweep), so it runs
  // on a plain interval rather than through the BullMQ pattern above.
  const cleanupIntervalMs = Number(process.env.REPOSITORY_FIX_WORKFLOW_CLEANUP_INTERVAL_MS ?? 300_000);
  setInterval(() => {
    sweepExpiredFixWorkflows(repositoryFixWorkflowStore).catch((error) => {
      console.error('[repository-fix-workflow-cleanup] sweep failed:', error instanceof Error ? error.message : error);
    });
  }, cleanupIntervalMs).unref();

  // Same "plain interval, not a queue job" shape as the sweep above — see
  // subscription-expiry-sweep.ts's doc comment for why this can't be a
  // webhook reaction. Defaults to once a day; SUBSCRIPTION_EXPIRING_SOON_DAYS
  // controls how far ahead "soon" means (default 3 days).
  const subscriptionExpirySweepIntervalMs = Number(process.env.SUBSCRIPTION_EXPIRY_SWEEP_INTERVAL_MS ?? 86_400_000);
  setInterval(() => {
    sweepExpiringSubscriptions({
      subscriptionRepo: subscriptionRepository,
      organizationRepo: organizationRepository,
      sendBillingPlanExpiringSoonEmail,
      webAppBaseUrl: WEB_APP_BASE_URL,
      withinDays: Number(process.env.SUBSCRIPTION_EXPIRING_SOON_DAYS ?? 3),
    }).catch((error) => {
      console.error('[subscription-expiry-sweep] sweep failed:', error instanceof Error ? error.message : error);
    });
  }, subscriptionExpirySweepIntervalMs).unref();
}

const app = Fastify({ logger: true, bodyLimit: MAX_REQUEST_BODY_BYTES });

// credentials: true is required for the session cookie (Phase 16/A) to be
// sent/received on cross-origin requests (e.g. a production build where the
// frontend and API are on different origins) — origin:true still reflects
// the specific request Origin rather than '*', which is what makes a
// credentialed CORS response valid at all.
await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);
// Phase 20 — global: false means nothing is limited unless a route opts in
// via its own `config.rateLimit` (see the /workspace/invitations* and
// /invitations/:token* routes below) — no other route in this file is
// affected. No rate-limiting infrastructure existed anywhere before this.
await app.register(rateLimit, { global: false });

await registerStripeWebhookRoute(app, {
  getStripe: getStripeClient,
  getWebhookSecret: getStripeWebhookSecret,
  eventRepo: stripeWebhookEventRepository,
  subscriptionRepo: subscriptionRepository,
  retrieveSubscription: async (subscriptionId) => {
    const stripe = getStripeClient();
    if (!stripe) throw new Error('Stripe not configured');
    return stripe.subscriptions.retrieve(subscriptionId);
  },
  webAppBaseUrl: WEB_APP_BASE_URL,
  sendBillingSubscriptionStartedEmail,
  sendBillingPaymentSuccessfulEmail,
  sendBillingPaymentFailedEmail,
  sendBillingSubscriptionCancelledEmail,
});

app.get('/health', async () => ({ status: 'ok', service: 'origami-api' }));

/*
 * Phase 16/A — GitHub OAuth login. This is Origami Lens's own application
 * identity (a `users` row + a server-side session), NOT a Git provider
 * authorization — no repository, branch, commit, or PR is ever touched by
 * this flow. See the Phase 16 design report: provider-scoped Git access
 * (GitHub App installation, GitLab/Bitbucket OAuth) is a separate, later
 * phase with its own credential storage.
 */
const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

app.get('/auth/github/login', async (request, reply) => {
  if (!isGitHubOAuthConfigured()) {
    return reply.status(503).send({ error: 'GitHub OAuth login is not configured.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }
  const state = randomUUID();
  reply.setCookie(OAUTH_STATE_COOKIE, state, sessionCookieOptions(request, OAUTH_STATE_TTL_MS));
  return reply.redirect(buildGitHubAuthorizeUrl(state));
});

app.get<{ Querystring: { code?: string; state?: string } }>('/auth/github/callback', async (request, reply) => {
  const expectedState = request.cookies?.[OAUTH_STATE_COOKIE];
  reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

  const { code, state } = request.query ?? {};
  if (!code || !state || !expectedState || state !== expectedState) {
    return reply.status(400).send({ error: 'OAuth state did not match — please try signing in again.', errorCode: 'OAUTH_STATE_MISMATCH' });
  }

  if (!userRepository.isEnabled() || !sessionRepository.isEnabled()) {
    return reply.status(503).send({ error: 'Authentication requires a configured database.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }

  try {
    const result = await loginWithGitHub(code, { userRepo: userRepository, sessionRepo: sessionRepository, organizationRepo: organizationRepository, founderBootstrap, completeGitHubOAuthLogin });
    const ttlMs = new Date(result.expiresAt).getTime() - Date.now();
    reply.setCookie(SESSION_COOKIE_NAME, result.sessionId, sessionCookieOptions(request, Math.max(ttlMs, 0)));
    return reply.redirect(WEB_APP_BASE_URL);
  } catch (error) {
    if (error instanceof AuthError || error instanceof GitHubOAuthError) {
      return reply.status(error.code === 'AUTH_NOT_CONFIGURED' ? 503 : 502).send({ error: error.message, errorCode: error.code });
    }
    throw error;
  }
});

/*
 * Phase 16/G — Google login: a second application-identity provider,
 * alongside GitHub above, for users with no GitHub/GitLab/Bitbucket account
 * (Founders, Agencies, Designers, QA, PMs). Same double-submit-cookie CSRF
 * state pattern, same session cookie, own state cookie name so a Google
 * login attempt can never be satisfied by a GitHub callback's state or vice
 * versa. Never touches a repository/branch/commit/PR.
 */
const GOOGLE_OAUTH_STATE_COOKIE = 'google_oauth_state';

app.get('/auth/google/login', async (request, reply) => {
  if (!isGoogleOAuthConfigured()) {
    return reply.status(503).send({ error: 'Google OAuth login is not configured.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }
  const state = randomUUID();
  reply.setCookie(GOOGLE_OAUTH_STATE_COOKIE, state, sessionCookieOptions(request, OAUTH_STATE_TTL_MS));
  return reply.redirect(buildGoogleAuthorizeUrl(state));
});

app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/google/callback', async (request, reply) => {
  const expectedState = request.cookies?.[GOOGLE_OAUTH_STATE_COOKIE];
  reply.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, { path: '/' });

  const { code, state, error } = request.query ?? {};
  if (error) {
    return reply.status(400).send({ error: 'Google authorization was denied.', errorCode: 'OAUTH_EXCHANGE_FAILED' });
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return reply.status(400).send({ error: 'OAuth state did not match — please try signing in again.', errorCode: 'OAUTH_STATE_MISMATCH' });
  }

  if (!userRepository.isEnabled() || !sessionRepository.isEnabled()) {
    return reply.status(503).send({ error: 'Authentication requires a configured database.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }

  try {
    const result = await loginWithGoogle(code, { userRepo: userRepository, sessionRepo: sessionRepository, organizationRepo: organizationRepository, founderBootstrap, completeGoogleOAuthLogin });
    const ttlMs = new Date(result.expiresAt).getTime() - Date.now();
    reply.setCookie(SESSION_COOKIE_NAME, result.sessionId, sessionCookieOptions(request, Math.max(ttlMs, 0)));
    return reply.redirect(WEB_APP_BASE_URL);
  } catch (error_) {
    if (error_ instanceof AuthError || error_ instanceof GoogleOAuthError) {
      return reply.status(error_.code === 'AUTH_NOT_CONFIGURED' ? 503 : 502).send({ error: error_.message, errorCode: error_.code });
    }
    throw error_;
  }
});

/**
 * Phase 16/H — email + password, a third application-identity provider
 * alongside GitHub/Google above. Same session/cookie tail as those two
 * flows; the only difference is there's no OAuth code exchange or redirect —
 * these are plain JSON POST routes the login/register pages call directly.
 */
function passwordAuthErrorStatusCode(code: AuthErrorCode): number {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 401;
    case 'EMAIL_ALREADY_REGISTERED':
      return 409;
    case 'WEAK_PASSWORD':
    case 'RESET_TOKEN_INVALID':
    case 'VERIFICATION_TOKEN_INVALID':
      return 400;
    case 'AUTH_NOT_CONFIGURED':
      return 503;
    default:
      return 500;
  }
}

app.post<{ Body: RegisterRequest }>('/auth/register', async (request, reply) => {
  if (!userRepository.isEnabled() || !sessionRepository.isEnabled()) {
    return reply.status(503).send({ error: 'Authentication requires a configured database.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }
  try {
    const { email, password, displayName } = request.body ?? {};
    const result = await registerWithEmail(
      { email: email ?? '', password: password ?? '', displayName: displayName ?? '' },
      {
        userRepo: userRepository,
        sessionRepo: sessionRepository,
        organizationRepo: organizationRepository,
        founderBootstrap,
        emailVerification: emailVerificationTokenRepository.isEnabled()
          ? { tokenRepo: emailVerificationTokenRepository, sendEmailVerificationEmail, webAppBaseUrl: WEB_APP_BASE_URL }
          : undefined,
      },
    );
    reply.setCookie(SESSION_COOKIE_NAME, result.sessionId, sessionCookieOptions(request, getSessionTtlMs()));
    return { user: result.user };
  } catch (error) {
    if (error instanceof PasswordAuthError) {
      return reply.status(passwordAuthErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    }
    throw error;
  }
});

app.post<{ Body: LoginRequest }>('/auth/login', async (request, reply) => {
  if (!userRepository.isEnabled() || !sessionRepository.isEnabled()) {
    return reply.status(503).send({ error: 'Authentication requires a configured database.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }
  try {
    const { email, password } = request.body ?? {};
    const result = await loginWithEmail(
      { email: email ?? '', password: password ?? '' },
      { userRepo: userRepository, sessionRepo: sessionRepository, organizationRepo: organizationRepository, founderBootstrap },
    );
    reply.setCookie(SESSION_COOKIE_NAME, result.sessionId, sessionCookieOptions(request, getSessionTtlMs()));
    return { user: result.user };
  } catch (error) {
    if (error instanceof PasswordAuthError) {
      return reply.status(passwordAuthErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    }
    throw error;
  }
});

app.post<{ Body: ForgotPasswordRequest }>('/auth/forgot-password', async (request): Promise<ForgotPasswordResponse> => {
  if (userRepository.isEnabled() && passwordResetTokenRepository.isEnabled()) {
    await requestPasswordReset(request.body?.email ?? '', {
      userRepo: userRepository,
      tokenRepo: passwordResetTokenRepository,
      sendPasswordResetEmail,
      sendPasswordChangedEmail,
      webAppBaseUrl: WEB_APP_BASE_URL,
    });
  }
  // Always the same response whether the database is configured, the email
  // exists, or sending actually succeeded — see requestPasswordReset's doc
  // comment for why none of that is ever revealed to the caller.
  return { ok: true };
});

app.post<{ Body: ResetPasswordRequest }>('/auth/reset-password', async (request, reply) => {
  if (!userRepository.isEnabled() || !passwordResetTokenRepository.isEnabled()) {
    return reply.status(503).send({ error: 'Authentication requires a configured database.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }
  try {
    const { token, password } = request.body ?? {};
    await resetPassword(token ?? '', password ?? '', {
      userRepo: userRepository,
      tokenRepo: passwordResetTokenRepository,
      sendPasswordChangedEmail,
      webAppBaseUrl: WEB_APP_BASE_URL,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof PasswordAuthError) {
      return reply.status(passwordAuthErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    }
    throw error;
  }
});

app.post<{ Body: VerifyEmailRequest }>('/auth/verify-email', async (request, reply) => {
  if (!userRepository.isEnabled() || !emailVerificationTokenRepository.isEnabled()) {
    return reply.status(503).send({ error: 'Authentication requires a configured database.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }
  try {
    await confirmEmailVerification(request.body?.token ?? '', { userRepo: userRepository, tokenRepo: emailVerificationTokenRepository });
    return { ok: true };
  } catch (error) {
    if (error instanceof PasswordAuthError) {
      return reply.status(passwordAuthErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    }
    throw error;
  }
});

app.post<{ Body: ResendVerificationEmailRequest }>('/auth/resend-verification-email', async (request): Promise<ResendVerificationEmailResponse> => {
  if (userRepository.isEnabled() && emailVerificationTokenRepository.isEnabled()) {
    await resendVerificationEmail(request.body?.email ?? '', {
      userRepo: userRepository,
      tokenRepo: emailVerificationTokenRepository,
      sendEmailVerificationEmail,
      webAppBaseUrl: WEB_APP_BASE_URL,
    });
  }
  // Same non-enumeration shape as /auth/forgot-password — always { ok: true }.
  return { ok: true };
});

app.post('/auth/logout', async (request, reply) => {
  const sessionId = request.cookies?.[SESSION_COOKIE_NAME];
  if (sessionRepository.isEnabled()) {
    await logoutSession(sessionId, sessionRepository);
  }
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  return { ok: true };
});

app.get('/auth/me', async (request): Promise<AuthMeResponse> => {
  await authMiddleware.populateUser(request);
  return { user: request.user ?? null };
});

/**
 * Phase 3 — the one-time onboarding question ("which best describes you?").
 * Requires auth (there's no anonymous persona); always overwrites, so a user
 * can revisit and change their answer later — nothing here is a one-shot
 * lock. Purely descriptive (see the Persona contract type's doc comment):
 * this route never gates access to anything.
 */
const VALID_PERSONAS = new Set<Persona>(['DEVELOPER', 'FOUNDER', 'AGENCY', 'DESIGNER', 'QA_TEAM', 'PRODUCT_MANAGER']);

app.post<{ Body: { persona?: unknown } }>('/auth/persona', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const persona = request.body?.persona;
  if (typeof persona !== 'string' || !VALID_PERSONAS.has(persona as Persona)) {
    return reply.status(400).send({ error: 'persona must be one of ' + Array.from(VALID_PERSONAS).join(', ') + '.' });
  }
  const user = await userRepository.updatePersona(request.user!.id, persona as Persona);
  return { user };
});

/*
 * Phase 16/C — GitHub App connection ("Connect GitHub" for Git push/PR
 * access, distinct from Phase A's OAuth login). All four routes require an
 * authenticated Origami Lens session; the connecting user is always
 * request.user.id, never a client-supplied value — matches Phase 16/B's
 * ownership rule exactly.
 */
const GITHUB_INSTALL_STATE_COOKIE = 'gh_install_state';
const GITHUB_INSTALL_STATE_TTL_MS = 10 * 60 * 1000;

app.get('/providers/github/connect', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  if (!isGitHubAppConfigured()) {
    return reply.status(503).send({ error: 'GitHub App is not configured.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }
  const state = randomUUID();
  reply.setCookie(GITHUB_INSTALL_STATE_COOKIE, state, sessionCookieOptions(request, GITHUB_INSTALL_STATE_TTL_MS));
  return reply.redirect(buildGitHubAppInstallUrl(state));
});

app.get<{ Querystring: { installation_id?: string; state?: string } }>(
  '/providers/github/callback',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const expectedState = request.cookies?.[GITHUB_INSTALL_STATE_COOKIE];
    reply.clearCookie(GITHUB_INSTALL_STATE_COOKIE, { path: '/' });

    const { installation_id: installationIdRaw, state } = request.query ?? {};
    if (!state || !expectedState || state !== expectedState) {
      return reply.status(400).send({ error: 'State did not match — please try connecting GitHub again.', errorCode: 'OAUTH_STATE_MISMATCH' });
    }
    const installationId = Number(installationIdRaw);
    if (!installationIdRaw || !Number.isFinite(installationId)) {
      return reply.status(400).send({ error: 'GitHub did not report a valid installation id.' });
    }

    await connectGitHubInstallation(request.user!.id, installationId, { connectionRepo: providerConnectionRepository });
    return reply.redirect(WEB_APP_BASE_URL);
  },
);

/*
 * Phase 16/D — GitLab OAuth connection. Same shape as the GitHub App
 * connect/callback pair above: double-submit-cookie CSRF state, requireAuth
 * on both legs (the authenticated browser session carries across the
 * GitLab redirect round trip), and the connecting user is always
 * request.user.id.
 */
const GITLAB_OAUTH_STATE_COOKIE = 'gl_oauth_state';
const GITLAB_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

app.get('/providers/gitlab/connect', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  if (!isGitLabOAuthConfigured()) {
    return reply.status(503).send({ error: 'GitLab OAuth is not configured.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }
  const state = randomUUID();
  reply.setCookie(GITLAB_OAUTH_STATE_COOKIE, state, sessionCookieOptions(request, GITLAB_OAUTH_STATE_TTL_MS));
  return reply.redirect(buildGitLabAuthorizeUrl(state));
});

app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
  '/providers/gitlab/callback',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const expectedState = request.cookies?.[GITLAB_OAUTH_STATE_COOKIE];
    reply.clearCookie(GITLAB_OAUTH_STATE_COOKIE, { path: '/' });

    const { code, state, error } = request.query ?? {};
    if (error) {
      return reply.status(400).send({ error: 'GitLab authorization was denied.', errorCode: 'OAUTH_EXCHANGE_FAILED' });
    }
    if (!state || !expectedState || state !== expectedState) {
      return reply.status(400).send({ error: 'State did not match — please try connecting GitLab again.', errorCode: 'OAUTH_STATE_MISMATCH' });
    }
    if (!code) {
      return reply.status(400).send({ error: 'GitLab did not return an authorization code.' });
    }

    try {
      await connectGitLabAccount(request.user!.id, code, { connectionRepo: providerConnectionRepository });
    } catch (error_) {
      if (error_ instanceof GitLabOAuthError) {
        return reply.status(502).send({ error: error_.message, errorCode: error_.code });
      }
      throw error_;
    }
    return reply.redirect(WEB_APP_BASE_URL);
  },
);

/*
 * Phase 16/E — Bitbucket OAuth connection. Same shape as the GitLab OAuth
 * connect/callback pair above (double-submit-cookie CSRF state, requireAuth
 * on both legs, connecting user always request.user.id).
 */
const BITBUCKET_OAUTH_STATE_COOKIE = 'bb_oauth_state';
const BITBUCKET_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

app.get('/providers/bitbucket/connect', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  if (!isBitbucketOAuthConfigured()) {
    return reply.status(503).send({ error: 'Bitbucket OAuth is not configured.', errorCode: 'AUTH_NOT_CONFIGURED' });
  }
  const state = randomUUID();
  reply.setCookie(BITBUCKET_OAUTH_STATE_COOKIE, state, sessionCookieOptions(request, BITBUCKET_OAUTH_STATE_TTL_MS));
  return reply.redirect(buildBitbucketAuthorizeUrl(state));
});

app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
  '/providers/bitbucket/callback',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const expectedState = request.cookies?.[BITBUCKET_OAUTH_STATE_COOKIE];
    reply.clearCookie(BITBUCKET_OAUTH_STATE_COOKIE, { path: '/' });

    const { code, state, error } = request.query ?? {};
    if (error) {
      return reply.status(400).send({ error: 'Bitbucket authorization was denied.', errorCode: 'OAUTH_EXCHANGE_FAILED' });
    }
    if (!state || !expectedState || state !== expectedState) {
      return reply.status(400).send({ error: 'State did not match — please try connecting Bitbucket again.', errorCode: 'OAUTH_STATE_MISMATCH' });
    }
    if (!code) {
      return reply.status(400).send({ error: 'Bitbucket did not return an authorization code.' });
    }

    try {
      await connectBitbucketAccount(request.user!.id, code, { connectionRepo: providerConnectionRepository });
    } catch (error_) {
      if (error_ instanceof BitbucketOAuthError) {
        return reply.status(502).send({ error: error_.message, errorCode: error_.code });
      }
      throw error_;
    }
    return reply.redirect(WEB_APP_BASE_URL);
  },
);

app.get('/providers/connections', { preHandler: authMiddleware.requireAuth }, async (request): Promise<ListProviderConnectionsResponse> => {
  const connections = await providerConnectionRepository.listForUser(request.user!.id);
  return {
    connections: connections.map((c) => ({ id: c.id, provider: c.provider, externalAccountLogin: c.externalAccountLogin, status: c.status, createdAt: c.createdAt })),
  };
});

/*
 * "Disconnect" must remove BOTH Origami Lens's own record AND (for GitHub)
 * the real App installation on GitHub's side — previously this only ever
 * revoked our local row, leaving the App installed and fully able to be
 * re-adopted by findInstallationForRepo/findActiveForUserAndInstallation
 * with no trace in our own UI, which is exactly what caused the confusing
 * "I disconnected but it's still there" loop this was found from. The
 * GitHub call happens BEFORE the local revoke but its failure never blocks
 * the local revoke — the user's disconnect intent must always succeed
 * locally even if GitHub's API has a transient issue; a 404 there is
 * treated as already-uninstalled (see uninstallGitHubApp).
 */
app.delete<{ Params: { id: string } }>('/providers/connections/:id', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const connection = await providerConnectionRepository.findByIdForUser(request.user!.id, request.params.id);
  if (!connection) return reply.status(404).send({ error: 'Connection not found' });

  let githubUninstallError: string | undefined;
  if (connection.provider === 'GITHUB' && connection.installationId) {
    try {
      await uninstallGitHubApp(connection.installationId);
    } catch (error) {
      githubUninstallError = error instanceof Error ? error.message : 'Failed to uninstall the GitHub App installation.';
      console.error('Failed to uninstall GitHub App installation on disconnect:', githubUninstallError);
    }
  }

  // Bitbucket Cloud has no server-callable revoke API at all (confirmed against
  // Atlassian's own docs/support forum — not a gap in our integration, a real
  // platform limitation) — so unlike GitHub above, there is nothing to attempt
  // here. This is always true for Bitbucket, not a failure path, so it's a
  // separate field from githubUninstallError rather than reusing it.
  const bitbucketManualRevokeRequired = connection.provider === 'BITBUCKET';

  const revoked = await providerConnectionRepository.revokeForUser(request.user!.id, request.params.id);
  if (!revoked) return reply.status(404).send({ error: 'Connection not found' });
  return { ok: true, githubUninstallError, bitbucketManualRevokeRequired };
});

function billingErrorStatusCode(code: BillingErrorCode): number {
  switch (code) {
    case 'BILLING_NOT_CONFIGURED':
      return 503;
    case 'USAGE_LIMIT_EXCEEDED':
      return 402;
    case 'INVALID_PLAN':
    case 'SEAT_COUNT_INVALID':
      return 400;
    case 'CHECKOUT_SESSION_NOT_FOUND':
    case 'ORGANIZATION_NOT_FOUND':
      return 404;
    default:
      return 500;
  }
}

/*
 * Phase 17 — Stripe billing/entitlements. A subscription/plan belongs to the
 * caller's organization (see resolveOrganizationIdForAuthenticatedRequest),
 * not the user directly — see @origami/contracts' PLAN_DEFINITIONS doc
 * comment. POST /billing/webhook is registered separately above (needs a
 * raw request body for Stripe signature verification).
 */
app.get('/billing/status', { preHandler: authMiddleware.requireAuth }, async (request, reply): Promise<BillingStatusResponse | undefined> => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  return getBillingStatus(entitlementService, subscriptionRepository, organizationId);
});

app.post<{ Body: CreateCheckoutSessionRequest }>('/billing/checkout', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageBilling);
    return await createCheckoutSession(
      {
        stripe: getStripeClient(),
        subscriptionRepo: subscriptionRepository,
        webAppBaseUrl: WEB_APP_BASE_URL,
        organizationName: request.user!.displayName ?? request.user!.primaryProviderLogin,
        customerEmail: request.user!.email,
      },
      organizationId,
      request.body,
    );
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
    if (error instanceof BillingError) return reply.status(billingErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.post('/billing/portal', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageBilling);
    return await createBillingPortalSession(
      { stripe: getStripeClient(), subscriptionRepo: subscriptionRepository, webAppBaseUrl: WEB_APP_BASE_URL },
      organizationId,
    );
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
    if (error instanceof BillingError) return reply.status(billingErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.get<{ Params: { sessionId: string } }>('/billing/session/:sessionId', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    return await getCheckoutSessionStatus(getStripeClient(), subscriptionRepository, organizationId, request.params.sessionId);
  } catch (error) {
    if (error instanceof BillingError) return reply.status(billingErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.patch<{ Body: UpdateSeatsRequest }>('/billing/seats', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageBilling);
    await updateSeats({ stripe: getStripeClient(), subscriptionRepo: subscriptionRepository }, organizationId, request.body.seats);
    return { ok: true };
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
    if (error instanceof BillingError) return reply.status(billingErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

function workspaceErrorStatusCode(code: WorkspaceErrorCode): number {
  switch (code) {
    case 'FORBIDDEN':
      return 403;
    case 'MEMBER_NOT_FOUND':
      return 404;
    case 'MEMBER_ALREADY_EXISTS':
    case 'CANNOT_REMOVE_LAST_OWNER':
    case 'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN':
      return 400;
    default:
      return 500;
  }
}

function adminErrorStatusCode(code: AdminErrorCode): number {
  switch (code) {
    case 'FORBIDDEN':
      return 403;
    case 'USER_NOT_FOUND':
      return 404;
    case 'CANNOT_DEMOTE_LAST_FOUNDER':
      return 400;
    default:
      return 500;
  }
}

async function getPlanForOrganization(organizationId: string) {
  const subscription = await subscriptionRepository.getOrCreateForOrganization(organizationId);
  return subscription.plan;
}

const workspaceMemberServiceDeps = {
  userRepo: userRepository,
  organizationRepo: organizationRepository,
  getPlan: getPlanForOrganization,
  auditLog: auditLogRepository,
  sendWorkspaceMemberAddedEmail,
  sendWorkspaceMemberRemovedEmail,
  webAppBaseUrl: WEB_APP_BASE_URL,
};

const WORKSPACE_INVITATION_EXPIRATION_DAYS = Number(process.env.WORKSPACE_INVITATION_EXPIRATION_DAYS ?? 7);

const workspaceInvitationServiceDeps = {
  invitationRepo: workspaceInvitationRepository,
  organizationRepo: organizationRepository,
  userRepo: userRepository,
  getPlan: getPlanForOrganization,
  auditLog: auditLogRepository,
  sendWorkspaceInvitationEmail,
  webAppBaseUrl: WEB_APP_BASE_URL,
  expirationDays: WORKSPACE_INVITATION_EXPIRATION_DAYS,
};

function workspaceInvitationErrorStatusCode(code: WorkspaceInvitationErrorCode): number {
  switch (code) {
    case 'FORBIDDEN':
      return 403;
    case 'INVITATION_NOT_FOUND':
      return 404;
    case 'INVALID_ROLE':
    case 'INVALID_EMAIL':
    case 'MEMBER_ALREADY_EXISTS':
    case 'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN':
    case 'INVITATION_EXPIRED':
    case 'INVITATION_REVOKED':
    case 'INVITATION_ALREADY_ACCEPTED':
    case 'EMAIL_MISMATCH':
      return 400;
    default:
      return 500;
  }
}

/*
 * Phase 18 — workspace membership/role management. Every route acts on the
 * CALLER's own resolved organization (resolveOrganizationIdForAuthenticatedRequest)
 * rather than an :organizationId path param — matching every other route in
 * this file (billing included) that assumes one active organization per
 * user, since multi-workspace switching doesn't exist in the frontend yet.
 */
app.get('/workspace/members', { preHandler: authMiddleware.requireAuth }, async (request, reply): Promise<ListWorkspaceMembersResponse | undefined> => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canReadWorkspaceResource);
    return { members: await listWorkspaceMembers(workspaceMemberServiceDeps, organizationId) };
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
    throw error;
  }
});

app.post<{ Body: AddWorkspaceMemberRequest }>('/workspace/members', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageMembers);
    return await addWorkspaceMemberByEmail(workspaceMemberServiceDeps, organizationId, request.user!.id, request.body.email, request.body.role);
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
    if (error instanceof WorkspaceMemberError) return reply.status(workspaceErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.patch<{ Params: { userId: string }; Body: UpdateWorkspaceMemberRoleRequest }>(
  '/workspace/members/:userId',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
    if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
    try {
      await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageMembers);
      await updateWorkspaceMemberRole(workspaceMemberServiceDeps, organizationId, request.user!.id, request.params.userId, request.body.role);
      return { ok: true };
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
      if (error instanceof WorkspaceMemberError) return reply.status(workspaceErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
      throw error;
    }
  },
);

app.delete<{ Params: { userId: string } }>('/workspace/members/:userId', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageMembers);
    await removeWorkspaceMember(workspaceMemberServiceDeps, organizationId, request.user!.id, request.params.userId);
    return { ok: true };
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
    if (error instanceof WorkspaceMemberError) return reply.status(workspaceErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.post<{ Body: TransferWorkspaceOwnershipRequest }>('/workspace/transfer-ownership', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canTransferOwnership);
    await transferWorkspaceOwnership(workspaceMemberServiceDeps, organizationId, request.user!.id, request.body.newOwnerUserId);
    return { ok: true };
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
    if (error instanceof WorkspaceMemberError) return reply.status(workspaceErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

/** The one lightweight lookup the frontend uses to hide/disable actions a user can't perform — the API remains authoritative regardless (every mutating route re-checks the role itself). */
app.get('/workspace/role', { preHandler: authMiddleware.requireAuth }, async (request, reply): Promise<WorkspaceRoleResponse | undefined> => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  const role = await getWorkspaceRoleOrThrow(organizationRepository, request.user!.id, organizationId).catch(() => undefined);
  if (!role) return reply.status(403).send({ error: 'Not a member of this workspace.', errorCode: 'FORBIDDEN' });
  return { organizationId, role };
});

/*
 * Phase 20 — workspace email invitations. Membership is created only on
 * explicit acceptance (workspace-invitation-service.ts) — see the approved
 * plan's "IMPORTANT: do NOT add to workspace_members at creation time" rule.
 * The three management routes act on the caller's own resolved organization,
 * same convention as /workspace/members above; the two /invitations/:token
 * routes are keyed entirely by the token itself, not by organization.
 */
app.post<{ Body: CreateWorkspaceInvitationRequest }>(
  '/workspace/invitations',
  { preHandler: authMiddleware.requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
  async (request, reply) => {
    const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
    if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
    try {
      await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageMembers);
      const { invitation, emailDelivered } = await createWorkspaceInvitation(
        workspaceInvitationServiceDeps,
        organizationId,
        request.user!.id,
        request.body.email,
        request.body.role,
      );
      return { invitation, emailDelivered };
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
      if (error instanceof WorkspaceInvitationError) return reply.status(workspaceInvitationErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
      throw error;
    }
  },
);

app.get('/workspace/invitations', { preHandler: authMiddleware.requireAuth }, async (request, reply): Promise<ListWorkspaceInvitationsResponse | undefined> => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageMembers);
    return { invitations: await listWorkspaceInvitations(workspaceInvitationServiceDeps, organizationId) };
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
    throw error;
  }
});

app.delete<{ Params: { id: string } }>('/workspace/invitations/:id', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
  if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
  try {
    await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageMembers);
    await revokeWorkspaceInvitation(workspaceInvitationServiceDeps, organizationId, request.user!.id, request.params.id);
    return { ok: true };
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
    if (error instanceof WorkspaceInvitationError) return reply.status(workspaceInvitationErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.post<{ Params: { id: string } }>(
  '/workspace/invitations/:id/resend',
  { preHandler: authMiddleware.requireAuth, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
  async (request, reply) => {
    const organizationId = await resolveOrganizationIdForAuthenticatedRequest(request);
    if (!organizationId) return reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
    try {
      await assertWorkspaceRole(organizationRepository, request.user!.id, organizationId, canManageMembers);
      const { invitation, emailDelivered } = await resendWorkspaceInvitation(workspaceInvitationServiceDeps, organizationId, request.user!.id, request.params.id);
      return { invitation, emailDelivered };
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError) return reply.status(403).send({ error: error.message, errorCode: 'FORBIDDEN' });
      if (error instanceof WorkspaceInvitationError) return reply.status(workspaceInvitationErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
      throw error;
    }
  },
);

/** Public — no auth required. Only what the link's possessor should already know (never the token itself, never anything else). */
app.get<{ Params: { token: string } }>(
  '/invitations/:token',
  { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
  async (request): Promise<InvitationPreviewResponse> => {
    return getInvitationPreview(workspaceInvitationServiceDeps, request.params.token);
  },
);

app.post<{ Params: { token: string } }>(
  '/invitations/:token/accept',
  { preHandler: authMiddleware.requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
  async (request, reply): Promise<AcceptInvitationResponse | undefined> => {
    try {
      return await acceptWorkspaceInvitation(workspaceInvitationServiceDeps, request.params.token, request.user!);
    } catch (error) {
      if (error instanceof WorkspaceInvitationError) return reply.status(workspaceInvitationErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
      throw error;
    }
  },
);

/** The workspace switcher's data source — every organization the caller belongs to. */
app.get('/workspace/list-mine', { preHandler: authMiddleware.requireAuth }, async (request): Promise<ListMyWorkspacesResponse> => {
  const workspaces = await organizationRepository.listOrganizationsForUser(request.user!.id);
  return { workspaces };
});

app.post<{ Body: SwitchWorkspaceRequest }>('/workspace/switch', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const role = await organizationRepository.getMembershipRole(request.body.organizationId, request.user!.id);
  if (!role) return reply.status(404).send({ error: 'Not a member of that workspace.', errorCode: 'MEMBER_NOT_FOUND' });
  await userRepository.updateActiveOrganizationId(request.user!.id, request.body.organizationId);
  return { ok: true };
});

/*
 * Phase 18/19 — platform administration + the operational activity
 * dashboard. FOUNDER or ADMIN only for reads; assigning a platform role is
 * FOUNDER-only (canAssignPlatformRole).
 */
const adminServiceDeps = {
  userRepo: userRepository,
  organizationRepo: organizationRepository,
  subscriptionRepo: subscriptionRepository,
  sessionRepo: sessionRepository,
  getUsageToday: (organizationId: string) => entitlementService.getUsageToday(organizationId),
  auditLog: auditLogRepository,
};

app.get<{ Querystring: { search?: string; role?: PlatformRole; plan?: SubscriptionPlan } }>(
  '/admin/users',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply): Promise<AdminListUsersResponse | undefined> => {
    if (!isPlatformAdmin(request.user!)) return reply.status(403).send({ error: 'Platform administration access required.', errorCode: 'FORBIDDEN' });
    const { search, role, plan } = request.query;
    return { users: await searchUsersForAdmin(adminServiceDeps, { search, role, plan }) };
  },
);

app.get<{ Params: { id: string } }>('/admin/users/:id', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.status(403).send({ error: 'Platform administration access required.', errorCode: 'FORBIDDEN' });
  try {
    return await getUserDetailForAdmin(adminServiceDeps, request.params.id);
  } catch (error) {
    if (error instanceof AdminError) return reply.status(adminErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.get('/admin/workspaces', { preHandler: authMiddleware.requireAuth }, async (request, reply): Promise<AdminListWorkspacesResponse | undefined> => {
  if (!isPlatformAdmin(request.user!)) return reply.status(403).send({ error: 'Platform administration access required.', errorCode: 'FORBIDDEN' });
  return { workspaces: await listWorkspacesForAdmin(adminServiceDeps) };
});

app.get('/admin/overview', { preHandler: authMiddleware.requireAuth }, async (request, reply): Promise<AdminOverviewResponse | undefined> => {
  if (!isPlatformAdmin(request.user!)) return reply.status(403).send({ error: 'Platform administration access required.', errorCode: 'FORBIDDEN' });
  return getAdminOverview(adminServiceDeps);
});

app.get<{ Querystring: { type?: AdminActivityType; status?: string; limit?: string } }>(
  '/admin/activity',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply): Promise<ListAdminActivityResponse | undefined> => {
    if (!isPlatformAdmin(request.user!)) return reply.status(403).send({ error: 'Platform administration access required.', errorCode: 'FORBIDDEN' });
    const { type, status, limit } = request.query;
    return { items: await listActiveActivity({ type, status, limit: limit ? Number(limit) : undefined }) };
  },
);

app.get<{ Querystring: { limit?: string } }>(
  '/admin/activity/recent',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply): Promise<ListAdminActivityResponse | undefined> => {
    if (!isPlatformAdmin(request.user!)) return reply.status(403).send({ error: 'Platform administration access required.', errorCode: 'FORBIDDEN' });
    return { items: await listRecentActivity(request.query.limit ? Number(request.query.limit) : undefined) };
  },
);

app.get('/admin/system-health', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.status(403).send({ error: 'Platform administration access required.', errorCode: 'FORBIDDEN' });
  const [dependencies, workerHealth] = await Promise.all([checkDependencies(), getWorkerHealthReport()]);
  return { ...dependencies, postgres: workerHealth.postgres, redis: workerHealth.redis, queues: workerHealth.queues };
});

app.patch<{ Params: { id: string }; Body: UpdatePlatformRoleRequest }>('/admin/users/:id/platform-role', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  if (!canAssignPlatformRole(request.user!)) return reply.status(403).send({ error: 'Only a Founder can assign platform roles.', errorCode: 'FORBIDDEN' });
  try {
    const updated = await updateUserPlatformRole(adminServiceDeps, request.user!.id, request.params.id, request.body.platformRole);
    return { user: updated };
  } catch (error) {
    if (error instanceof AdminError) return reply.status(adminErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.get('/health/dependencies', async () => checkDependencies());

// Phase 17 — upgraded from populateUser to requireAuth: a daily inspection
// quota (usageLimitMiddleware.requireQuota) can only be enforced against a
// resolved organization, so an anonymous caller is now rejected with 401
// rather than silently running an unmetered scan.
app.post<{ Body: ScanRequest }>(
  '/scan',
  {
    preHandler: [
      authMiddleware.requireAuth,
      workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest),
      usageLimitMiddleware.requireQuota('INSPECTION', resolveOrganizationIdForAuthenticatedRequest),
    ],
  },
  async (request, reply) => {
  const { url } = request.body;

  if (!url) {
    return reply.status(400).send({ error: 'url is required' });
  }

  try {
    new URL(url);
  } catch {
    return reply.status(400).send({ error: 'Invalid URL' });
  }

  try {
    const organizationId = (await resolveOrganizationIdsOptional(request.user))[0];
    const result = await pipeline.runScan(request.body, organizationId);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scan failed';
    request.log.error(error);
    return reply.status(500).send({ error: message });
  }
});

// Phase 17 — upgraded from populateUser to requireAuth: a daily inspection
// quota can only be enforced against a resolved organization, so an
// anonymous caller (e.g. the extension with no session) is now rejected
// with 401 rather than silently running an unmetered scan.
app.post<{ Body: CreateScanRequest }>(
  '/scans',
  {
    preHandler: [
      authMiddleware.requireAuth,
      workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest),
      usageLimitMiddleware.requireQuota('INSPECTION', resolveOrganizationIdForAuthenticatedRequest),
    ],
  },
  async (request, reply) => {
  const body = request.body;
  const scanType: ScanType = body.scanType ?? 'CURRENT_PAGE';

  if (!body.url) {
    return reply.status(400).send({ error: 'url is required' });
  }

  try {
    new URL(body.url);
  } catch {
    return reply.status(400).send({ error: 'Invalid URL' });
  }

  if (scanType === 'CURRENT_PAGE') {
    try {
      const organizationId = (await resolveOrganizationIdsOptional(request.user))[0];
      const result = await pipeline.runScan(body, organizationId);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scan failed';
      return reply.status(500).send({ error: message });
    }
  }

  if (scanType === 'WEBSITE') {
    if (!isDatabaseEnabled()) {
      return reply.status(503).send({
        error: 'Website scans require PostgreSQL. Set DATABASE_URL and run pnpm db:migrate.',
      });
    }

    const maxPages = Math.min(
      body.websiteOptions?.maxPages ?? DEFAULT_WEBSITE_MAX_PAGES,
      MAX_WEBSITE_PAGES,
    );

    try {
      const organizationId = (await resolveOrganizationIdsOptional(request.user))[0];
      const scanId = await createWebsiteScanRecord(
        repo,
        body.url,
        { ...body.websiteOptions, maxPages, discoveryMethod: body.websiteOptions?.discoveryMethod ?? 'AUTOMATIC' },
        body.ownerId,
        organizationId,
      );

      const enqueued = await enqueueWebsiteScan({
        scanId,
        rootUrl: body.url,
        options: body.websiteOptions ?? { discoveryMethod: 'AUTOMATIC', maxPages },
        ownerId: body.ownerId,
      });

      if (!enqueued) {
        return reply.status(503).send({
          error: 'Website scans require Redis. Set REDIS_URL and ensure Redis is running.',
        });
      }

      return {
        scanId,
        url: body.url,
        scanType: 'WEBSITE',
        status: 'QUEUED',
        progress: { discoveredPages: 0, completedPages: 0, failedPages: 0, issuesFound: 0 },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create website scan';
      return reply.status(500).send({ error: message });
    }
  }

  if (scanType === 'PROJECT') {
    return reply.status(501).send({ error: 'PROJECT scans are not yet implemented' });
  }

  return reply.status(400).send({ error: 'Invalid scanType' });
});

app.get('/scans', { preHandler: authMiddleware.requireAuth }, async (request) => ({
  scans: await store.listScansForOrganizationsAsync(await resolveOrganizationIds(request.user!.id)),
}));

// preHandler is populateUser (never rejects) — the extension fetches its own
// just-created scan by id with no session cookie; see resolveScanForRequest.
app.get<{ Params: { scanId: string } }>('/scans/:scanId', { preHandler: authMiddleware.populateUser }, async (request, reply) => {
  const scan = await resolveScanForRequest(request.user, request.params.scanId);
  if (!scan) {
    return reply.status(404).send({ error: 'Scan not found' });
  }
  return {
    ...scan,
    issuesByCategory: countIssuesByCategory(scan.issues as import('@origami/contracts').Issue[]),
  };
});

app.delete<{ Params: { scanId: string } }>('/scans/:scanId', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const deleted = await store.deleteScanForOrganizationsAsync(request.params.scanId, await resolveOrganizationIds(request.user!.id));
  if (!deleted) {
    return reply.status(404).send({ error: 'Scan not found' });
  }
  artifactStore.deleteScanArtifacts(request.params.scanId);
  return { ok: true };
});

// preHandler is populateUser (never rejects) — the extension polls this
// with no session cookie; see resolveScanForRequest.
app.get<{ Params: { scanId: string } }>('/scans/:scanId/status', { preHandler: authMiddleware.populateUser }, async (request, reply) => {
  if (!repo.isEnabled()) {
    const scan = await resolveScanForRequest(request.user, request.params.scanId);
    if (!scan) return reply.status(404).send({ error: 'Scan not found' });
    return {
      scanId: scan.scanId,
      scanType: scan.scanType ?? 'CURRENT_PAGE',
      status: scan.status ?? 'COMPLETED',
      progress: scan.progress ?? {
        discoveredPages: 1,
        completedPages: 1,
        failedPages: 0,
        issuesFound: scan.issues.length,
      },
      healthScore: scan.healthScore,
    };
  }

  const status = request.user
    ? await repo.getScanStatusForOrganizations(request.params.scanId, await resolveOrganizationIds(request.user.id))
    : await repo.getScanStatus(request.params.scanId);
  if (!status) {
    const scan = await resolveScanForRequest(request.user, request.params.scanId);
    if (!scan) return reply.status(404).send({ error: 'Scan not found' });
    return {
      scanId: scan.scanId,
      scanType: scan.scanType ?? 'CURRENT_PAGE',
      status: scan.status ?? 'COMPLETED',
      progress: scan.progress ?? {
        discoveredPages: 1,
        completedPages: 1,
        failedPages: 0,
        issuesFound: scan.issues.length,
      },
      healthScore: scan.healthScore,
    };
  }
  return status;
});

// preHandler is populateUser (never rejects) — the extension's popup fetches
// this with no session cookie; see resolveScanForRequest.
app.get<{ Params: { scanId: string } }>('/scans/:scanId/pages', { preHandler: authMiddleware.populateUser }, async (request, reply) => {
  if (!repo.isEnabled()) {
    return reply.status(404).send({ error: 'Page list not available for legacy scans' });
  }

  const pages = request.user
    ? await repo.getPageScansForOrganizations(request.params.scanId, await resolveOrganizationIds(request.user.id))
    : await repo.getPageScans(request.params.scanId);
  if (pages === undefined) {
    return reply.status(404).send({ error: 'Scan not found' });
  }
  if (pages.length === 0) {
    const scan = await resolveScanForRequest(request.user, request.params.scanId);
    if (!scan) return reply.status(404).send({ error: 'Scan not found' });
    if (scan.scanType !== 'WEBSITE') {
      return reply.status(404).send({ error: 'Not a website scan' });
    }
  }
  return { scanId: request.params.scanId, pages };
});

app.get<{ Params: { scanId: string; pageScanId: string } }>(
  '/scans/:scanId/pages/:pageScanId',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    if (!repo.isEnabled()) {
      return reply.status(404).send({ error: 'Page detail not available' });
    }

    const detail = await repo.getPageScanDetailForOrganizations(request.params.scanId, request.params.pageScanId, await resolveOrganizationIds(request.user!.id));
    if (!detail) {
      return reply.status(404).send({ error: 'Page scan not found' });
    }
    return { scanId: request.params.scanId, ...detail };
  },
);

app.get<{ Params: { scanId: string; key: string } }>(
  '/scans/:scanId/artifacts/:key',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const scan = await store.getScanForOrganizationsAsync(request.params.scanId, await resolveOrganizationIds(request.user!.id));
    if (!scan) {
      return reply.status(404).send({ error: 'Scan not found' });
    }

    const filePath = artifactStore.getArtifactPath(request.params.scanId, request.params.key);
    if (!filePath) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }
    const data = fs.readFileSync(filePath);
    return reply.type('image/jpeg').send(data);
  },
);

app.get<{ Params: { scanId: string }; Querystring: IssueFilters }>(
  '/scans/:scanId/issues',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const scan = await store.getScanForOrganizationsAsync(request.params.scanId, await resolveOrganizationIds(request.user!.id));
    if (!scan) {
      return reply.status(404).send({ error: 'Scan not found' });
    }

    const issues = filterIssues(scan.issues as import('@origami/contracts').Issue[], request.query);
    return { scanId: scan.scanId, url: scan.url, issues, total: issues.length };
  },
);

const VALID_EXPORT_FORMATS = new Set<ReportExportFormat>(['pdf', 'json', 'markdown', 'csv']);

/**
 * One consolidated export route for all four formats (spec explicitly
 * permits this over four separate routes) — same ownership check as every
 * other scan route above, no new permission model. Never re-scans, never
 * recomputes the Health Score, never calls AI — buildLensReport only reads
 * the already-persisted scan.
 */
app.get<{ Params: { scanId: string; format: string } }>(
  '/scans/:scanId/report/export/:format',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const format = request.params.format as ReportExportFormat;
    if (!VALID_EXPORT_FORMATS.has(format)) {
      return reply.status(400).send({ error: `Unknown export format: ${request.params.format}`, errorCode: 'INVALID_EXPORT_FORMAT' });
    }

    const scan = await store.getScanForOrganizationsAsync(request.params.scanId, await resolveOrganizationIds(request.user!.id));
    if (!scan) {
      return reply.status(404).send({ error: 'Scan not found' });
    }
    if (!isReportReady(scan.status)) {
      return reply.status(409).send({ error: 'This scan has not completed successfully yet, so it has no report to export.', errorCode: 'REPORT_NOT_READY' });
    }

    const report = buildLensReport(scan);
    switch (format) {
      case 'json':
        return reply
          .type('application/json')
          .header('Content-Disposition', `attachment; filename="${reportFilename(scan.url, 'report', 'json')}"`)
          .send(renderReportJson(report));
      case 'markdown':
        return reply
          .type('text/markdown')
          .header('Content-Disposition', `attachment; filename="${reportFilename(scan.url, 'report', 'md')}"`)
          .send(renderReportMarkdown(report));
      case 'csv':
        return reply
          .type('text/csv')
          .header('Content-Disposition', `attachment; filename="${reportFilename(scan.url, 'issues', 'csv')}"`)
          .send(renderReportCsv(report));
      case 'pdf': {
        const pdf = await renderReportPdf(report);
        return reply
          .type('application/pdf')
          .header('Content-Disposition', `attachment; filename="${reportFilename(scan.url, 'report', 'pdf')}"`)
          .send(pdf);
      }
    }
  },
);

function reportShareErrorStatusCode(code: ReportShareError['code']): number {
  switch (code) {
    case 'SCAN_NOT_FOUND':
    case 'REPORT_SHARE_NOT_FOUND':
      return 404;
    case 'REPORT_NOT_READY':
      return 409;
    case 'INVALID_EXPORT_FORMAT':
      return 400;
  }
}

const reportShareDeps = { shareLinkRepo: reportShareLinkRepository, scanStore: store, webAppBaseUrl: WEB_APP_BASE_URL };

app.get<{ Params: { scanId: string } }>('/scans/:scanId/report/share', { preHandler: authMiddleware.requireAuth }, async (request, reply): Promise<ReportShareStatusResponse | undefined> => {
  try {
    return await getReportShareStatus(reportShareDeps, request.params.scanId, await resolveOrganizationIds(request.user!.id));
  } catch (error) {
    if (error instanceof ReportShareError) return reply.status(reportShareErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.post<{ Params: { scanId: string } }>('/scans/:scanId/report/share', { preHandler: authMiddleware.requireAuth }, async (request, reply): Promise<CreateReportShareResponse | undefined> => {
  try {
    return await createOrRotateReportShare(reportShareDeps, request.params.scanId, await resolveOrganizationIds(request.user!.id), request.user!.id);
  } catch (error) {
    if (error instanceof ReportShareError) return reply.status(reportShareErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.delete<{ Params: { scanId: string } }>('/scans/:scanId/report/share', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  try {
    await revokeReportShare(reportShareDeps, request.params.scanId, await resolveOrganizationIds(request.user!.id));
    return { ok: true };
  } catch (error) {
    if (error instanceof ReportShareError) return reply.status(reportShareErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

/** Public — no auth required, matching /invitations/:token's exact precedent. The raw token IS the authorization; only its hash is ever stored. */
app.get<{ Params: { token: string } }>(
  '/reports/share/:token',
  { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } },
  async (request, reply) => {
    try {
      return await getSharedReportByToken(reportShareDeps, request.params.token);
    } catch (error) {
      if (error instanceof ReportShareError) return reply.status(reportShareErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
      throw error;
    }
  },
);

app.get<{ Params: { issueId: string } }>('/issues/:issueId', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const found = await store.getIssueForOrganizationsAsync(request.params.issueId, await resolveOrganizationIds(request.user!.id));
  if (!found) {
    return reply.status(404).send({ error: 'Issue not found' });
  }
  return {
    issue: found.issue,
    scan: {
      scanId: found.scan.scanId,
      url: found.scan.url,
      scannedAt: found.scan.scannedAt,
      healthScore: found.scan.healthScore,
      scanType: found.scan.scanType,
    },
  };
});

/**
 * Which repository (if any) a finding's AI fix/PR should target — lets the
 * frontend skip the manual repository picker (IssueDetailPage.tsx) when
 * there's nothing to actually choose (a repository already recorded, or only
 * one connected repository), and otherwise shows the picker with the
 * candidates already labeled by role. See repository-finding-resolution-
 * service.ts for why this never guesses between multiple candidates.
 */
app.get<{ Params: { issueId: string } }>('/issues/:issueId/repository-resolution', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const organizationIds = await resolveOrganizationIds(request.user!.id);
  const found = await store.getIssueForOrganizationsAsync(request.params.issueId, organizationIds);
  if (!found) {
    return reply.status(404).send({ error: 'Issue not found' });
  }
  const repositories = await repositoryStore.listForOrganizationsAsync(organizationIds);
  return resolveRepositoryForIssue(found.issue, repositories);
});

app.patch<{ Params: { issueId: string }; Body: { status: IssueStatus } }>(
  '/issues/:issueId/status',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const { status } = request.body;
    const valid: IssueStatus[] = ['open', 'in_progress', 'resolved', 'ignored'];
    if (!status || !valid.includes(status)) {
      return reply.status(400).send({ error: 'Invalid status' });
    }

    const updated = await store.updateIssueStatusForOrganizationsAsync(request.params.issueId, status, await resolveOrganizationIds(request.user!.id));
    if (!updated) {
      return reply.status(404).send({ error: 'Issue not found' });
    }
    return { issue: updated };
  },
);

// The three /ai/* routes below are stateless passthroughs — they take the
// issue/question/evidence directly in the request body and never look up or
// touch any stored, owned data, so there's no ownership boundary to gate:
// the Origami Lens browser extension (which has no login/session mechanism
// at all) calls these directly, exactly as it always has.
app.post<{ Body: ExplainIssueRequest }>('/ai/explain-issue', async (request, reply) => {
  if (!request.body.issue) {
    return reply.status(400).send({ error: 'issue is required' });
  }

  try {
    return await pipeline.explainIssue(request.body.issue, request.body.evidence);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI explain failed';
    return reply.status(500).send({ error: message, aiAvailable: false });
  }
});

app.post<{ Body: AskRequest }>('/ai/ask', async (request, reply) => {
  if (!request.body.question) {
    return reply.status(400).send({ error: 'question is required' });
  }

  try {
    const response = await fetch(`${AI_ROUTER_URL}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30000),
    });
    return await response.json();
  } catch (error) {
    return reply.status(500).send({
      answer: 'AI explanation unavailable.',
      aiAvailable: false,
      error: error instanceof Error ? error.message : 'Ask failed',
    });
  }
});

app.post<{ Body: Record<string, unknown> }>('/ai/suggest-fix', async (request, reply) => {
  try {
    const response = await fetch(`${AI_ROUTER_URL}/suggest-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30000),
    });
    return await response.json();
  } catch (error) {
    return reply.status(500).send({
      fix: {},
      aiAvailable: false,
      error: error instanceof Error ? error.message : 'Suggest fix failed',
    });
  }
});

app.get('/component-targets', { preHandler: authMiddleware.requireAuth }, async () => ({ targets: CODE_TARGET_META }));

// Phase 17 — upgraded from populateUser to requireAuth: a daily
// Screenshot -> Code quota can only be enforced against a resolved
// organization, so an anonymous caller is now rejected with 401.
app.post<{ Body: CreateComponentJobRequest }>(
  '/components',
  {
    preHandler: [
      authMiddleware.requireAuth,
      workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest),
      usageLimitMiddleware.requireQuota('SCREENSHOT_TO_CODE', resolveOrganizationIdForAuthenticatedRequest),
    ],
  },
  async (request, reply) => {
  const { target, evidence, ownerId } = request.body;

  const validTargets: CodeTarget[] = ['REACT', 'NEXT_JS', 'TAILWIND', 'HTML_CSS'];
  if (!target || !validTargets.includes(target)) {
    return reply.status(400).send({ error: `target must be one of ${validTargets.join(', ')}` });
  }
  if (!evidence?.sourceUrl || !evidence.screenshotBase64 || !evidence.element) {
    return reply.status(400).send({ error: 'evidence.sourceUrl, evidence.screenshotBase64 and evidence.element are required' });
  }
  try {
    new URL(evidence.sourceUrl);
  } catch {
    return reply.status(400).send({ error: 'evidence.sourceUrl is not a valid URL' });
  }

  const jobId = randomUUID();
  const now = new Date().toISOString();
  const organizationId = (await resolveOrganizationIdsOptional(request.user))[0];

  const queued: ComponentGenerationJob = {
    jobId,
    ownerId,
    organizationId,
    sourceUrl: evidence.sourceUrl,
    pageTitle: evidence.pageTitle,
    target,
    status: 'QUEUED',
    aiAvailable: false,
    createdAt: now,
    updatedAt: now,
  };
  componentStore.saveJob(queued);
  if (componentRepo.isEnabled()) {
    await componentRepo.createJob({ jobId, ownerId, organizationId, sourceUrl: evidence.sourceUrl, pageTitle: evidence.pageTitle, target }).catch(() => {});
  }
  await componentStore.saveEvidence(jobId, evidence);

  // Fire-and-forget: generation runs detached from this HTTP request/response
  // cycle inside the API process, so it survives the extension popup closing.
  enqueueComponentJob(componentStore, componentGenerator, {
    jobId,
    sourceUrl: evidence.sourceUrl,
    pageTitle: evidence.pageTitle,
    target,
    evidence,
    ownerId,
    organizationId,
  });

  return reply.status(202).send({ jobId, status: 'QUEUED' });
});

app.post<{ Params: { jobId: string }; Body: { target?: CodeTarget } }>(
  '/components/:jobId/retry',
  {
    preHandler: [
      authMiddleware.requireAuth,
      workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest),
      usageLimitMiddleware.requireQuota('SCREENSHOT_TO_CODE', resolveOrganizationIdForAuthenticatedRequest),
    ],
  },
  async (request, reply) => {
  const organizationIds = await resolveOrganizationIds(request.user!.id);
  const original = await componentStore.getJobForOrganizationsAsync(request.params.jobId, organizationIds);
  const evidence = original ? await componentStore.getEvidenceAsync(request.params.jobId) : undefined;
  if (!original || !evidence) {
    return reply.status(404).send({ error: 'Original selection evidence is no longer available. Please make a new selection on the page.' });
  }

  const target = request.body?.target ?? original.target;
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const organizationId = organizationIds[0];

  const queued: ComponentGenerationJob = {
    jobId,
    ownerId: original.ownerId,
    organizationId,
    sourceUrl: original.sourceUrl,
    pageTitle: original.pageTitle,
    target,
    status: 'QUEUED',
    aiAvailable: false,
    createdAt: now,
    updatedAt: now,
  };
  componentStore.saveJob(queued);
  if (componentRepo.isEnabled()) {
    await componentRepo.createJob({ jobId, ownerId: original.ownerId, organizationId, sourceUrl: original.sourceUrl, pageTitle: original.pageTitle, target }).catch(() => {});
  }
  await componentStore.saveEvidence(jobId, evidence);

  enqueueComponentJob(componentStore, componentGenerator, {
    jobId,
    sourceUrl: original.sourceUrl,
    pageTitle: original.pageTitle,
    target,
    evidence,
    ownerId: original.ownerId,
    organizationId,
  });

  return reply.status(202).send({ jobId, status: 'QUEUED' });
});

app.post<{ Params: { jobId: string } }>('/components/:jobId/cancel', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const existing = await componentStore.getJobForOrganizationsAsync(request.params.jobId, await resolveOrganizationIds(request.user!.id));
  if (!existing) {
    return reply.status(404).send({ error: 'Component generation job not found' });
  }

  const updated = await cancelComponentJob(componentStore, request.params.jobId);
  if (!updated) {
    return reply.status(404).send({ error: 'Component generation job not found' });
  }
  return { jobId: updated.jobId, status: updated.status };
});

app.get('/components', { preHandler: authMiddleware.requireAuth }, async (request) => {
  return { jobs: await componentStore.listJobsForOrganizationsAsync(await resolveOrganizationIds(request.user!.id)) };
});

/** Mirrors DELETE /repositories/:id exactly — no on-disk workspace to clean up afterward (see UnifiedComponentStore.deleteForOrganizationsAsync), since a component job's evidence/result live entirely in its own row. */
app.delete<{ Params: { jobId: string } }>('/components/:jobId', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const deleted = await componentStore.deleteForOrganizationsAsync(request.params.jobId, await resolveOrganizationIds(request.user!.id));
  if (!deleted) {
    return reply.status(404).send({ error: 'Component generation job not found' });
  }
  return { ok: true };
});

// preHandler is populateUser (never rejects) — the extension polls its own
// just-created job by id with no session cookie; see
// resolveOrganizationIdsOptional's doc comment for why the anonymous
// unscoped-by-id fallback is still safe.
app.get<{ Params: { jobId: string } }>('/components/:jobId', { preHandler: authMiddleware.populateUser }, async (request, reply) => {
  const job = request.user
    ? await componentStore.getJobForOrganizationsAsync(request.params.jobId, await resolveOrganizationIds(request.user.id))
    : await componentStore.getJobAsync(request.params.jobId);
  if (!job) {
    return reply.status(404).send({ error: 'Component generation job not found' });
  }
  return job;
});

/*
 * Repository Feature — Phase 1: public repository connection + metadata
 * only. No cloning, indexing, credentials, or AI analysis — see the
 * Repository Feature Audit. Deliberately isolated from every route above:
 * its own store, its own service module, no shared state with Screenshot ->
 * Code or scans.
 */
/*
 * Phase 16/B — every /repositories* route below requires an authenticated
 * Origami Lens session (authMiddleware.requireAuth) and derives ownership
 * exclusively from request.user.id — never from a client-supplied ownerId
 * field (removed from CreateRepositoryRequest entirely; any ownerId still
 * present on an inline route Body/Querystring type below is now dead —
 * simply never read for authorization). See repository-service.ts's
 * canAccessRepository for the strict, no-fail-open comparison this relies
 * on, and migration 012 for the real `repositories.user_id` FK.
 */
const VALID_REPOSITORY_ROLES = new Set(['FRONTEND', 'BACKEND', 'FULL_STACK']);

app.post<{ Body: CreateRepositoryRequest }>(
  '/repositories',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canConfigureRepository, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
  const { repoUrl, branch, role } = request.body ?? {};

  const parsedUrl = parseRepositoryUrl(repoUrl);
  if (!parsedUrl.ok) {
    return reply.status(400).send({ error: parsedUrl.error });
  }

  const parsedBranch = validateBranch(branch);
  if (!parsedBranch.ok) {
    return reply.status(400).send({ error: parsedBranch.error });
  }

  if (role !== undefined && !VALID_REPOSITORY_ROLES.has(role)) {
    return reply.status(400).send({ error: `role must be one of ${[...VALID_REPOSITORY_ROLES].join(', ')}.` });
  }

  try {
    const repository = await repositoryStore.create({
      id: randomUUID(),
      userId: request.user!.id,
      organizationId: (await resolveOrganizationIds(request.user!.id))[0],
      repoUrl: parsedUrl.value.normalizedUrl,
      provider: parsedUrl.value.provider,
      branch: parsedBranch.value,
      role,
    });

    const owner = await userRepository.getById(request.user!.id);
    if (owner?.email) {
      const repoName = (() => {
        try {
          return new URL(repository.repoUrl).pathname.replace(/^\//, '');
        } catch {
          return repository.repoUrl;
        }
      })();
      try {
        await sendRepositoryConnectedEmail(owner.email, {
          repoName,
          role: repository.role,
          repositoryId: repository.id,
          webAppBaseUrl: WEB_APP_BASE_URL,
        });
      } catch (error) {
        console.error('[index] Failed to send repository-connected email:', error instanceof Error ? error.message : error);
      }
    }

    return reply.status(201).send(repository);
  } catch (error) {
    if (error instanceof DuplicateRepositoryError) {
      return reply.status(409).send({ error: error.message });
    }
    throw error;
  }
});

app.get('/repositories', { preHandler: authMiddleware.requireAuth }, async (request) => {
  return { repositories: await repositoryStore.listForOrganizationsAsync(await resolveOrganizationIds(request.user!.id)) };
});

app.get<{ Params: { id: string } }>('/repositories/:id', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  // Filtered at the SQL layer (WHERE id = ? AND user_id = ?) — a repository
  // belonging to another user never leaves the database. Same "not found"
  // response whether the repository truly doesn't exist or simply doesn't
  // belong to this caller — never confirms existence to a non-owner.
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }
  return repository;
});

app.delete<{ Params: { id: string } }>(
  '/repositories/:id',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canConfigureRepository, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
  const deleted = await repositoryStore.deleteForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!deleted) {
    return reply.status(404).send({ error: 'Repository not found' });
  }
  deleteRepositoryClones(request.params.id);
  return { ok: true };
});

/*
 * Repository Feature — Phase 2: clone a connected repository into isolated
 * storage, checkout the requested branch, and deterministically discover its
 * structure. No Tree-sitter/AST/indexing/embeddings/AI analysis, and the
 * worker never executes any code contained in the repository — see
 * workers/repository-clone-worker.ts.
 */
app.post<{ Params: { id: string }; Body: { ownerId?: string } }>(
  '/repositories/:id/clone',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canConfigureRepository, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  // Duplicate job protection: never let two clones for the same repository
  // run at once. Returns the already-in-flight job rather than creating a
  // second one.
  const latest = await repositoryCloneStore.getLatestForRepositoryAsync(repository.id);
  if (latest && (latest.status === 'QUEUED' || latest.status === 'RUNNING')) {
    return reply.status(409).send({
      error: 'A clone job for this repository is already in progress.',
      jobId: latest.jobId,
      repositoryId: repository.id,
      status: latest.status,
    });
  }

  const jobId = randomUUID();
  const job = await repositoryCloneStore.create({ id: jobId, repositoryId: repository.id, ownerId: repository.userId });
  enqueueRepositoryCloneJob(repositoryCloneStore, repositoryStore, {
    jobId,
    repositoryId: repository.id,
    ownerId: repository.userId,
    provider: repository.provider,
    repoUrl: repository.repoUrl,
    branch: repository.branch,
  });

  const response: CloneRepositoryResponse = { jobId: job.jobId, repositoryId: repository.id, status: job.status };
  return reply.status(202).send(response);
});

app.get<{ Params: { id: string }; Querystring: { ownerId?: string } }>('/repositories/:id/clone-status', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  const job = await repositoryCloneStore.getLatestForRepositoryAsync(repository.id);
  if (!job) {
    return reply.status(404).send({ error: 'No clone job found for this repository' });
  }

  // Every value here is read straight from the persisted job record — never
  // fabricated or estimated.
  return {
    repositoryId: repository.id,
    jobId: job.jobId,
    status: job.status,
    commitSha: job.commitSha,
    fileCount: job.discovery?.fileCount,
    directoryCount: job.discovery?.directoryCount,
    totalSizeBytes: job.discovery?.totalSizeBytes,
    topLevelDirectories: job.discovery?.topLevelDirectories,
    topLevelFiles: job.discovery?.topLevelFiles,
    extensions: job.discovery?.extensions,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
});

app.post<{ Params: { id: string }; Body: { ownerId?: string } }>('/repositories/:id/clone/cancel', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  const latest = await repositoryCloneStore.getLatestForRepositoryAsync(repository.id);
  if (!latest) {
    return reply.status(404).send({ error: 'No clone job found for this repository' });
  }

  const updated = await cancelRepositoryCloneJob(repositoryCloneStore, repositoryStore, latest.jobId);
  if (!updated) {
    return reply.status(404).send({ error: 'Clone job not found' });
  }
  return { jobId: updated.jobId, repositoryId: repository.id, status: updated.status };
});

/*
 * Repository Feature — Phase 3: Tree-sitter/AST parsing + deterministic code
 * chunking of a repository's most recent successful clone. No embeddings,
 * no pgvector, no AI calls — see workers/repository-index-worker.ts. The
 * worker only ever reads and parses repository files; it never executes
 * anything found inside them.
 */
const INDEXABLE_REPOSITORY_STATUSES = new Set(['READY_FOR_INDEXING', 'READY_FOR_SEARCH', 'INDEXING']);

app.post<{ Params: { id: string }; Body: { ownerId?: string } }>(
  '/repositories/:id/index',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canConfigureRepository, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  if (!INDEXABLE_REPOSITORY_STATUSES.has(repository.status)) {
    return reply.status(400).send({ error: 'Repository must be cloned successfully before it can be indexed.' });
  }

  const cloneJob = await repositoryCloneStore.getLatestForRepositoryAsync(repository.id);
  if (!cloneJob || cloneJob.status !== 'COMPLETED' || !cloneJob.commitSha) {
    return reply.status(400).send({ error: 'No successful clone is available to index.' });
  }

  // Duplicate job protection is scoped to repository + commit — a QUEUED or
  // RUNNING job for this exact commit is reused rather than starting a
  // second, redundant index of the same content.
  const latestIndexJob = await repositoryIndexStore.getLatestForCommitAsync(repository.id, cloneJob.commitSha);
  if (latestIndexJob && (latestIndexJob.status === 'QUEUED' || latestIndexJob.status === 'RUNNING')) {
    return reply.status(409).send({
      error: 'An index job for this repository and commit is already in progress.',
      jobId: latestIndexJob.jobId,
      repositoryId: repository.id,
      status: latestIndexJob.status,
    });
  }

  const jobId = randomUUID();
  const job = await repositoryIndexStore.create({
    id: jobId,
    repositoryId: repository.id,
    cloneJobId: cloneJob.jobId,
    ownerId: repository.userId,
    commitSha: cloneJob.commitSha,
  });
  enqueueRepositoryIndexJob(repositoryIndexStore, repositoryStore, repositoryCloneStore, {
    jobId,
    repositoryId: repository.id,
    cloneJobId: cloneJob.jobId,
    ownerId: repository.userId,
  });

  const response: StartRepositoryIndexResponse = { jobId: job.jobId, repositoryId: repository.id, status: job.status };
  return reply.status(202).send(response);
});

app.get<{ Params: { id: string }; Querystring: { ownerId?: string } }>('/repositories/:id/index-status', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  const job = await repositoryIndexStore.getLatestForRepositoryAsync(repository.id);
  if (!job) {
    return reply.status(404).send({ error: 'No index job found for this repository' });
  }

  // A terminal job's persisted summary columns are the source of truth; a
  // still-running job has no final counts yet, so live counts are computed
  // straight from its own rows instead — both are real persisted data,
  // never estimated.
  const isTerminalJob = job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED';
  const counts = isTerminalJob
    ? { filesIndexed: job.filesIndexed ?? 0, filesSkipped: job.filesSkipped ?? 0, chunksCreated: job.chunksCreated ?? 0 }
    : await repositoryIndexStore.getSummaryAsync(job.jobId);

  return {
    repositoryId: repository.id,
    jobId: job.jobId,
    status: job.status,
    commitSha: job.commitSha,
    filesIndexed: counts.filesIndexed,
    filesSkipped: counts.filesSkipped,
    chunksCreated: counts.chunksCreated,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
});

app.get<{ Params: { id: string }; Querystring: { ownerId?: string } }>('/repositories/:id/index-summary', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  const job = await repositoryIndexStore.getLatestForRepositoryAsync(repository.id);
  if (!job) {
    return reply.status(404).send({ error: 'No index job found for this repository' });
  }

  const summary = await repositoryIndexStore.getSummaryAsync(job.jobId);
  const response: RepositoryIndexSummary = {
    repositoryId: repository.id,
    jobId: job.jobId,
    status: job.status,
    commitSha: job.commitSha,
    filesIndexed: summary.filesIndexed,
    filesSkipped: summary.filesSkipped,
    chunksCreated: summary.chunksCreated,
    languages: summary.languages,
  };
  return response;
});

app.post<{ Params: { id: string }; Body: { ownerId?: string } }>('/repositories/:id/index/cancel', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  const latest = await repositoryIndexStore.getLatestForRepositoryAsync(repository.id);
  if (!latest) {
    return reply.status(404).send({ error: 'No index job found for this repository' });
  }

  const updated = await cancelRepositoryIndexJob(repositoryIndexStore, repositoryStore, latest.jobId);
  if (!updated) {
    return reply.status(404).send({ error: 'Index job not found' });
  }
  return { jobId: updated.jobId, repositoryId: repository.id, status: updated.status };
});

/*
 * Repository Feature — Phase 4: BGE-M3 embeddings for a repository's Phase 3
 * code chunks, stored via pgvector. No semantic search yet (Phase 5), no
 * repository AI analysis — see workers/repository-embedding-worker.ts. This
 * worker only ever calls the AI Router's dedicated POST /embed route; it
 * never talks to a model server directly and never touches /gateway's
 * chat-completion routing/timeouts.
 */
const EMBEDDABLE_REPOSITORY_STATUSES = new Set(['READY_FOR_SEARCH', 'EMBEDDING', 'EMBEDDINGS_READY']);

app.post<{ Params: { id: string }; Body: { ownerId?: string } }>(
  '/repositories/:id/embed',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canConfigureRepository, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  if (!EMBEDDABLE_REPOSITORY_STATUSES.has(repository.status)) {
    return reply.status(400).send({ error: 'Repository must be indexed successfully before embeddings can be generated.' });
  }

  const indexJob = await repositoryIndexStore.getLatestForRepositoryAsync(repository.id);
  if (!indexJob || indexJob.status !== 'COMPLETED') {
    return reply.status(400).send({ error: 'No successful repository index is available to embed.' });
  }

  // Duplicate job protection, scoped to repository + commit — a QUEUED or
  // RUNNING job for this exact commit is reused rather than starting a
  // second, redundant embedding run.
  const latestEmbeddingJob = await repositoryEmbeddingStore.getLatestForCommitAsync(repository.id, indexJob.commitSha);
  if (latestEmbeddingJob && (latestEmbeddingJob.status === 'QUEUED' || latestEmbeddingJob.status === 'RUNNING')) {
    return reply.status(409).send({
      error: 'An embedding job for this repository and commit is already in progress.',
      jobId: latestEmbeddingJob.jobId,
      repositoryId: repository.id,
      status: latestEmbeddingJob.status,
    });
  }

  // Model comes from server configuration only — never from the request
  // (see the Phase 4 report's security section). Matches gateway.ts's own
  // TASK_MODEL_MAP.repository_search fallback exactly.
  const model = process.env.AI_EMBED_MODEL ?? 'BGE-M3';

  const jobId = randomUUID();
  const job = await repositoryEmbeddingStore.create({
    id: jobId,
    repositoryId: repository.id,
    indexJobId: indexJob.jobId,
    ownerId: repository.userId,
    commitSha: indexJob.commitSha,
    model,
  });
  enqueueRepositoryEmbeddingJob(repositoryEmbeddingStore, repositoryStore, repositoryIndexStore, {
    jobId,
    repositoryId: repository.id,
    indexJobId: indexJob.jobId,
    ownerId: repository.userId,
  });

  const response: EmbedRepositoryResponse = { jobId: job.jobId, repositoryId: repository.id, status: job.status };
  return reply.status(202).send(response);
});

app.get<{ Params: { id: string }; Querystring: { ownerId?: string } }>('/repositories/:id/embed-status', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  const job = await repositoryEmbeddingStore.getLatestForRepositoryAsync(repository.id);
  if (!job) {
    return reply.status(404).send({ error: 'No embedding job found for this repository' });
  }

  // Every value here is read straight from the persisted job record — the
  // actual configured/returned model and dimensions, never hard-coded.
  return {
    repositoryId: repository.id,
    jobId: job.jobId,
    status: job.status,
    commitSha: job.commitSha,
    model: job.model,
    dimensions: job.dimensions,
    totalChunks: job.totalChunks ?? 0,
    embeddedChunks: job.embeddedChunks ?? 0,
    skippedChunks: job.skippedChunks ?? 0,
    failedChunks: job.failedChunks ?? 0,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
});

app.post<{ Params: { id: string }; Body: { ownerId?: string } }>('/repositories/:id/embed/cancel', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }

  const latest = await repositoryEmbeddingStore.getLatestForRepositoryAsync(repository.id);
  if (!latest) {
    return reply.status(404).send({ error: 'No embedding job found for this repository' });
  }

  const updated = await cancelRepositoryEmbeddingJob(repositoryEmbeddingStore, repositoryStore, latest.jobId);
  if (!updated) {
    return reply.status(404).send({ error: 'Embedding job not found' });
  }
  return { jobId: updated.jobId, repositoryId: repository.id, status: updated.status };
});

/*
 * Repository Feature — Phase 5: semantic search over a repository's Phase 3
 * code chunks, using Phase 4's BGE-M3 embeddings + pgvector retrieval, then
 * bge-reranker-v2-m3 reranking. Deliberately isolated: this route never
 * calls Qwen models, never executes repository code, and never returns
 * vector arrays or full file contents — see repository-search-service.ts.
 */
app.post<{ Params: { id: string }; Body: { query?: unknown; limit?: unknown } }>('/repositories/:id/search', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdAsync(request.params.id);

  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on('close', onClose);

  try {
    const response = await searchRepository(
      repository,
      { embeddingStore: repositoryEmbeddingStore, indexStore: repositoryIndexStore, searchRepository: repositorySearchRepository },
      { repositoryId: request.params.id, ownerId: (await resolveOrganizationIds(request.user!.id))[0], query: request.body?.query, limit: request.body?.limit },
      undefined,
      controller.signal,
    );
    return response;
  } catch (error) {
    if (error instanceof SearchError) {
      return reply.status(searchErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    }
    throw error;
  } finally {
    reply.raw.off('close', onClose);
  }
});

/*
 * Repository Feature — Phase 9: grounded code Q&A. Reuses Phase 5/6's
 * searchRepository() unchanged for retrieval (embedding, pgvector,
 * reranking, degraded mode, sensitive-file filtering, ownership/readiness
 * validation all happen inside it) — this route only adds bounded context-
 * building and a dedicated, isolated LLM call on top. Read-only: never
 * modifies the repository, never executes repository code.
 */
app.post<{ Params: { id: string }; Body: { query?: unknown } }>(
  '/repositories/:id/ask',
  {
    preHandler: [
      authMiddleware.requireAuth,
      workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest),
      usageLimitMiddleware.requireQuota('AI_QUESTION', resolveOrganizationIdForAuthenticatedRequest),
    ],
  },
  async (request, reply) => {
  const repository = await repositoryStore.getByIdAsync(request.params.id);

  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on('close', onClose);

  try {
    const searchDeps = defaultSearchProviderDeps();
    const response = await answerRepositoryQuestion(
      repository,
      { embeddingStore: repositoryEmbeddingStore, indexStore: repositoryIndexStore, searchRepository: repositorySearchRepository },
      { repositoryId: request.params.id, ownerId: (await resolveOrganizationIds(request.user!.id))[0], query: request.body?.query },
      { embeddingProvider: searchDeps.embeddingProvider, rerankerProvider: searchDeps.rerankerProvider, qaProvider: repositoryQaProvider },
      controller.signal,
    );
    return response;
  } catch (error) {
    if (error instanceof AskError) {
      return reply.status(askErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    }
    throw error;
  } finally {
    reply.raw.off('close', onClose);
  }
});

/*
 * Repository Feature — Phase 10: AI issue analysis + code fix proposal for
 * an EXISTING, persisted website-scan finding (never a client-supplied
 * fake finding — always loaded from the scan store by findingId). Reuses
 * Phase 5/6/9's search/reranking/context pipeline unchanged for retrieval.
 * REVIEW-ONLY: this route never writes to the repository, never creates a
 * branch/commit/PR — see the Phase 10 report. Distinct from Phase 8's
 * /repositories/:id/issues/:issueId/propose-fix (which proposes a fix for
 * a user-reported REPOSITORY issue, not a website-scan finding).
 */
app.post<{ Params: { id: string; findingId: string }; Body: { instruction?: unknown } }>(
  '/repositories/:id/findings/:findingId/fix-proposal',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
    const repository = await repositoryStore.getByIdAsync(request.params.id);
    const found = await store.getIssueAsync(request.params.findingId);

    // A finding has no inherent repository (see IssueDetailPage.tsx's Phase
    // 10 comment) — the FIRST successful generation for a finding is what
    // establishes its repository (persisted below); any later attempt that
    // targets a DIFFERENT repository for the same finding is rejected rather
    // than silently redirected (see repository-finding-resolution-service.ts).
    if (found?.issue) {
      try {
        assertFindingRepositoryMatches(found.issue, request.params.id);
      } catch (error) {
        if (error instanceof FindingRepositoryMismatchError) {
          return reply.status(findingFixErrorStatusCode('REPOSITORY_MISMATCH')).send({ error: error.message, errorCode: 'REPOSITORY_MISMATCH' });
        }
        throw error;
      }
    }

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      const searchDeps = defaultSearchProviderDeps();
      const response = await proposeFindingFixForScanIssue(
        repository,
        found?.issue,
        { embeddingStore: repositoryEmbeddingStore, indexStore: repositoryIndexStore, searchRepository: repositorySearchRepository },
        { repositoryId: request.params.id, ownerId: (await resolveOrganizationIds(request.user!.id))[0], instruction: request.body?.instruction },
        { embeddingProvider: searchDeps.embeddingProvider, rerankerProvider: searchDeps.rerankerProvider, fixProvider: findingFixProvider },
        controller.signal,
      );
      if (found?.issue && !found.issue.repositoryId) {
        await store.setIssueRepositoryAsync(request.params.findingId, request.params.id);
      }
      return response;
    } catch (error) {
      if (error instanceof FindingFixError) {
        return reply.status(findingFixErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
      }
      throw error;
    } finally {
      reply.raw.off('close', onClose);
    }
  },
);

/*
 * Repository Feature — Phase 11: safely APPLY an already-produced Phase 10
 * finding-fix proposal to an ISOLATED copy of the repository. Never trusts
 * the AI's reported line numbers to locate a change — oldText, matched
 * against the real current file content, is authoritative. Never touches
 * the original repository clone, never commits/pushes/opens a PR — status
 * is always READY_FOR_REVIEW. The proposal is NOT persisted anywhere (Phase
 * 10 is stateless), so the client resubmits the exact proposal it received;
 * the finding itself is still always loaded server-side by findingId, never
 * trusted from the request body.
 */
app.post<{ Params: { id: string; findingId: string }; Body: { proposal?: unknown } }>(
  '/repositories/:id/findings/:findingId/fix-proposal/apply',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canMutateRepository, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
    const repository = await repositoryStore.getByIdAsync(request.params.id);
    const found = await store.getIssueAsync(request.params.findingId);

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      const result = await applyFindingFix(
        repository,
        found?.issue,
        request.body?.proposal as RepositoryFixProposalResponse | undefined,
        { indexStore: repositoryIndexStore },
        { repositoryId: request.params.id, ownerId: (await resolveOrganizationIds(request.user!.id))[0] },
        controller.signal,
      );
      // Narrowed to the public RepositoryFixApplyResponse contract —
      // applicationId/workspaceDir are internal (Phase 12 review route
      // reads them directly) and must never appear on the wire here: this
      // stateless endpoint always discarded its workspace already (retain
      // defaults to false), and workspaceDir is a server filesystem path
      // that must never be exposed to a client.
      const { status, repositoryId, findingId, baseCommitSha, changedFiles, diff, validation, lineGrounding } = result;
      return { status, repositoryId, findingId, baseCommitSha, changedFiles, diff, validation, lineGrounding };
    } catch (error) {
      if (error instanceof FixApplicationError) {
        return reply.status(fixApplicationErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
      }
      throw error;
    } finally {
      reply.raw.off('close', onClose);
    }
  },
);

/*
 * Repository Feature — Phase 12, step 1: REVIEW. Reuses Phase 11's
 * applyFindingFix() UNCHANGED (only requesting that the isolated workspace
 * be RETAINED instead of discarded) and persists a reviewable
 * repository_fix_workflows row. Still never creates a branch/commit/PR —
 * that only ever happens via the explicit /fix-proposal/approve call below.
 * Distinct from Phase 11's /fix-proposal/apply: that endpoint remains
 * stateless and always discards its workspace, unaffected by this route.
 */
app.post<{ Params: { id: string; findingId: string }; Body: { proposal?: unknown } }>(
  '/repositories/:id/findings/:findingId/fix-proposal/review',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
    const repository = await repositoryStore.getByIdAsync(request.params.id);
    const found = await store.getIssueAsync(request.params.findingId);

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      return await reviewFindingFix(
        repository,
        found?.issue,
        request.body?.proposal as RepositoryFixProposalResponse | undefined,
        { indexStore: repositoryIndexStore, workflowStore: repositoryFixWorkflowStore },
        { repositoryId: request.params.id, ownerId: (await resolveOrganizationIds(request.user!.id))[0] },
        controller.signal,
      );
    } catch (error) {
      if (error instanceof FixWorkflowError) {
        return reply.status(fixWorkflowErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
      }
      throw error;
    } finally {
      reply.raw.off('close', onClose);
    }
  },
);

/*
 * Repository Feature — Phase 12, step 2: APPROVE. The ONLY route in this
 * entire codebase that ever creates a Git branch, commits, pushes, or opens
 * a Pull Request — and only when called explicitly, with the applicationId
 * from a prior /fix-proposal/review call. Re-validates ownership,
 * readiness, the application's identity, and that the resubmitted proposal
 * is exactly the one that was reviewed (by content hash) before touching
 * anything. Idempotent: calling this twice for the same applicationId
 * returns the same PR rather than creating a second one (see
 * repository-fix-workflow-service.ts's claimForApprovalAsync).
 */
app.post<{ Params: { id: string; findingId: string }; Body: { applicationId?: string; proposal?: unknown } }>(
  '/repositories/:id/findings/:findingId/fix-proposal/approve',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canMutateRepository, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
    const repository = await repositoryStore.getByIdAsync(request.params.id);
    const found = await store.getIssueAsync(request.params.findingId);

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      const result = await approveFindingFix(
        repository,
        found?.issue,
        request.body?.applicationId,
        request.body?.proposal as RepositoryFixProposalResponse | undefined,
        { indexStore: repositoryIndexStore, workflowStore: repositoryFixWorkflowStore },
        { resolveProvider: resolveRepositoryProvider },
        {
          repositoryId: request.params.id,
          ownerId: (await resolveOrganizationIds(request.user!.id))[0],
          // Provider credential resolution (GitHub App installation / GitLab / Bitbucket
          // tokens) is keyed on the real user, never the organization — see
          // repository-fix-workflow-service.ts's FixWorkflowParams.callerUserId.
          callerUserId: request.user!.id,
        },
        controller.signal,
      );

      if (result.status === 'PR_OPENED' && result.prUrl && result.prNumber !== undefined) {
        const caller = await userRepository.getById(request.user!.id);
        if (caller?.email && repository) {
          const repoName = (() => {
            try {
              return new URL(repository.repoUrl).pathname.replace(/^\//, '');
            } catch {
              return repository.repoUrl;
            }
          })();
          try {
            await sendPullRequestCreatedEmail(caller.email, {
              repoName,
              findingTitle: found?.issue?.title ?? 'a code issue',
              prNumber: result.prNumber,
              prUrl: result.prUrl,
              branchName: result.branchName,
            });
          } catch (error) {
            console.error('[index] Failed to send pull-request-created email:', error instanceof Error ? error.message : error);
          }
        }
      }

      return result;
    } catch (error) {
      if (error instanceof FixWorkflowError) {
        return reply.status(fixWorkflowErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
      }
      throw error;
    } finally {
      reply.raw.off('close', onClose);
    }
  },
);

/*
 * Repository Feature — Phase 8: repository issue detection + AI fix
 * proposal + reviewable diff. Approval NEVER modifies the real repository,
 * never creates a branch/commit/PR — see the Phase 8 report. Every route
 * below follows the exact same "generic 404 for not-found-or-not-owned"
 * convention as every prior phase's repository routes.
 */
app.post<{ Params: { id: string }; Body: CreateRepositoryIssueRequest }>('/repositories/:id/issues', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdAsync(request.params.id);
  try {
    const issue = await createRepositoryIssue(
      repository,
      { indexStore: repositoryIndexStore, issueStore: repositoryIssueStore },
      {
        repositoryId: request.params.id,
        ownerId: (await resolveOrganizationIds(request.user!.id))[0],
        title: request.body?.title,
        description: request.body?.description,
        severity: request.body?.severity,
        filePath: request.body?.filePath,
        symbol: request.body?.symbol,
        lineStart: request.body?.lineStart,
        lineEnd: request.body?.lineEnd,
      },
    );
    return reply.status(201).send(issue);
  } catch (error) {
    if (error instanceof IssueError) return reply.status(issueErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.get<{ Params: { id: string } }>('/repositories/:id/issues', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdAsync(request.params.id);
  try {
    const issues = await listRepositoryIssues(repository, { issueStore: repositoryIssueStore }, (await resolveOrganizationIds(request.user!.id))[0]);
    return { repositoryId: request.params.id, issues };
  } catch (error) {
    if (error instanceof IssueError) return reply.status(issueErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.get<{ Params: { id: string; issueId: string } }>('/repositories/:id/issues/:issueId', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdAsync(request.params.id);
  try {
    const issue = await getRepositoryIssue(repository, { issueStore: repositoryIssueStore }, request.params.issueId, (await resolveOrganizationIds(request.user!.id))[0]);
    return issue;
  } catch (error) {
    if (error instanceof IssueError) return reply.status(issueErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.post<{ Params: { id: string; issueId: string } }>(
  '/repositories/:id/issues/:issueId/analyze',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }
  const issue = await repositoryIssueStore.getByIdAsync(request.params.issueId);
  if (!issue || issue.repositoryId !== repository.id) {
    return reply.status(404).send({ error: 'Issue not found', errorCode: 'ISSUE_NOT_FOUND' });
  }
  if (await repositoryIssueAnalysisStore.hasActiveAnalysisAsync(issue.id)) {
    return reply.status(409).send({ error: 'An analysis for this issue is already in progress.', errorCode: 'ANALYSIS_IN_PROGRESS' });
  }
  const indexJob = await repositoryIndexStore.getLatestForRepositoryAsync(repository.id);
  if (!indexJob || indexJob.status !== 'COMPLETED') {
    return reply.status(400).send({ error: 'No successful repository index is available.', errorCode: 'REPOSITORY_NOT_READY' });
  }

  const analysisId = randomUUID();
  await repositoryIssueAnalysisStore.create({ id: analysisId, issueId: issue.id, repositoryId: repository.id, commitSha: issue.commitSha });
  enqueueRepositoryIssueAnalysisJob(repositoryIssueStore, repositoryIssueAnalysisStore, repositoryIndexStore, issueAnalysisDeps, {
    analysisId, issueId: issue.id, repositoryId: repository.id, indexJobId: indexJob.jobId,
  });
  return reply.status(202).send({ analysisId, issueId: issue.id, status: 'QUEUED' });
});

app.get<{ Params: { id: string; issueId: string } }>('/repositories/:id/issues/:issueId/analysis', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }
  const issue = await repositoryIssueStore.getByIdAsync(request.params.issueId);
  if (!issue || issue.repositoryId !== repository.id) {
    return reply.status(404).send({ error: 'Issue not found', errorCode: 'ISSUE_NOT_FOUND' });
  }
  const analysis = await repositoryIssueAnalysisStore.getLatestForIssueAsync(issue.id);
  if (!analysis) {
    return reply.status(404).send({ error: 'No analysis found for this issue.', errorCode: 'ANALYSIS_NOT_FOUND' });
  }
  return analysis;
});

app.post<{ Params: { id: string; issueId: string } }>(
  '/repositories/:id/issues/:issueId/propose-fix',
  { preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest)] },
  async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }
  const issue = await repositoryIssueStore.getByIdAsync(request.params.issueId);
  if (!issue || issue.repositoryId !== repository.id) {
    return reply.status(404).send({ error: 'Issue not found', errorCode: 'ISSUE_NOT_FOUND' });
  }
  const analysis = await repositoryIssueAnalysisStore.getLatestForIssueAsync(issue.id);
  if (!analysis || analysis.status !== 'COMPLETED') {
    return reply.status(400).send({ error: 'Issue must be analyzed successfully before a fix can be proposed.', errorCode: 'ANALYSIS_NOT_FOUND' });
  }
  if (await repositoryFixProposalStore.hasActiveProposalAsync(issue.id)) {
    return reply.status(409).send({ error: 'A fix proposal for this issue is already in progress or awaiting review.', errorCode: 'PROPOSAL_IN_PROGRESS' });
  }

  const proposalId = randomUUID();
  await repositoryFixProposalStore.create({ id: proposalId, issueId: issue.id, repositoryId: repository.id, commitSha: issue.commitSha });
  enqueueRepositoryFixProposalJob(repositoryIssueStore, repositoryIssueAnalysisStore, repositoryFixProposalStore, repositoryIndexStore, fixProposalDeps, {
    proposalId, issueId: issue.id, repositoryId: repository.id,
  });
  return reply.status(202).send({ proposalId, issueId: issue.id, status: 'QUEUED' });
});

app.get<{ Params: { id: string; issueId: string } }>('/repositories/:id/issues/:issueId/fix-proposals', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }
  const issue = await repositoryIssueStore.getByIdAsync(request.params.issueId);
  if (!issue || issue.repositoryId !== repository.id) {
    return reply.status(404).send({ error: 'Issue not found', errorCode: 'ISSUE_NOT_FOUND' });
  }
  const proposals = await repositoryFixProposalStore.listForIssueAsync(issue.id);
  return { issueId: issue.id, proposals };
});

app.get<{ Params: { id: string; issueId: string; proposalId: string } }>(
  '/repositories/:id/issues/:issueId/fix-proposals/:proposalId',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
    if (!repository) {
      return reply.status(404).send({ error: 'Repository not found' });
    }
    const issue = await repositoryIssueStore.getByIdAsync(request.params.issueId);
    if (!issue || issue.repositoryId !== repository.id) {
      return reply.status(404).send({ error: 'Issue not found', errorCode: 'ISSUE_NOT_FOUND' });
    }
    const proposal = await repositoryFixProposalStore.getByIdAsync(request.params.proposalId);
    if (!proposal || proposal.issueId !== issue.id) {
      return reply.status(404).send({ error: 'Fix proposal not found', errorCode: 'PROPOSAL_NOT_FOUND' });
    }
    return proposal;
  },
);

/**
 * Approval is REVIEW-ONLY: it only flips proposal.status -> APPROVED and
 * issue.status -> APPROVED. No file modification, no git checkout/branch/
 * commit/push, no PR creation — see the Phase 8 report. That belongs to a
 * later phase.
 */
app.post<{ Params: { id: string; issueId: string; proposalId: string } }>(
  '/repositories/:id/issues/:issueId/fix-proposals/:proposalId/approve',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
    if (!repository) {
      return reply.status(404).send({ error: 'Repository not found' });
    }
    const issue = await repositoryIssueStore.getByIdAsync(request.params.issueId);
    if (!issue || issue.repositoryId !== repository.id) {
      return reply.status(404).send({ error: 'Issue not found', errorCode: 'ISSUE_NOT_FOUND' });
    }
    const proposal = await repositoryFixProposalStore.getByIdAsync(request.params.proposalId);
    if (!proposal || proposal.issueId !== issue.id) {
      return reply.status(404).send({ error: 'Fix proposal not found', errorCode: 'PROPOSAL_NOT_FOUND' });
    }
    if (proposal.status !== 'FIX_PROPOSED') {
      return reply.status(409).send({ error: 'This proposal is not awaiting review.', errorCode: 'PROPOSAL_ALREADY_DECIDED' });
    }

    const updated = await repositoryFixProposalStore.setDecisionAsync(proposal.id, 'APPROVED');
    await repositoryIssueStore.updateStatus(issue.id, 'APPROVED');
    return updated;
  },
);

app.post<{ Params: { id: string; issueId: string; proposalId: string } }>(
  '/repositories/:id/issues/:issueId/fix-proposals/:proposalId/reject',
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const repository = await repositoryStore.getByIdForOrganizationsAsync(request.params.id, await resolveOrganizationIds(request.user!.id));
    if (!repository) {
      return reply.status(404).send({ error: 'Repository not found' });
    }
    const issue = await repositoryIssueStore.getByIdAsync(request.params.issueId);
    if (!issue || issue.repositoryId !== repository.id) {
      return reply.status(404).send({ error: 'Issue not found', errorCode: 'ISSUE_NOT_FOUND' });
    }
    const proposal = await repositoryFixProposalStore.getByIdAsync(request.params.proposalId);
    if (!proposal || proposal.issueId !== issue.id) {
      return reply.status(404).send({ error: 'Fix proposal not found', errorCode: 'PROPOSAL_NOT_FOUND' });
    }
    if (proposal.status !== 'FIX_PROPOSED') {
      return reply.status(409).send({ error: 'This proposal is not awaiting review.', errorCode: 'PROPOSAL_ALREADY_DECIDED' });
    }

    const updated = await repositoryFixProposalStore.setDecisionAsync(proposal.id, 'REJECTED');
    await repositoryIssueStore.updateStatus(issue.id, 'REJECTED');
    return updated;
  },
);

/*
 * Email template preview — dev-only, never registered in production. Renders
 * every template in email/templates/ against fixture data (never a real DB
 * row), so the branded HTML/text can be eyeballed without configuring SMTP
 * or triggering a real event. The only other `text/html` response in this
 * codebase; the only other env-gated-route precedent is
 * workspace-invitation-service.ts's console-log-only dev fallback.
 */
if (process.env.NODE_ENV !== 'production') {
  app.get('/dev/emails', async (_request, reply) => {
    const links = Object.keys(DEV_EMAIL_PREVIEWS)
      .map((name) => `<li><a href="/dev/emails/${name}">${name}</a></li>`)
      .join('');
    return reply.type('text/html').send(`<!DOCTYPE html><html><body><h1>Origami Lens — Email previews (dev only)</h1><ul>${links}</ul></body></html>`);
  });

  app.get<{ Params: { templateName: string } }>('/dev/emails/:templateName', async (request, reply) => {
    const render = DEV_EMAIL_PREVIEWS[request.params.templateName];
    if (!render) {
      return reply.status(404).send({ error: `Unknown email template: ${request.params.templateName}` });
    }
    const { html } = render();
    return reply.type('text/html').send(html);
  });
}

async function start() {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Origami API listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
