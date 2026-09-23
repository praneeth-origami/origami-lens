import './load-env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import type {
  AskRequest,
  AuthMeResponse,
  ListProviderConnectionsResponse,
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
} from '@origami/contracts';
import { CODE_TARGET_META, DEFAULT_WEBSITE_MAX_PAGES, MAX_WEBSITE_PAGES } from '@origami/contracts';
import { ScanPipeline } from './scan-pipeline.js';
import { countIssuesByCategory, filterIssues } from './scan-store.js';
import { checkDependencies } from './health.js';
import { createWebsiteScanRecord } from './website-scan-orchestrator.js';
import { enqueueWebsiteScan, startWebsiteScanWorker } from './workers/website-scan-worker.js';
import { canCancelJob, cancelComponentJob, enqueueComponentJob, startComponentGenerationWorker } from './workers/component-generation-worker.js';
import { ComponentGenerator } from './component-generator.js';
import { UnifiedComponentStore } from './unified-component-store.js';
import { DuplicateRepositoryError, UnifiedRepositoryStore } from './unified-repository-store.js';
import { parseRepositoryUrl, validateBranch } from './repository-service.js';
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
import { HttpFindingFixProvider } from './repository-finding-fix-provider.js';
import { FixApplicationError, applyFindingFix } from './repository-fix-application-service.js';
import { FixWorkflowError, approveFindingFix, reviewFindingFix, sweepExpiredFixWorkflows } from './repository-fix-workflow-service.js';
import { UnifiedRepositoryFixWorkflowStore } from './unified-repository-fix-workflow-store.js';
import { resolveRepositoryProvider } from './repository-provider-resolver.js';
import { isDatabaseEnabled } from './db/pool.js';
import { UserRepository } from './db/user-repository.js';
import { SessionRepository } from './db/session-repository.js';
import { ProviderConnectionRepository } from './db/provider-connection-repository.js';
import { buildGitHubAppInstallUrl, isGitHubAppConfigured } from './github-app-auth.js';
import { buildGitLabAuthorizeUrl, isGitLabOAuthConfigured, GitLabOAuthError } from './gitlab-oauth.js';
import { buildBitbucketAuthorizeUrl, isBitbucketOAuthConfigured, BitbucketOAuthError } from './bitbucket-oauth.js';
import { connectGitHubInstallation, connectGitLabAccount, connectBitbucketAccount } from './provider-connection-service.js';
import { createAuthMiddleware, SESSION_COOKIE_NAME, sessionCookieOptions } from './auth-middleware.js';
import { AuthError, loginWithGitHub, logout as logoutSession } from './auth-service.js';
import { GitHubOAuthError, buildGitHubAuthorizeUrl, completeGitHubOAuthLogin, isGitHubOAuthConfigured } from './auth-github-oauth.js';
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
const authMiddleware = createAuthMiddleware(sessionRepository);
// Phase 16/C — real, per-user Git provider authorization (migration 013). Same "Postgres or disabled, never a JSON fallback" rule as users/sessions above.
const providerConnectionRepository = new ProviderConnectionRepository();

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
  startRepositoryIndexWorker(repositoryIndexStore, repositoryStore, repositoryCloneStore);
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
}

const app = Fastify({ logger: true, bodyLimit: MAX_REQUEST_BODY_BYTES });

// credentials: true is required for the session cookie (Phase 16/A) to be
// sent/received on cross-origin requests (e.g. a production build where the
// frontend and API are on different origins) — origin:true still reflects
// the specific request Origin rather than '*', which is what makes a
// credentialed CORS response valid at all.
await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);

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
const WEB_APP_BASE_URL = (process.env.WEB_APP_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');

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
    const result = await loginWithGitHub(code, { userRepo: userRepository, sessionRepo: sessionRepository, completeGitHubOAuthLogin });
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

app.delete<{ Params: { id: string } }>('/providers/connections/:id', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const revoked = await providerConnectionRepository.revokeForUser(request.user!.id, request.params.id);
  if (!revoked) return reply.status(404).send({ error: 'Connection not found' });
  return { ok: true };
});

app.get('/health/dependencies', async () => checkDependencies());

app.post<{ Body: ScanRequest }>('/scan', async (request, reply) => {
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
    const result = await pipeline.runScan(request.body);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scan failed';
    request.log.error(error);
    return reply.status(500).send({ error: message });
  }
});

app.post<{ Body: CreateScanRequest }>('/scans', async (request, reply) => {
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
      const result = await pipeline.runScan(body);
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
      const scanId = await createWebsiteScanRecord(
        repo,
        body.url,
        { ...body.websiteOptions, maxPages, discoveryMethod: body.websiteOptions?.discoveryMethod ?? 'AUTOMATIC' },
        body.ownerId,
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

app.get('/scans', async () => ({
  scans: await store.listScansAsync(),
}));

app.get<{ Params: { scanId: string } }>('/scans/:scanId', async (request, reply) => {
  const scan = await store.getScanAsync(request.params.scanId);
  if (!scan) {
    return reply.status(404).send({ error: 'Scan not found' });
  }
  return {
    ...scan,
    issuesByCategory: countIssuesByCategory(scan.issues as import('@origami/contracts').Issue[]),
  };
});

app.get<{ Params: { scanId: string } }>('/scans/:scanId/status', async (request, reply) => {
  if (!repo.isEnabled()) {
    const scan = await store.getScanAsync(request.params.scanId);
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

  const status = await repo.getScanStatus(request.params.scanId);
  if (!status) {
    const scan = await store.getScanAsync(request.params.scanId);
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

app.get<{ Params: { scanId: string } }>('/scans/:scanId/pages', async (request, reply) => {
  if (!repo.isEnabled()) {
    return reply.status(404).send({ error: 'Page list not available for legacy scans' });
  }

  const pages = await repo.getPageScans(request.params.scanId);
  if (pages.length === 0) {
    const scan = await store.getScanAsync(request.params.scanId);
    if (!scan) return reply.status(404).send({ error: 'Scan not found' });
    if (scan.scanType !== 'WEBSITE') {
      return reply.status(404).send({ error: 'Not a website scan' });
    }
  }
  return { scanId: request.params.scanId, pages };
});

app.get<{ Params: { scanId: string; pageScanId: string } }>(
  '/scans/:scanId/pages/:pageScanId',
  async (request, reply) => {
    if (!repo.isEnabled()) {
      return reply.status(404).send({ error: 'Page detail not available' });
    }

    const detail = await repo.getPageScanDetail(request.params.scanId, request.params.pageScanId);
    if (!detail) {
      return reply.status(404).send({ error: 'Page scan not found' });
    }
    return { scanId: request.params.scanId, ...detail };
  },
);

app.get<{ Params: { scanId: string; key: string } }>(
  '/scans/:scanId/artifacts/:key',
  async (request, reply) => {
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
  async (request, reply) => {
    const scan = await store.getScanAsync(request.params.scanId);
    if (!scan) {
      return reply.status(404).send({ error: 'Scan not found' });
    }

    const issues = filterIssues(scan.issues as import('@origami/contracts').Issue[], request.query);
    return { scanId: scan.scanId, url: scan.url, issues, total: issues.length };
  },
);

app.get<{ Params: { issueId: string } }>('/issues/:issueId', async (request, reply) => {
  const found = await store.getIssueAsync(request.params.issueId);
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

app.patch<{ Params: { issueId: string }; Body: { status: IssueStatus } }>(
  '/issues/:issueId/status',
  async (request, reply) => {
    const { status } = request.body;
    const valid: IssueStatus[] = ['open', 'in_progress', 'resolved', 'ignored'];
    if (!status || !valid.includes(status)) {
      return reply.status(400).send({ error: 'Invalid status' });
    }

    const updated = store.updateIssueStatus(request.params.issueId, status);
    if (!updated) {
      return reply.status(404).send({ error: 'Issue not found' });
    }
    return { issue: updated };
  },
);

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

app.get('/component-targets', async () => ({ targets: CODE_TARGET_META }));

app.post<{ Body: CreateComponentJobRequest }>('/components', async (request, reply) => {
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

  const queued: ComponentGenerationJob = {
    jobId,
    ownerId,
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
    await componentRepo.createJob({ jobId, ownerId, sourceUrl: evidence.sourceUrl, pageTitle: evidence.pageTitle, target }).catch(() => {});
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
  });

  return reply.status(202).send({ jobId, status: 'QUEUED' });
});

app.post<{ Params: { jobId: string }; Body: { target?: CodeTarget } }>('/components/:jobId/retry', async (request, reply) => {
  const original = await componentStore.getJobAsync(request.params.jobId);
  const evidence = await componentStore.getEvidenceAsync(request.params.jobId);
  if (!original || !evidence) {
    return reply.status(404).send({ error: 'Original selection evidence is no longer available. Please make a new selection on the page.' });
  }

  const target = request.body?.target ?? original.target;
  const jobId = randomUUID();
  const now = new Date().toISOString();

  const queued: ComponentGenerationJob = {
    jobId,
    ownerId: original.ownerId,
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
    await componentRepo.createJob({ jobId, ownerId: original.ownerId, sourceUrl: original.sourceUrl, pageTitle: original.pageTitle, target }).catch(() => {});
  }
  await componentStore.saveEvidence(jobId, evidence);

  enqueueComponentJob(componentStore, componentGenerator, {
    jobId,
    sourceUrl: original.sourceUrl,
    pageTitle: original.pageTitle,
    target,
    evidence,
    ownerId: original.ownerId,
  });

  return reply.status(202).send({ jobId, status: 'QUEUED' });
});

app.post<{ Params: { jobId: string }; Body: { ownerId?: string } }>('/components/:jobId/cancel', async (request, reply) => {
  const existing = await componentStore.getJobAsync(request.params.jobId);
  if (!existing) {
    return reply.status(404).send({ error: 'Component generation job not found' });
  }

  const requestOwnerId = request.body?.ownerId;
  if (!canCancelJob(existing.ownerId, requestOwnerId)) {
    return reply.status(403).send({ error: 'You do not have permission to cancel this generation job.' });
  }

  const updated = await cancelComponentJob(componentStore, request.params.jobId);
  if (!updated) {
    return reply.status(404).send({ error: 'Component generation job not found' });
  }
  return { jobId: updated.jobId, status: updated.status };
});

app.get('/components', async (request) => {
  const ownerId = (request.query as { ownerId?: string })?.ownerId;
  return { jobs: await componentStore.listJobsAsync(ownerId) };
});

app.get<{ Params: { jobId: string } }>('/components/:jobId', async (request, reply) => {
  const job = await componentStore.getJobAsync(request.params.jobId);
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
app.post<{ Body: CreateRepositoryRequest }>('/repositories', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const { repoUrl, branch } = request.body ?? {};

  const parsedUrl = parseRepositoryUrl(repoUrl);
  if (!parsedUrl.ok) {
    return reply.status(400).send({ error: parsedUrl.error });
  }

  const parsedBranch = validateBranch(branch);
  if (!parsedBranch.ok) {
    return reply.status(400).send({ error: parsedBranch.error });
  }

  try {
    const repository = await repositoryStore.create({
      id: randomUUID(),
      userId: request.user!.id,
      repoUrl: parsedUrl.value.normalizedUrl,
      provider: parsedUrl.value.provider,
      branch: parsedBranch.value,
    });
    return reply.status(201).send(repository);
  } catch (error) {
    if (error instanceof DuplicateRepositoryError) {
      return reply.status(409).send({ error: error.message });
    }
    throw error;
  }
});

app.get('/repositories', { preHandler: authMiddleware.requireAuth }, async (request) => {
  return { repositories: await repositoryStore.listForUserAsync(request.user!.id) };
});

app.get<{ Params: { id: string } }>('/repositories/:id', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  // Filtered at the SQL layer (WHERE id = ? AND user_id = ?) — a repository
  // belonging to another user never leaves the database. Same "not found"
  // response whether the repository truly doesn't exist or simply doesn't
  // belong to this caller — never confirms existence to a non-owner.
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
  if (!repository) {
    return reply.status(404).send({ error: 'Repository not found' });
  }
  return repository;
});

/*
 * Repository Feature — Phase 2: clone a connected repository into isolated
 * storage, checkout the requested branch, and deterministically discover its
 * structure. No Tree-sitter/AST/indexing/embeddings/AI analysis, and the
 * worker never executes any code contained in the repository — see
 * workers/repository-clone-worker.ts.
 */
app.post<{ Params: { id: string }; Body: { ownerId?: string } }>('/repositories/:id/clone', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
    repoUrl: repository.repoUrl,
    branch: repository.branch,
  });

  const response: CloneRepositoryResponse = { jobId: job.jobId, repositoryId: repository.id, status: job.status };
  return reply.status(202).send(response);
});

app.get<{ Params: { id: string }; Querystring: { ownerId?: string } }>('/repositories/:id/clone-status', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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

app.post<{ Params: { id: string }; Body: { ownerId?: string } }>('/repositories/:id/index', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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

app.post<{ Params: { id: string }; Body: { ownerId?: string } }>('/repositories/:id/embed', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
      { repositoryId: request.params.id, ownerId: request.user!.id, query: request.body?.query, limit: request.body?.limit },
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
app.post<{ Params: { id: string }; Body: { query?: unknown } }>('/repositories/:id/ask', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
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
      { repositoryId: request.params.id, ownerId: request.user!.id, query: request.body?.query },
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
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const repository = await repositoryStore.getByIdAsync(request.params.id);
    const found = await store.getIssueAsync(request.params.findingId);

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      const searchDeps = defaultSearchProviderDeps();
      const response = await proposeFindingFixForScanIssue(
        repository,
        found?.issue,
        { embeddingStore: repositoryEmbeddingStore, indexStore: repositoryIndexStore, searchRepository: repositorySearchRepository },
        { repositoryId: request.params.id, ownerId: request.user!.id, instruction: request.body?.instruction },
        { embeddingProvider: searchDeps.embeddingProvider, rerankerProvider: searchDeps.rerankerProvider, fixProvider: findingFixProvider },
        controller.signal,
      );
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
  { preHandler: authMiddleware.requireAuth },
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
        { repositoryId: request.params.id, ownerId: request.user!.id },
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
  { preHandler: authMiddleware.requireAuth },
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
        { repositoryId: request.params.id, ownerId: request.user!.id },
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
  { preHandler: authMiddleware.requireAuth },
  async (request, reply) => {
    const repository = await repositoryStore.getByIdAsync(request.params.id);
    const found = await store.getIssueAsync(request.params.findingId);

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      return await approveFindingFix(
        repository,
        found?.issue,
        request.body?.applicationId,
        request.body?.proposal as RepositoryFixProposalResponse | undefined,
        { indexStore: repositoryIndexStore, workflowStore: repositoryFixWorkflowStore },
        { resolveProvider: resolveRepositoryProvider },
        { repositoryId: request.params.id, ownerId: request.user!.id },
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
        ownerId: request.user!.id,
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
    const issues = await listRepositoryIssues(repository, { issueStore: repositoryIssueStore }, request.user!.id);
    return { repositoryId: request.params.id, issues };
  } catch (error) {
    if (error instanceof IssueError) return reply.status(issueErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.get<{ Params: { id: string; issueId: string } }>('/repositories/:id/issues/:issueId', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdAsync(request.params.id);
  try {
    const issue = await getRepositoryIssue(repository, { issueStore: repositoryIssueStore }, request.params.issueId, request.user!.id);
    return issue;
  } catch (error) {
    if (error instanceof IssueError) return reply.status(issueErrorStatusCode(error.code)).send({ error: error.message, errorCode: error.code });
    throw error;
  }
});

app.post<{ Params: { id: string; issueId: string } }>('/repositories/:id/issues/:issueId/analyze', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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

app.post<{ Params: { id: string; issueId: string } }>('/repositories/:id/issues/:issueId/propose-fix', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
  const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
    const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
    const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
    const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
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
