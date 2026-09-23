/**
 * Shared repository-relative path safety utilities — used everywhere a
 * user- or AI-supplied file path must be validated before being referenced
 * (issue creation, fix-proposal diff validation, finding-fix hunk
 * validation). Previously duplicated privately in repository-issue-service.ts
 * and repository-fix-service.ts (Phase 8); extracted here for Phase 10
 * rather than adding a third private copy, since this is a security-
 * critical check where accidental divergence between copies is a real risk
 * — unlike this project's other small, genuinely inert per-file helpers
 * (e.g. envInt) that stay intentionally duplicated.
 */

const ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export function normalizeRepositoryPath(rawPath: string): string {
  return rawPath.trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

/**
 * Rejects: empty paths, null bytes, absolute POSIX paths, `~` home-relative
 * paths, Windows drive-letter absolute paths, and any `..`/`.` path
 * segment (traversal). Never resolves the path against a real filesystem —
 * this is a pure string check, matching every other repository-path check
 * in this project (the actual file's existence is validated separately,
 * against indexed metadata, never the filesystem directly).
 */
export function isRepositoryPathSafe(filePath: string): boolean {
  if (!filePath) return false;
  if (filePath.includes('\0')) return false;
  if (filePath.startsWith('/') || filePath.startsWith('~') || ABSOLUTE_PATH_PATTERN.test(filePath)) return false;
  const segments = filePath.split(/[\\/]/);
  return !segments.some((segment) => segment === '..' || segment === '.');
}
