import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Only zero/negative/non-finite/absurdly-small overrides are rejected —
 * mirrors component-generation-worker.ts's validatedTimeoutMs so a
 * misconfigured env var falls back to a safe default instead of silently
 * breaking every clone (e.g. a timeout of 0 would abort before git could
 * even start).
 */
export function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    console.error(JSON.stringify({ event: 'invalid_repository_config', name, providedValue: raw, minValue, fallback: defaultValue }));
    return defaultValue;
  }
  return parsed;
}

/** Wall-clock ceiling for the whole `git clone` invocation. Shallow clones (--depth 1) of typical public repos finish in seconds; 2 minutes comfortably covers a large repo on a slow connection without letting one hang indefinitely. */
export const REPOSITORY_CLONE_TIMEOUT_MS = envInt('REPOSITORY_CLONE_TIMEOUT_MS', 120_000);
/** Discovery stops and fails the job once the clone contains more files than this. */
export const REPOSITORY_MAX_FILE_COUNT = envInt('REPOSITORY_MAX_FILE_COUNT', 50_000);
/** Discovery stops and fails the job once the clone's total inspected size exceeds this. */
export const REPOSITORY_MAX_TOTAL_SIZE_BYTES = envInt('REPOSITORY_MAX_TOTAL_SIZE_BYTES', 500 * 1024 * 1024);
/** Any single file larger than this fails the job — guards against one huge file exhausting disk/inspection time even under the total-size and file-count limits. */
export const REPOSITORY_MAX_FILE_SIZE_BYTES = envInt('REPOSITORY_MAX_FILE_SIZE_BYTES', 25 * 1024 * 1024);
/** Root directory under which every clone gets its own `<repositoryId>/<jobId>` subdirectory. Defaults alongside this project's existing SCAN_DATA_DIR/.origami-data convention (see artifact-store.ts) rather than a separate storage root. */
export const REPOSITORY_CLONE_ROOT =
  process.env.REPOSITORY_CLONE_ROOT ?? path.join(process.env.SCAN_DATA_DIR ?? path.join(process.cwd(), '.origami-data'), 'repositories');

const UUID_LIKE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Builds the on-disk clone directory from trusted internal IDs only — never
 * from the repository URL, owner/repo name, or branch, all of which are
 * untrusted/attacker-influenced strings. Throws if either id doesn't look
 * like the internal identifier this project actually generates (a UUID),
 * which would indicate a caller bug, not a normal runtime condition.
 */
export function resolveCloneDir(repositoryId: string, jobId: string): string {
  if (!UUID_LIKE.test(repositoryId) || !UUID_LIKE.test(jobId)) {
    throw new Error('Invalid repository or job identifier for clone path');
  }
  return path.join(REPOSITORY_CLONE_ROOT, repositoryId, jobId);
}

/**
 * Removes every clone workspace ever created for a repository (all of its
 * job subdirectories at once) — called after the repository's own DB row is
 * deleted, so a deleted repository doesn't leave gigabytes of cloned source
 * on disk forever. Same trusted-internal-id-only validation as
 * resolveCloneDir; a no-op (never throws) if the repository was never
 * cloned.
 */
export function deleteRepositoryClones(repositoryId: string): void {
  if (!UUID_LIKE.test(repositoryId)) {
    throw new Error('Invalid repository identifier for clone path');
  }
  fs.rmSync(path.join(REPOSITORY_CLONE_ROOT, repositoryId), { recursive: true, force: true });
}

/**
 * True if `target` (after resolving `..`/symlinks) is `root` itself or
 * strictly inside it. Used both for discovery's symlink guard and as a
 * general defense-in-depth check anywhere a path derived from repository
 * contents is used. Path-prefix comparison alone is insufficient (e.g.
 * `/root-evil` incorrectly "starts with" `/root`) — comparing via `path.relative`
 * and rejecting any result starting with `..` (or `path.relative` returning an
 * absolute path, i.e. a different drive on Windows) avoids that.
 */
export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
