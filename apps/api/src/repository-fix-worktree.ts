import * as fs from 'node:fs';
import * as path from 'node:path';
import { envInt, isPathInside } from './repository-clone-service.js';
import { getCommitSha } from './repository-git.js';

/**
 * Root directory under which every isolated fix-application workspace gets
 * its own `<repositoryId>/<applicationId>` subdirectory — same convention as
 * REPOSITORY_CLONE_ROOT (repository-clone-service.ts), deliberately a
 * SEPARATE root so a fix workspace can never be mistaken for (or accidentally
 * resolve into) a real repository clone directory.
 */
export const REPOSITORY_FIX_WORKSPACE_ROOT =
  process.env.REPOSITORY_FIX_WORKSPACE_ROOT ?? path.join(process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data'), 'repository-fix-workspaces');

/**
 * How long a RETAINED workspace (Phase 12's review -> approve flow, via
 * applyFindingFix's `retain` option) stays approvable before it — and its
 * repository_fix_workflows row — expire. Phase 11's own stateless
 * `/fix-proposal/apply` never retains a workspace at all (see
 * discardFixWorkspace's doc comment), so this value is meaningless to that
 * endpoint; it only governs Phase 12's repository-fix-workflow-service.ts.
 */
export const REPOSITORY_FIX_WORKSPACE_TTL_MS = envInt('REPOSITORY_FIX_WORKSPACE_TTL_MS', 3_600_000);

const UUID_LIKE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Builds the on-disk workspace directory from trusted internal IDs only —
 * never from the repository URL, AI-generated content, or any other
 * untrusted string, mirroring resolveCloneDir's exact discipline.
 */
export function resolveFixWorkspaceDir(repositoryId: string, applicationId: string): string {
  if (!UUID_LIKE.test(repositoryId) || !UUID_LIKE.test(applicationId)) {
    throw new Error('Invalid repository or application identifier for fix workspace path');
  }
  return path.join(REPOSITORY_FIX_WORKSPACE_ROOT, repositoryId, applicationId);
}

export class StaleRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleRepositoryError';
  }
}

export class FixWorkspaceCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixWorkspaceCreationError';
  }
}

/**
 * Creates an isolated copy of the repository clone at `cloneDir`, verifying
 * first that the clone's CURRENT checked-out commit still matches
 * `expectedCommitSha` (the commit the proposal being applied was generated
 * against) — if the clone has moved on (re-cloned, re-indexed at a newer
 * commit), this throws StaleRepositoryError instead of ever applying a patch
 * against the wrong revision. The copy is a plain recursive filesystem copy
 * (including `.git`), so the workspace is itself a real, independent git
 * repository `git diff` can run against — nothing here ever mutates
 * `cloneDir` itself.
 */
export async function createFixWorkspace(params: {
  repositoryId: string;
  applicationId: string;
  cloneDir: string;
  expectedCommitSha: string;
  signal?: AbortSignal;
}): Promise<{ workspaceDir: string; createdAt: string; expiresAt: string }> {
  if (!fs.existsSync(params.cloneDir)) {
    throw new StaleRepositoryError('The repository clone is no longer available on disk.');
  }

  const currentSha = await getCommitSha(params.cloneDir, params.signal);
  if (currentSha !== params.expectedCommitSha) {
    throw new StaleRepositoryError(
      `The repository clone has moved to a different commit (expected ${params.expectedCommitSha}, found ${currentSha}) — refusing to apply a patch against a different revision.`,
    );
  }

  const workspaceDir = resolveFixWorkspaceDir(params.repositoryId, params.applicationId);
  if (!isPathInside(REPOSITORY_FIX_WORKSPACE_ROOT, workspaceDir)) {
    // Cannot happen given resolveFixWorkspaceDir's own construction — asserted anyway, same defense-in-depth as the index worker's clone-dir check.
    throw new FixWorkspaceCreationError('Fix workspace path is not within the configured workspace root.');
  }

  try {
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
    fs.cpSync(params.cloneDir, workspaceDir, { recursive: true, errorOnExist: false });
  } catch (error) {
    throw new FixWorkspaceCreationError(`Failed to create isolated fix workspace: ${error instanceof Error ? error.message : String(error)}`);
  }

  const createdAt = new Date();
  return {
    workspaceDir,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + REPOSITORY_FIX_WORKSPACE_TTL_MS).toISOString(),
  };
}

/**
 * Deterministically removes an isolated fix workspace. Called unconditionally
 * (success or failure) after every apply attempt — this phase never retains
 * a workspace on disk once its diff has been computed and returned, so no
 * expiry sweep/background job is needed: there is nothing left to sweep.
 * Swallows filesystem errors (best-effort cleanup must never mask the real
 * apply result/error).
 */
export function discardFixWorkspace(workspaceDir: string): void {
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch (error) {
    console.error(JSON.stringify({ event: 'repository_fix_workspace_discard_failed', workspaceDir, error: error instanceof Error ? error.message : String(error) }));
  }
}
