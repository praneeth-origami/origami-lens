import { createHash, randomUUID } from 'node:crypto';
import type {
  Issue,
  Repository,
  RepositoryFixApproveResponse,
  RepositoryFixPrProvider,
  RepositoryFixProposalResponse,
  RepositoryFixReviewResponse,
  RepositoryFixWorkflowErrorCode,
} from '@origami/contracts';
import { applyFindingFix, FixApplicationError, type FixApplicationStores } from './repository-fix-application-service.js';
import { REPOSITORY_FIX_WORKSPACE_ROOT, REPOSITORY_FIX_WORKSPACE_TTL_MS, discardFixWorkspace, resolveFixWorkspaceDir } from './repository-fix-worktree.js';
import { isPathInside } from './repository-clone-service.js';
import { buildFixBranchName, isValidBranchName } from './repository-fix-branch.js';
import { canAccessRepository, parseRepositoryUrl } from './repository-service.js';
import { isSensitiveFile } from './repository-file-safety.js';
import {
  GitWorkflowError,
  branchExistsOnRemote,
  commitStaged,
  createBranch,
  getHeadCommitSha,
  getRemoteDefaultBranch,
  getStatusShort,
  pushBranch,
  stageFiles,
} from './repository-git.js';
import type { RepositoryProviderClient } from './repository-provider-client.js';
import { RepositoryProviderError } from './repository-provider-client.js';
import type { UnifiedRepositoryFixWorkflowStore } from './unified-repository-fix-workflow-store.js';
import type { RepositoryFixWorkflowRecord } from './db/repository-fix-workflow-repository.js';

export class FixWorkflowError extends Error {
  constructor(message: string, public readonly code: RepositoryFixWorkflowErrorCode) {
    super(message);
    this.name = 'FixWorkflowError';
  }
}

export interface FixWorkflowStores extends FixApplicationStores {
  workflowStore: Pick<UnifiedRepositoryFixWorkflowStore, 'create' | 'getByIdAsync' | 'claimForApprovalAsync' | 'updateProgressAsync'>;
}

export interface FixWorkflowProviderDeps {
  /**
   * Resolves a repository's `provider` value to a concrete
   * RepositoryProviderClient — normally repository-provider-resolver.ts's
   * resolveRepositoryProvider, injected here (rather than imported
   * directly) purely for testability, matching this project's existing
   * dependency-injection convention (e.g. Phase 8's `searchForEvidence`).
   * Throws RepositoryProviderError('...', 'PROVIDER_UNSUPPORTED') for a
   * provider with no available implementation.
   */
  resolveProvider(provider: string): RepositoryProviderClient;
}

export interface FixWorkflowParams {
  repositoryId: string;
  /** The caller's organization id — used only for the repository-access check (`canAccessRepository`), never for provider credential lookups (those are per-user, see `callerUserId`). */
  ownerId?: string;
  /**
   * The authenticated caller's real user id (`request.user.id`) — required for
   * provider credential resolution (`getPushCredentials`/`validateRemoteAccess`/
   * `getRepositoryInfo`/`createPullRequest` all key on a real user id, e.g.
   * `provider_connections.user_id`, never an organization id). Falls back to
   * `ownerId` when omitted so existing callers/tests that only ever supplied a
   * single id (and never exercised the real per-user provider-connection
   * lookup) keep behaving exactly as before.
   */
  callerUserId?: string;
}

function envString(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : undefined;
}

/** Read fresh on every call (never cached at module load) — same convention as pool.ts's DATABASE_URL, so tests can toggle these via process.env. Author identity used ONLY for the generated commit, never written to any persistent/global git config (see commitStaged). */
function getGitCommitIdentity(): { name: string; email: string } | undefined {
  const name = envString('GIT_COMMIT_NAME');
  const email = envString('GIT_COMMIT_EMAIL');
  if (!name || !email) return undefined;
  return { name, email };
}

const NOT_YET_INDEXED_STATUSES = new Set(['CONNECTED', 'DISCONNECTED', 'CLONING', 'READY_FOR_INDEXING', 'INDEXING', 'FAILED']);

/** Deterministic, key-order-independent JSON serialization — used only to compute proposalHash, never persisted or displayed. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The content identity of a reviewed proposal — /approve must re-supply a proposal hashing to the SAME value, or it is rejected as PROPOSAL_INVALID (the change set was swapped between review and approval). */
export function hashProposal(proposal: RepositoryFixProposalResponse): string {
  return createHash('sha256').update(canonicalJson(proposal), 'utf8').digest('hex');
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FixWorkflowError('The request was cancelled.', 'CANCELLED');
}

function validateRepositoryForWorkflow(repository: Repository | undefined, ownerId: string | undefined): asserts repository is Repository {
  if (!repository) throw new FixWorkflowError('Repository not found.', 'REPOSITORY_NOT_FOUND');
  if (!canAccessRepository(repository.organizationId, ownerId)) throw new FixWorkflowError('Repository not found.', 'REPOSITORY_ACCESS_DENIED');
  if (NOT_YET_INDEXED_STATUSES.has(repository.status)) throw new FixWorkflowError('Repository must be indexed before a fix can be reviewed.', 'REPOSITORY_NOT_READY');
}

/**
 * Step 1 of the Phase 12 flow: reuses Phase 11's applyFindingFix() UNCHANGED
 * (only passing `retain: true` — an additive option Phase 11 always
 * defaulted to false for every existing caller) to produce the exact same
 * validated, syntax-checked, diffed result as Phase 11's stateless
 * endpoint, but keeps the isolated workspace alive and persists a
 * reviewable repository_fix_workflows row referencing it. Nothing here
 * creates a branch, commits, pushes, or opens a PR — that only ever
 * happens in approveFindingFix, after explicit user approval.
 */
export async function reviewFindingFix(
  repository: Repository | undefined,
  finding: Issue | undefined,
  proposal: RepositoryFixProposalResponse | undefined,
  stores: FixWorkflowStores,
  params: FixWorkflowParams,
  signal?: AbortSignal,
): Promise<RepositoryFixReviewResponse> {
  validateRepositoryForWorkflow(repository, params.ownerId);
  if (!finding) throw new FixWorkflowError('Finding not found.', 'FINDING_NOT_FOUND');

  const applicationId = randomUUID();
  let applied;
  try {
    applied = await applyFindingFix(
      repository,
      finding,
      proposal,
      stores,
      { repositoryId: params.repositoryId, ownerId: params.ownerId },
      signal,
      { retain: true, applicationId },
    );
  } catch (error) {
    if (error instanceof FixApplicationError) throw new FixWorkflowError(error.message, error.code);
    throw error;
  }

  const expiresAt = new Date(Date.now() + REPOSITORY_FIX_WORKSPACE_TTL_MS).toISOString();
  await stores.workflowStore.create({
    id: applicationId,
    repositoryId: repository.id,
    findingId: finding.id,
    ownerId: params.ownerId,
    commitSha: applied.baseCommitSha,
    proposalHash: hashProposal(proposal as RepositoryFixProposalResponse),
    changedFiles: applied.changedFiles,
    diff: applied.diff,
    lineGrounding: applied.lineGrounding,
    syntaxStatus: applied.validation.syntax,
    workspaceDir: applied.workspaceDir,
    expiresAt,
  });

  return {
    applicationId,
    status: applied.status,
    repositoryId: applied.repositoryId,
    findingId: applied.findingId,
    commitSha: applied.baseCommitSha,
    changedFiles: applied.changedFiles,
    diff: applied.diff,
    lineGrounding: applied.lineGrounding,
    syntaxStatus: applied.validation.syntax,
    readyForApproval: true,
    expiresAt,
  };
}

function buildCommitMessage(finding: Issue): string {
  const cleanTitle = finding.title.replace(/[\r\n]+/g, ' ').trim();
  const subject = `fix: ${cleanTitle}`.slice(0, 72);
  return `${subject}\n\nAI-Finding: ${finding.id}`;
}

function buildPrTitle(finding: Issue): string {
  return `Fix: ${finding.title.replace(/[\r\n]+/g, ' ').trim()}`.slice(0, 120);
}

function buildPrBody(finding: Issue, workflow: RepositoryFixWorkflowRecord): string {
  const changeLines = workflow.changedFiles.map((f) => `- ${f.filePath} (+${f.additions}/-${f.deletions})`).join('\n');
  return [
    '## AI-assisted fix',
    '',
    'This pull request was generated from repository finding:',
    '',
    `Finding: ${finding.id}`,
    '',
    '### Summary',
    '',
    finding.title,
    '',
    '### Changes',
    '',
    changeLines,
    '',
    '### Validation',
    '',
    '- Phase 11 exact-text validation: passed',
    `- Syntax validation: ${workflow.syntaxStatus}`,
    '- Generated git diff: verified',
    '- Original repository clone: unchanged',
    '',
    '### Review',
    '',
    'This PR was created only after explicit user approval.',
  ].join('\n');
}

function toApproveResponse(workflow: RepositoryFixWorkflowRecord, fallbackProvider: RepositoryFixPrProvider): RepositoryFixApproveResponse {
  return {
    applicationId: workflow.id,
    repositoryId: workflow.repositoryId,
    findingId: workflow.findingId,
    status: workflow.status,
    branchName: workflow.branchName ?? '',
    commitSha: workflow.newCommitSha ?? '',
    baseCommitSha: workflow.commitSha,
    provider: workflow.provider ?? fallbackProvider,
    prNumber: workflow.prNumber,
    prUrl: workflow.prUrl,
  };
}

const MAX_BRANCH_COLLISION_ATTEMPTS = 10;

/**
 * Step 2 of the Phase 12 flow — the ONLY function in this codebase that
 * ever creates a branch, commits, pushes, or opens a Pull Request, and it
 * NEVER runs without this call having been made explicitly (never
 * triggered by generating or applying a proposal on its own). Re-validates
 * ownership, readiness, the applicationId, the resubmitted proposal's
 * identity against what was actually reviewed, and the working tree's
 * actual contents before staging anything.
 */
export async function approveFindingFix(
  repository: Repository | undefined,
  finding: Issue | undefined,
  applicationId: string | undefined,
  proposal: RepositoryFixProposalResponse | undefined,
  stores: FixWorkflowStores,
  deps: FixWorkflowProviderDeps,
  params: FixWorkflowParams,
  signal?: AbortSignal,
): Promise<RepositoryFixApproveResponse> {
  validateRepositoryForWorkflow(repository, params.ownerId);
  if (!finding) throw new FixWorkflowError('Finding not found.', 'FINDING_NOT_FOUND');
  if (!applicationId || typeof applicationId !== 'string') throw new FixWorkflowError('applicationId is required.', 'WORKSPACE_NOT_FOUND');
  if (!proposal || typeof proposal !== 'object') throw new FixWorkflowError('A proposal is required.', 'PROPOSAL_INVALID');

  const existing = await stores.workflowStore.getByIdAsync(applicationId);
  if (!existing || existing.repositoryId !== repository.id || existing.findingId !== finding.id) {
    throw new FixWorkflowError('No reviewable fix application was found for this id.', 'WORKSPACE_NOT_FOUND');
  }

  if (existing.status === 'REVIEWABLE' && new Date(existing.expiresAt).getTime() < Date.now()) {
    await stores.workflowStore.updateProgressAsync(applicationId, { status: 'EXPIRED', errorCode: 'APPROVAL_EXPIRED', errorMessage: 'The review window expired before approval.' });
    discardFixWorkspace(existing.workspaceDir);
    throw new FixWorkflowError('The reviewed fix has expired — generate and review a new proposal.', 'APPROVAL_EXPIRED');
  }

  // Checked BEFORE the full-content hash so a commit-sha-only mismatch (the
  // repository was re-indexed at a new commit between review and approval)
  // is reported precisely, rather than folded into the generic
  // bait-and-switch PROPOSAL_INVALID case below.
  if (proposal.commitSha !== existing.commitSha) {
    throw new FixWorkflowError('The proposal commit does not match the reviewed application.', 'COMMIT_SHA_MISMATCH');
  }
  if (hashProposal(proposal) !== existing.proposalHash) {
    throw new FixWorkflowError('The submitted proposal does not match what was reviewed for this application.', 'PROPOSAL_INVALID');
  }

  assertNotAborted(signal);

  const claim = await stores.workflowStore.claimForApprovalAsync(applicationId);
  if (!claim.claimed) {
    const current = claim.workflow ?? existing;
    if (current.status === 'PR_OPENED') return toApproveResponse(current, repository.provider); // idempotent: already done, return the same PR/MR
    if (current.status === 'FAILED') {
      throw new FixWorkflowError(current.errorMessage ?? 'The previous approval attempt failed.', (current.errorCode as RepositoryFixWorkflowErrorCode) ?? 'FIX_WORKFLOW_FAILED');
    }
    if (current.status === 'EXPIRED') throw new FixWorkflowError('The reviewed fix has expired.', 'APPROVAL_EXPIRED');
    if (current.status === 'CANCELLED') throw new FixWorkflowError('This fix application was cancelled.', 'CANCELLED');
    // APPROVED / BRANCH_CREATED / COMMITTED / PUSHED: a concurrent request already claimed this and is (or was) executing.
    throw new FixWorkflowError('This fix is already being approved — a pull request is in progress.', 'WORKFLOW_IN_PROGRESS');
  }

  const workflow = claim.workflow!;

  const fail = async (code: RepositoryFixWorkflowErrorCode, message: string): Promise<never> => {
    await stores.workflowStore.updateProgressAsync(applicationId, { status: 'FAILED', errorCode: code, errorMessage: message });
    discardFixWorkspace(workflow.workspaceDir);
    throw new FixWorkflowError(message, code);
  };

  try {
    if (!isPathInside(REPOSITORY_FIX_WORKSPACE_ROOT, workflow.workspaceDir) || workflow.workspaceDir !== resolveFixWorkspaceDir(repository.id, applicationId)) {
      return await fail('WORKSPACE_NOT_FOUND', 'The retained fix workspace path is invalid.');
    }

    // Mutation order (see the Phase 13 report): repository -> PROVIDER ->
    // credentials -> remote access -> default branch -> workspace/file
    // revalidation -> branch -> commit -> push -> PR/MR. Provider
    // resolution and every credential check below happen BEFORE any branch
    // is created, so a misconfigured/unsupported provider is reported
    // before any git mutation — never discovered only once a branch/commit
    // already exists.
    let provider: RepositoryProviderClient;
    try {
      provider = deps.resolveProvider(repository.provider);
    } catch (error) {
      if (error instanceof RepositoryProviderError) return await fail('PROVIDER_UNSUPPORTED', error.message);
      return await fail('PROVIDER_UNSUPPORTED', `Pull request creation is not yet supported for provider "${repository.provider}".`);
    }

    const identity = getGitCommitIdentity();
    if (!identity) return await fail('GIT_COMMIT_IDENTITY_MISSING', 'GIT_COMMIT_NAME and GIT_COMMIT_EMAIL must both be configured before a commit can be created.');

    const parsedUrl = parseRepositoryUrl(repository.repoUrl);
    if (!parsedUrl.ok) return await fail('GIT_REMOTE_UNAVAILABLE', 'Could not resolve the repository owner/name from its URL.');
    const { owner, name } = parsedUrl.value;

    // Phase 16/C: credentials are resolved for THIS authenticated user and
    // THIS specific repository — never a global, shared credential.
    // `callerUserId` (the real request.user.id) is what provider-connection
    // lookups (e.g. provider_connections.user_id) are keyed on — `ownerId` is
    // the caller's ORGANIZATION id (used above only for the repository-access
    // check) and must never be passed here: an org id will never match a
    // per-user connection row. `callerUserId` falls back to `ownerId` only
    // for callers that never distinguished the two (see FixWorkflowParams).
    const credentialUserId = params.callerUserId ?? params.ownerId;
    let pushCredentials;
    try {
      // Safe: validateRepositoryForWorkflow above already proved params.ownerId is a real, defined string, and credentialUserId falls back to it — it cannot be undefined here.
      pushCredentials = await provider.getPushCredentials(credentialUserId!, owner, name, signal);
    } catch (error) {
      if (error instanceof RepositoryProviderError) return await fail('GIT_AUTH_NOT_CONFIGURED', error.message);
      return await fail('GIT_AUTH_NOT_CONFIGURED', `${provider.provider} authentication is not configured.`);
    }

    try {
      await provider.validateRemoteAccess(credentialUserId!, owner, name, signal);
    } catch (error) {
      if (error instanceof RepositoryProviderError && (error.category === 'AUTH_NOT_CONFIGURED' || error.category === 'AUTH_FAILED')) {
        return await fail('GIT_AUTH_NOT_CONFIGURED', error.message);
      }
      return await fail('GIT_REMOTE_UNAVAILABLE', error instanceof Error ? error.message : 'Failed to reach the repository provider.');
    }

    assertNotAborted(signal);

    // Re-verify the working tree contains exactly the approved changes
    // before staging anything — the spec's mandatory pre-commit check.
    let statusEntries;
    try {
      statusEntries = await getStatusShort(workflow.workspaceDir, signal);
    } catch (error) {
      return await fail('GIT_DIRTY_WORKTREE', `Failed to read the workspace status: ${error instanceof Error ? error.message : String(error)}`);
    }
    const approvedPaths = new Set(workflow.changedFiles.map((f) => f.filePath));
    const actualPaths = new Set(statusEntries.map((s) => s.filePath));
    const unexpected = statusEntries.filter((s) => !approvedPaths.has(s.filePath));
    const missing = workflow.changedFiles.filter((f) => !actualPaths.has(f.filePath));
    if (unexpected.length > 0 || missing.length > 0) {
      return await fail(
        'UNEXPECTED_CHANGES',
        `The workspace no longer contains exactly the approved changes (unexpected: ${unexpected.map((u) => u.filePath).join(', ') || 'none'}; missing: ${missing.map((m) => m.filePath).join(', ') || 'none'}).`,
      );
    }
    for (const filePath of approvedPaths) {
      if (isSensitiveFile(filePath)) return await fail('SENSITIVE_FILE', `Path "${filePath}" refers to a sensitive file and cannot be committed.`);
    }

    assertNotAborted(signal);

    let baseBranch: string | undefined = repository.branch;
    if (!baseBranch) {
      baseBranch = await getRemoteDefaultBranch(workflow.workspaceDir, signal, pushCredentials);
    }
    if (!baseBranch) {
      try {
        const info = await provider.getRepositoryInfo(credentialUserId!, owner, name, signal);
        baseBranch = info.defaultBranch;
      } catch {
        baseBranch = 'main';
      }
    }

    let branchName = buildFixBranchName(finding.id, finding.title);
    let attempt = 1;
    while (attempt <= MAX_BRANCH_COLLISION_ATTEMPTS) {
      const candidate = attempt === 1 ? branchName : buildFixBranchName(finding.id, finding.title, attempt);
      let existsRemotely: boolean;
      try {
        existsRemotely = await branchExistsOnRemote(workflow.workspaceDir, candidate, signal, pushCredentials);
      } catch (error) {
        return await fail('GIT_REMOTE_UNAVAILABLE', error instanceof Error ? error.message : 'Failed to check for a colliding branch on the remote.');
      }
      if (!existsRemotely) {
        branchName = candidate;
        break;
      }
      attempt += 1;
      if (attempt > MAX_BRANCH_COLLISION_ATTEMPTS) return await fail('GIT_BRANCH_EXISTS', `Could not find a non-colliding branch name after ${MAX_BRANCH_COLLISION_ATTEMPTS} attempts.`);
    }
    if (!isValidBranchName(branchName)) return await fail('GIT_BRANCH_INVALID', `Generated branch name "${branchName}" is not a valid Git ref.`);

    try {
      await createBranch(workflow.workspaceDir, branchName, signal);
    } catch (error) {
      if (error instanceof GitWorkflowError && error.cause === 'branch_exists') return await fail('GIT_BRANCH_EXISTS', error.message);
      return await fail('GIT_BRANCH_INVALID', error instanceof Error ? error.message : 'Failed to create the fix branch.');
    }
    await stores.workflowStore.updateProgressAsync(applicationId, { status: 'BRANCH_CREATED', branchName });

    assertNotAborted(signal);

    try {
      await stageFiles(workflow.workspaceDir, Array.from(approvedPaths), signal);
      await commitStaged(workflow.workspaceDir, buildCommitMessage(finding), identity.name, identity.email, signal);
    } catch (error) {
      return await fail('GIT_COMMIT_FAILED', error instanceof Error ? error.message : 'Failed to create the commit.');
    }
    const newCommitSha = await getHeadCommitSha(workflow.workspaceDir, signal);
    await stores.workflowStore.updateProgressAsync(applicationId, { status: 'COMMITTED', newCommitSha });

    assertNotAborted(signal);

    try {
      await pushBranch(workflow.workspaceDir, branchName, pushCredentials.token, signal, pushCredentials.username);
    } catch (error) {
      if (error instanceof GitWorkflowError && error.cause === 'auth_failed') return await fail('GIT_AUTH_NOT_CONFIGURED', error.message);
      return await fail('GIT_PUSH_FAILED', error instanceof Error ? error.message : 'Failed to push the fix branch.');
    }
    await stores.workflowStore.updateProgressAsync(applicationId, { status: 'PUSHED' });

    assertNotAborted(signal);

    const updatedWorkflow: RepositoryFixWorkflowRecord = { ...workflow, branchName, newCommitSha, status: 'PUSHED' };
    let pr;
    try {
      pr = await provider.createPullRequest(
        credentialUserId!,
        { owner, repo: name, title: buildPrTitle(finding), body: buildPrBody(finding, updatedWorkflow), head: branchName, base: baseBranch },
        signal,
      );
    } catch (error) {
      if (error instanceof RepositoryProviderError) {
        if (error.category === 'AUTH_NOT_CONFIGURED' || error.category === 'AUTH_FAILED') return await fail('GIT_AUTH_NOT_CONFIGURED', error.message);
        return await fail('PR_CREATION_FAILED', error.message);
      }
      return await fail('PR_CREATION_FAILED', error instanceof Error ? error.message : 'Failed to create the pull request.');
    }

    await stores.workflowStore.updateProgressAsync(applicationId, {
      status: 'PR_OPENED', provider: repository.provider, prNumber: pr.number, prUrl: pr.url,
    });

    discardFixWorkspace(workflow.workspaceDir);

    return {
      applicationId,
      repositoryId: repository.id,
      findingId: finding.id,
      status: 'PR_OPENED',
      branchName,
      commitSha: newCommitSha,
      baseCommitSha: workflow.commitSha,
      provider: repository.provider,
      prNumber: pr.number,
      prUrl: pr.url,
    };
  } catch (error) {
    if (error instanceof FixWorkflowError) throw error;
    return await fail('FIX_WORKFLOW_FAILED', error instanceof Error ? error.message : 'The fix approval workflow failed unexpectedly.');
  }
}

/**
 * Cleanup sweep for retained-but-never-approved workspaces: any REVIEWABLE
 * row past its expiresAt is transitioned to EXPIRED and its workspace
 * discarded. Never touches APPROVED/executing rows (those are either
 * mid-flight or already terminal). Safe to call repeatedly/concurrently —
 * each row is only ever discarded once (subsequent sweeps see it already
 * out of REVIEWABLE).
 */
export async function sweepExpiredFixWorkflows(workflowStore: Pick<UnifiedRepositoryFixWorkflowStore, 'listExpiredReviewableAsync' | 'updateProgressAsync'>): Promise<number> {
  const expired = await workflowStore.listExpiredReviewableAsync(new Date().toISOString());
  for (const workflow of expired) {
    await workflowStore.updateProgressAsync(workflow.id, { status: 'EXPIRED' });
    discardFixWorkspace(workflow.workspaceDir);
  }
  return expired.length;
}
