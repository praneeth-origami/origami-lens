import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Issue,
  RepositoryFixApplyErrorCode,
  RepositoryFixApplyResponse,
  RepositoryFixChangedFile,
  RepositoryFixLineGrounding,
  RepositoryFixProposalResponse,
} from '@origami/contracts';
import { canAccessRepository } from './repository-service.js';
import { isRepositoryPathSafe, normalizeRepositoryPath } from './repository-path-safety.js';
import { isSensitiveFile } from './repository-file-safety.js';
import { REPOSITORY_CLONE_ROOT, isPathInside, resolveCloneDir } from './repository-clone-service.js';
import { getWorkingTreeDiff } from './repository-git.js';
import { createFixWorkspace, discardFixWorkspace, FixWorkspaceCreationError, StaleRepositoryError } from './repository-fix-worktree.js';
import { applyHunkToContent, validateSyntax } from './repository-fix-validation.js';
import type { UnifiedRepositoryIndexStore } from './unified-repository-index-store.js';
import type { InsertIndexFileInput } from './db/repository-index-repository.js';

/** Repository statuses that mean "never successfully indexed yet" — same taxonomy as repository-search-service.ts's NOT_YET_INDEXED_STATUSES; not exported from there today, so kept as a small local copy (same accepted-duplication convention as this project's other tiny per-file constant sets). */
const NOT_YET_INDEXED_STATUSES = new Set(['CONNECTED', 'DISCONNECTED', 'CLONING', 'READY_FOR_INDEXING', 'INDEXING', 'FAILED']);

export class FixApplicationError extends Error {
  constructor(message: string, public readonly code: RepositoryFixApplyErrorCode) {
    super(message);
    this.name = 'FixApplicationError';
  }
}

export interface FixApplicationStores {
  indexStore: Pick<UnifiedRepositoryIndexStore, 'getLatestForCommitAsync' | 'getFilesForJobAsync'>;
}

export interface FixApplicationParams {
  repositoryId: string;
  ownerId?: string;
}

export interface FixApplicationOptions {
  /**
   * When true, the isolated workspace is PRESERVED after a successful apply
   * instead of being discarded — the caller becomes responsible for its
   * lifecycle (see repository-fix-workflow-service.ts's review/approve
   * flow, Phase 12). Defaults to false, which preserves this function's
   * original Phase 11 behavior exactly: every existing caller that omits
   * `options` still always discards the workspace before returning,
   * success or failure, unchanged.
   */
  retain?: boolean;
  /** Caller-supplied applicationId — MUST already be a trusted UUID (validated the same way as every other id resolveFixWorkspaceDir accepts). When omitted, one is generated internally exactly as Phase 11 always did. */
  applicationId?: string;
}

/** What applyFindingFix() actually produces internally — a superset of the public RepositoryFixApplyResponse contract. Phase 11's route narrows this down to the public shape (unchanged); Phase 12's review route reads the extra fields directly. */
export interface FixApplicationResult extends RepositoryFixApplyResponse {
  applicationId: string;
  workspaceDir: string;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FixApplicationError('The fix-application request was cancelled.', 'CANCELLED');
  }
}

/**
 * Static validation of the resubmitted proposal envelope itself — never
 * trusts the client's copy of a Phase 10 proposal, since Phase 10 does not
 * persist proposals and the client is the only place this object survives
 * between the two requests. Checked BEFORE any isolated workspace is
 * created, so an invalid resubmission never costs a filesystem copy.
 */
function validateProposalEnvelope(
  proposal: RepositoryFixProposalResponse | undefined,
  repositoryId: string,
  findingId: string,
): asserts proposal is RepositoryFixProposalResponse {
  if (!proposal || typeof proposal !== 'object') {
    throw new FixApplicationError('A proposal is required.', 'PROPOSAL_INVALID');
  }
  if (proposal.status !== 'PROPOSED') {
    throw new FixApplicationError('Only a proposal with status PROPOSED can be applied.', 'PROPOSAL_INVALID');
  }
  if (proposal.repositoryId !== repositoryId || proposal.findingId !== findingId) {
    throw new FixApplicationError('The proposal does not match this repository/finding.', 'PROPOSAL_INVALID');
  }
  if (typeof proposal.commitSha !== 'string' || !proposal.commitSha) {
    throw new FixApplicationError('The proposal is missing a commitSha.', 'PROPOSAL_INVALID');
  }
  if (!Array.isArray(proposal.changes) || proposal.changes.length === 0) {
    throw new FixApplicationError('The proposal reports no file changes to apply.', 'PROPOSAL_INVALID');
  }
  for (const change of proposal.changes) {
    if (typeof change.filePath !== 'string' || !change.filePath.trim()) {
      throw new FixApplicationError('A proposed file change is missing a filePath.', 'PROPOSAL_INVALID');
    }
    if (!Array.isArray(change.hunks) || change.hunks.length === 0) {
      throw new FixApplicationError(`Path "${change.filePath}" has no proposed hunks.`, 'PROPOSAL_INVALID');
    }
    for (const hunk of change.hunks) {
      if (typeof hunk.oldText !== 'string' || !hunk.oldText || typeof hunk.newText !== 'string') {
        throw new FixApplicationError(`Path "${change.filePath}" has a hunk missing oldText/newText.`, 'PROPOSAL_INVALID');
      }
      if (hunk.oldText === hunk.newText) {
        throw new FixApplicationError(`Path "${change.filePath}" has a hunk with no effective change (oldText === newText).`, 'PROPOSAL_INVALID');
      }
    }
  }
}

/**
 * Orchestrates the safe apply pipeline described in the Phase 11 spec:
 * validate ownership/readiness/proposal -> validate every path via the
 * existing repository-path-safety utility, reject sensitive files, confirm
 * every file is indexed -> verify the clone hasn't moved past the proposal's
 * commit -> copy it into an isolated workspace (never the original clone)
 * -> locate + apply each hunk by REAL file content, never the AI's reported
 * line numbers -> Tree-sitter syntax-validate every changed supported file
 * -> generate a real `git diff` -> discard the workspace. Any failure at any
 * step discards the workspace (if created) and throws before anything is
 * returned — never a partially-applied "success".
 */
export async function applyFindingFix(
  repository: { id: string; ownerId?: string; userId?: string; organizationId?: string; status: string } | undefined,
  finding: Issue | undefined,
  proposal: RepositoryFixProposalResponse | undefined,
  stores: FixApplicationStores,
  params: FixApplicationParams,
  signal?: AbortSignal,
  options: FixApplicationOptions = {},
): Promise<FixApplicationResult> {
  if (!repository) {
    throw new FixApplicationError('Repository not found.', 'REPOSITORY_NOT_FOUND');
  }
  if (!canAccessRepository(repository.organizationId, params.ownerId)) {
    throw new FixApplicationError('Repository not found.', 'REPOSITORY_ACCESS_DENIED');
  }
  if (NOT_YET_INDEXED_STATUSES.has(repository.status)) {
    throw new FixApplicationError('Repository must be indexed before a fix can be applied.', 'REPOSITORY_NOT_READY');
  }
  if (!finding) {
    throw new FixApplicationError('Finding not found.', 'FINDING_NOT_FOUND');
  }

  validateProposalEnvelope(proposal, params.repositoryId, finding.id);
  assertNotAborted(signal);

  const indexJob = await stores.indexStore.getLatestForCommitAsync(repository.id, proposal.commitSha);
  if (!indexJob) {
    throw new FixApplicationError('No index exists for the commit this proposal was generated against — the repository may have been re-indexed since.', 'STALE_REPOSITORY');
  }

  const indexedFiles = await stores.indexStore.getFilesForJobAsync(indexJob.jobId);
  const filesByPath = new Map(indexedFiles.map((f) => [f.filePath, f]));

  const normalizedChanges: Array<{ filePath: string; indexedFile: InsertIndexFileInput; hunks: { oldText: string; newText: string }[] }> = [];
  for (const change of proposal.changes) {
    const filePath = normalizeRepositoryPath(change.filePath);
    if (!isRepositoryPathSafe(filePath)) {
      throw new FixApplicationError(`Path "${filePath}" is not a safe relative path.`, 'UNSAFE_PATH');
    }
    if (isSensitiveFile(filePath)) {
      throw new FixApplicationError(`Path "${filePath}" refers to a sensitive file and cannot be modified.`, 'SENSITIVE_FILE');
    }
    const indexedFile = filesByPath.get(filePath);
    if (!indexedFile || indexedFile.status !== 'INDEXED') {
      throw new FixApplicationError(`Path "${filePath}" was not found in the indexed repository.`, 'FILE_NOT_FOUND');
    }
    normalizedChanges.push({ filePath, indexedFile, hunks: change.hunks.map((h) => ({ oldText: h.oldText, newText: h.newText })) });
  }

  const cloneDir = resolveCloneDir(repository.id, indexJob.cloneJobId);
  if (!isPathInside(REPOSITORY_CLONE_ROOT, cloneDir)) {
    throw new FixApplicationError('Repository clone path is not within the configured repository root.', 'WORKSPACE_CREATION_FAILED');
  }

  assertNotAborted(signal);

  const applicationId = options.applicationId ?? randomUUID();
  const workspace = await (async () => {
    try {
      return await createFixWorkspace({
        repositoryId: repository.id,
        applicationId,
        cloneDir,
        expectedCommitSha: proposal.commitSha,
        signal,
      });
    } catch (error) {
      if (error instanceof StaleRepositoryError) throw new FixApplicationError(error.message, 'STALE_REPOSITORY');
      if (error instanceof FixWorkspaceCreationError) throw new FixApplicationError(error.message, 'WORKSPACE_CREATION_FAILED');
      throw new FixApplicationError('Failed to create isolated fix workspace.', 'WORKSPACE_CREATION_FAILED');
    }
  })();

  try {
    const lineGrounding: RepositoryFixLineGrounding[] = [];
    const changedFilePaths: string[] = [];

    for (const change of normalizedChanges) {
      assertNotAborted(signal);
      const absolutePath = path.join(workspace.workspaceDir, change.filePath);

      let content: string;
      try {
        content = fs.readFileSync(absolutePath, 'utf-8');
      } catch {
        throw new FixApplicationError(`Path "${change.filePath}" could not be read from the isolated workspace.`, 'FILE_NOT_FOUND');
      }

      for (const hunk of change.hunks) {
        // Reported line numbers are the AI's claim, sourced from the
        // proposal's own hunk metadata — recorded for comparison, but never
        // used to locate anything. The reported values are only available
        // via the original proposal.changes entries, matched by filePath —
        // find the matching hunk to read them (structurally identical
        // array, already validated 1:1 above).
        const reported = proposal.changes.find((c) => normalizeRepositoryPath(c.filePath) === change.filePath)?.hunks.find((h) => h.oldText === hunk.oldText && h.newText === hunk.newText);

        const applied = applyHunkToContent(content, hunk);
        if (!applied.ok) {
          throw new FixApplicationError(
            applied.reason === 'ambiguous'
              ? `Path "${change.filePath}" has a hunk whose oldText matches more than one location in the real file — refusing to guess which one.`
              : `Path "${change.filePath}" has a hunk whose oldText was not found in the real file content.`,
            applied.reason === 'ambiguous' ? 'OLD_TEXT_AMBIGUOUS' : 'OLD_TEXT_NOT_FOUND',
          );
        }

        content = applied.content;
        lineGrounding.push({
          filePath: change.filePath,
          reportedStartLine: reported?.startLine ?? applied.actualStartLine,
          reportedEndLine: reported?.endLine ?? applied.actualEndLine,
          actualStartLine: applied.actualStartLine,
          actualEndLine: applied.actualEndLine,
          matchedExactly: reported ? reported.startLine === applied.actualStartLine && reported.endLine === applied.actualEndLine : true,
        });
      }

      fs.writeFileSync(absolutePath, content, 'utf-8');
      changedFilePaths.push(change.filePath);
    }

    assertNotAborted(signal);

    let overallSyntax: 'VALID' | 'UNSUPPORTED' = 'VALID';
    const syntaxByPath = new Map<string, 'VALID' | 'INVALID' | 'UNSUPPORTED'>();
    let sawSupported = false;
    for (const change of normalizedChanges) {
      const absolutePath = path.join(workspace.workspaceDir, change.filePath);
      const content = fs.readFileSync(absolutePath, 'utf-8');
      const status = await validateSyntax(change.indexedFile.language, content);
      syntaxByPath.set(change.filePath, status);
      if (status === 'INVALID') {
        throw new FixApplicationError(`Path "${change.filePath}" is not syntactically valid after applying the proposed change.`, 'SYNTAX_VALIDATION_FAILED');
      }
      if (status === 'VALID') sawSupported = true;
    }
    if (!sawSupported) overallSyntax = 'UNSUPPORTED';

    assertNotAborted(signal);

    let diffResult;
    try {
      diffResult = await getWorkingTreeDiff(workspace.workspaceDir, signal);
    } catch (error) {
      throw new FixApplicationError(`Failed to generate a git diff of the applied changes: ${error instanceof Error ? error.message : String(error)}`, 'GIT_DIFF_FAILED');
    }

    if (diffResult.files.length === 0 || diffResult.diff.trim().length === 0) {
      throw new FixApplicationError('Applying the proposal produced no effective changes.', 'PROPOSAL_INVALID');
    }

    const diffStatsByPath = new Map(diffResult.files.map((f) => [f.filePath, f]));
    const changedFiles: RepositoryFixChangedFile[] = changedFilePaths.map((filePath) => {
      const stats = diffStatsByPath.get(filePath);
      return {
        filePath,
        additions: stats?.additions ?? 0,
        deletions: stats?.deletions ?? 0,
        syntaxStatus: syntaxByPath.get(filePath) ?? 'UNSUPPORTED',
      };
    });

    const result: FixApplicationResult = {
      status: 'READY_FOR_REVIEW',
      repositoryId: repository.id,
      findingId: finding.id,
      baseCommitSha: proposal.commitSha,
      changedFiles,
      diff: diffResult.diff,
      validation: { proposal: 'VALID', pathSafety: 'VALID', grounding: 'VALID', syntax: overallSyntax },
      lineGrounding,
      applicationId,
      workspaceDir: workspace.workspaceDir,
    };
    // Only the SUCCESS path ever conditionally retains the workspace — any
    // error below (and every error above, which already happened before
    // this try block or inside it) always falls into the catch clause and
    // discards unconditionally, regardless of `options.retain`. A failed
    // application has nothing worth reviewing/retaining.
    if (!options.retain) discardFixWorkspace(workspace.workspaceDir);
    return result;
  } catch (error) {
    discardFixWorkspace(workspace.workspaceDir);
    throw error;
  }
}
